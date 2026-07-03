#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { hash, resolveUsername, sendEvents } from "./lib.mjs";

const DEFAULT_LOOKBACK_MINUTES = 7 * 24 * 60;
const DEFAULT_STATE_PATH = join(homedir(), ".cultivagent", "claude-session-collector-state.json");
const MAX_STATE_IDS = 50000;

export function collectClaudeSessionEvents(root, options = {}) {
  const now = options.now ?? Date.now();
  const lookbackMs = Number(options.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES) * 60 * 1000;
  const cutoffMs = Number.isFinite(lookbackMs) && lookbackMs > 0 ? now - lookbackMs : 0;
  return findClaudeJsonlFiles(root, cutoffMs).flatMap((file) => collectClaudeSessionEventsFromFile(file, options));
}

export function collectClaudeSessionEventsFromFile(file, options = {}) {
  const machineName = options.machineName ?? hostname();
  const username = options.username ?? resolveUsername(machineName);
  const cwd = projectFromPath(file);
  const messages = new Map();
  let sessionId = "unknown";

  for (const line of readFileSync(file, "utf8").split(/\n/)) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    sessionId = clean(item.sessionId ?? item.session_id ?? sessionId);
    if (item.type !== "assistant") continue;
    const message = item.message ?? {};
    const messageId = clean(message.id);
    if (!messageId) continue;
    const usage = usageFromClaude(message.usage);
    if (!hasUsage(usage)) continue;
    const next = {
      event_id: `claude-session-${messageId}`,
      source_agent: "claude-code",
      source_surface: "session_collector",
      event_type: "model_response",
      occurred_at: validIso(item.timestamp) ?? new Date().toISOString(),
      username,
      host_id: hash(machineName),
      workspace_id: hash(cwd),
      session_id: sessionId,
      turn_id: messageId,
      provider: "anthropic",
      model: clean(message.model ?? "unknown"),
      status: "ok",
      usage,
      meta: {
        machine_name: machineName,
        username,
        collector: "claude-session-jsonl",
        stop_reason: message.stop_reason ?? null,
      },
    };
    const existing = messages.get(messageId);
    if (!existing || shouldReplace(existing, next)) messages.set(messageId, next);
  }

  return [...messages.values()];
}

function findClaudeJsonlFiles(projectsDir, cutoffMs) {
  if (!existsSync(projectsDir)) return [];
  const files = [];
  for (const project of safeReadDir(projectsDir)) {
    const projectPath = join(projectsDir, project.name);
    if (!project.isDirectory()) continue;
    pushJsonlChildren(projectPath, files, cutoffMs);
    for (const session of safeReadDir(projectPath)) {
      if (!session.isDirectory()) continue;
      const subagents = join(projectPath, session.name, "subagents");
      pushJsonlChildren(subagents, files, cutoffMs);
      const workflows = join(subagents, "workflows");
      for (const workflow of safeReadDir(workflows)) {
        if (workflow.isDirectory()) pushJsonlChildren(join(workflows, workflow.name), files, cutoffMs);
      }
    }
  }
  return files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path)).map((file) => file.path);
}

function pushJsonlChildren(dir, files, cutoffMs) {
  for (const entry of safeReadDir(dir)) {
    const full = join(dir, entry.name);
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const stats = statSync(full);
    if (!cutoffMs || stats.mtimeMs >= cutoffMs) files.push({ path: full, mtimeMs: stats.mtimeMs });
  }
}

function usageFromClaude(usage = {}) {
  return {
    input_tokens: numberFrom(usage.input_tokens) ?? 0,
    output_tokens: numberFrom(usage.output_tokens) ?? 0,
    cache_read_tokens: numberFrom(usage.cache_read_input_tokens ?? usage.cache_read_tokens) ?? 0,
    cache_write_tokens: numberFrom(usage.cache_creation_input_tokens ?? usage.cache_write_tokens) ?? 0,
  };
}

function shouldReplace(existing, next) {
  if (next.meta.stop_reason && !existing.meta.stop_reason) return true;
  if (Boolean(next.meta.stop_reason) === Boolean(existing.meta.stop_reason)) {
    return next.usage.output_tokens > existing.usage.output_tokens;
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ?? join(homedir(), ".claude", "projects");
  const statePath = args.state ?? DEFAULT_STATE_PATH;
  const state = loadState(statePath);
  const seen = new Set(Array.isArray(state.sent) ? state.sent : []);
  const events = collectClaudeSessionEvents(root, { lookbackMinutes: args.lookbackMinutes })
    .filter((event) => !seen.has(event.event_id));
  let sent = 0;
  let failed = 0;

  for (const batch of chunks(events, Number(args.batchSize ?? 100))) {
    if (!args.dryRun) {
      try {
        await sendEvents(batch);
      } catch (error) {
        failed += batch.length;
        console.error(`[cultivagent] claude session collector failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    for (const event of batch) seen.add(event.event_id);
    sent += batch.length;
  }

  if (!args.dryRun) saveState(statePath, { sent: [...seen].slice(-MAX_STATE_IDS) });
  const result = { root, scanned_events: events.length, sent, failed };
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`claude session collector: sent ${sent}, failed ${failed}`);
  if (failed) process.exitCode = 1;
}

function parseArgs(argv) {
  const args = { dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") args.root = argv[++i];
    else if (arg === "--state") args.state = argv[++i];
    else if (arg === "--lookback-minutes") args.lookbackMinutes = Number(argv[++i]);
    else if (arg === "--batch-size") args.batchSize = Number(argv[++i]);
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "-h" || arg === "--help") {
      console.log("Usage: session-collector.mjs [--root DIR] [--state FILE] [--lookback-minutes N] [--batch-size N] [--dry-run] [--json]");
      process.exit(0);
    }
  }
  return args;
}

function projectFromPath(file) {
  const normalized = String(file).replace(/\\/g, "/");
  const marker = "/projects/";
  const index = normalized.indexOf(marker);
  if (index < 0) return process.cwd();
  return normalized.slice(index + marker.length).split("/")[0] || process.cwd();
}

function safeReadDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function chunks(items, size) {
  const chunkSize = Math.max(1, Number(size) || 100);
  const out = [];
  for (let i = 0; i < items.length; i += chunkSize) out.push(items.slice(i, i + chunkSize));
  return out;
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

function hasUsage(usage) {
  return Boolean(usage.input_tokens || usage.output_tokens || usage.cache_read_tokens || usage.cache_write_tokens);
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
