#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { hash, resolveUsername, sendEvents } from "./lib.mjs";

const DEFAULT_LOOKBACK_MINUTES = 7 * 24 * 60;
const DEFAULT_STATE_PATH = join(homedir(), ".cultivagent", "codex-session-collector-state.json");
const MAX_STATE_IDS = 50000;

export function collectSessionEvents(root, options = {}) {
  const now = options.now ?? Date.now();
  const lookbackMs = Number(options.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES) * 60 * 1000;
  const cutoffMs = Number.isFinite(lookbackMs) && lookbackMs > 0 ? now - lookbackMs : 0;
  const files = findJsonlFiles(root, cutoffMs);
  return files.flatMap((file) => collectSessionEventsFromFile(file, options));
}

export function collectSessionEventsFromFile(file, options = {}) {
  const machineName = options.machineName ?? hostname();
  const username = options.username ?? resolveUsername(machineName);
  const session = {
    id: "unknown",
    cwd: process.cwd(),
    source: "unknown",
    provider: "openai",
    cliVersion: "",
  };
  let turn = {
    id: "",
    model: "unknown",
    cwd: "",
  };
  let previousTotalUsage = null;
  let eventIndex = 0;
  const pending = new Map();
  const lines = readFileSync(file, "utf8").split(/\n/);

  for (const line of lines) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = item.payload ?? {};
    if (item.type === "session_meta") {
      session.id = clean(payload.session_id ?? payload.id ?? session.id);
      session.cwd = clean(payload.cwd ?? session.cwd);
      session.source = clean(payload.source ?? payload.originator ?? session.source);
      session.provider = clean(payload.model_provider ?? payload.provider ?? session.provider);
      session.cliVersion = clean(payload.cli_version ?? session.cliVersion);
      continue;
    }
    if (item.type === "turn_context") {
      turn = {
        id: clean(payload.turn_id ?? turn.id),
        model: clean(payload.model ?? turn.model),
        cwd: clean(payload.cwd ?? session.cwd ?? turn.cwd),
      };
      previousTotalUsage = null;
      eventIndex = 0;
      continue;
    }
    if (item.type !== "event_msg") continue;

    if (payload.type === "token_count") {
      const parsed = usageFromTokenCount(payload, previousTotalUsage);
      if (parsed.total) previousTotalUsage = parsed.total;
      const usage = parsed.usage;
      if (!hasUsage(usage)) continue;
      eventIndex += 1;
      const turnKey = turn.id ? `${turn.id}:${eventIndex}` : `event:${eventIndex}`;
      const event = {
        event_id: stableEventId(session.id, turnKey, item.timestamp, usage),
        source_agent: "codex",
        source_surface: "session_collector",
        event_type: "model_response",
        occurred_at: validIso(item.timestamp) ?? new Date().toISOString(),
        username,
        host_id: hash(machineName),
        workspace_id: hash(turn.cwd || session.cwd || process.cwd()),
        session_id: session.id,
        turn_id: turn.id,
        provider: session.provider || "openai",
        model: turn.model || "unknown",
        status: "ok",
        usage,
        meta: {
          machine_name: machineName,
          username,
          collector: "codex-session-jsonl",
          codex_source: session.source,
          codex_cli_version: session.cliVersion,
          task_complete: false,
          reasoning_output_tokens: numberFrom(payload.info?.last_token_usage?.reasoning_output_tokens),
        },
      };
      pending.set(turnKey, event);
      continue;
    }

    if (payload.type === "task_complete") {
      const key = clean(payload.turn_id ?? turn.id);
      for (const [pendingKey, event] of pending) {
        if (key && !pendingKey.startsWith(`${key}:`)) continue;
        const durationMs = numberFrom(payload.duration_ms);
        if (durationMs != null) event.duration_ms = durationMs;
        const firstTokenMs = numberFrom(payload.time_to_first_token_ms);
        if (firstTokenMs != null) event.meta.time_to_first_token_ms = firstTokenMs;
        event.meta.task_complete = true;
      }
    }
  }

  const events = [...pending.values()];
  return options.includeIncomplete ? events : events.filter((event) => event.meta.task_complete);
}

export async function runSessionCollector(args = {}) {
  const delayMs = Number(args.delayMs ?? 0);
  if (Number.isFinite(delayMs) && delayMs > 0) await sleep(delayMs);
  const root = args.root ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  const statePath = args.state ?? DEFAULT_STATE_PATH;
  const state = loadState(statePath);
  const seen = new Set(Array.isArray(state.sent) ? state.sent : []);
  const events = collectSessionEvents(root, {
    lookbackMinutes: args.lookbackMinutes,
    includeIncomplete: args.includeIncomplete,
  }).filter((event) => !seen.has(event.event_id));
  let sent = 0;
  let failed = 0;

  for (const batch of chunks(events, Number(args.batchSize ?? 100))) {
    if (!args.dryRun) {
      try {
        await sendEvents(batch);
      } catch (error) {
        failed += batch.length;
        console.error(`[cultivagent] codex session collector failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    for (const event of batch) seen.add(event.event_id);
    sent += batch.length;
  }

  if (!args.dryRun) saveState(statePath, { sent: [...seen].slice(-MAX_STATE_IDS) });

  return { root, scanned_events: events.length, sent, failed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runSessionCollector(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`codex session collector: sent ${result.sent}, failed ${result.failed}`);
  if (result.failed) process.exitCode = 1;
}

function findJsonlFiles(root, cutoffMs) {
  if (!existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const stats = statSync(full);
        if (!cutoffMs || stats.mtimeMs >= cutoffMs) files.push({ path: full, mtimeMs: stats.mtimeMs });
      }
    }
  }
  return files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path)).map((file) => file.path);
}

function usageFromTokenCount(payload, previousTotalUsage = null) {
  const info = payload.info ?? {};
  const raw = info.last_token_usage ?? info.total_token_usage ?? {};
  const total = parseTokenUsage(info.total_token_usage);
  const current = parseTokenUsage(raw);
  const delta = info.total_token_usage && !info.last_token_usage
    ? subtractTokenUsage(current, previousTotalUsage)
    : current;
  const inputTotal = delta.input;
  const cacheRead = Math.min(delta.cacheRead, inputTotal);
  const cacheWrite = Math.min(delta.cacheWrite, Math.max(0, inputTotal - cacheRead));
  const output = delta.output;
  const input = Math.max(0, inputTotal - cacheRead - cacheWrite);
  return {
    total,
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      total_tokens: input + output + cacheRead + cacheWrite,
    },
  };
}

function parseTokenUsage(usage = {}) {
  return {
    input: numberFrom(usage?.input_tokens) ?? 0,
    cacheRead: numberFrom(usage?.cached_input_tokens ?? usage?.cache_read_tokens) ?? 0,
    cacheWrite: numberFrom(usage?.cache_creation_input_tokens ?? usage?.cache_write_tokens) ?? 0,
    output: numberFrom(usage?.output_tokens) ?? 0,
  };
}

function subtractTokenUsage(current, previous) {
  if (!previous) return current;
  return {
    input: Math.max(0, current.input - previous.input),
    cacheRead: Math.max(0, current.cacheRead - previous.cacheRead),
    cacheWrite: Math.max(0, current.cacheWrite - previous.cacheWrite),
    output: Math.max(0, current.output - previous.output),
  };
}

function parseArgs(argv) {
  const args = { dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") args.root = argv[++i];
    else if (arg === "--state") args.state = argv[++i];
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++i]);
    else if (arg === "--lookback-minutes") args.lookbackMinutes = Number(argv[++i]);
    else if (arg === "--include-incomplete") args.includeIncomplete = true;
    else if (arg === "--batch-size") args.batchSize = Number(argv[++i]);
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "-h" || arg === "--help") {
      console.log("Usage: session-collector.mjs [--root DIR] [--state FILE] [--delay-ms N] [--lookback-minutes N] [--include-incomplete] [--batch-size N] [--dry-run] [--json]");
      process.exit(0);
    }
  }
  return args;
}

function loadState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2) + "\n");
  renameSync(tmp, path);
}

function chunks(items, size) {
  const chunkSize = Math.max(1, Number(size) || 100);
  const out = [];
  for (let i = 0; i < items.length; i += chunkSize) out.push(items.slice(i, i + chunkSize));
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableEventId(sessionId, turnId, timestamp, usage) {
  return `codex-session-${hash(JSON.stringify({ sessionId, turnId, timestamp, usage }))}`;
}

function hasUsage(usage) {
  return Boolean(usage.input_tokens || usage.output_tokens || usage.cache_read_tokens || usage.cache_write_tokens || usage.total_tokens);
}

function validIso(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function numberFrom(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clean(value) {
  return value == null ? "" : String(value);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
