#!/usr/bin/env node
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const DEFAULT_DB = join(opencodeDataDir(), "opencode.db");
const DEFAULT_STATE_PATH = join(homedir(), ".cultivagent", "opencode-session-collector-state.json");
const MAX_STATE_IDS = 50000;

export function collectOpenCodeEvents(dbPath = DEFAULT_DB, options = {}) {
  if (!existsSync(dbPath)) return [];
  const machineName = options.machineName ?? hostname();
  const username = options.username ?? resolveUsername(machineName);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sessions = db.prepare(`
      SELECT s.id AS session_id,
             MAX(s.time_updated, COALESCE(MAX(m.time_updated), s.time_updated)) AS sync_watermark
      FROM session s
      LEFT JOIN message m ON m.session_id = s.id
      GROUP BY s.id
      ORDER BY sync_watermark
    `).all();
    return sessions.flatMap((session) => collectSessionMessages(db, session.session_id, machineName, username));
  } finally {
    db.close();
  }
}

function collectSessionMessages(db, sessionId, machineName, username) {
  const rows = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created").all(sessionId);
  const out = [];
  for (const row of rows) {
    let value;
    try {
      value = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (value.role !== "assistant" || !value.tokens || !value.time?.completed) continue;
    const parsed = parseMessageData(value);
    if (!parsed) continue;
    out.push({
      event_id: `opencode-session-${sessionId}-${row.id}`,
      source_agent: "opencode",
      source_surface: "session_collector",
      event_type: "model_response",
      occurred_at: new Date(parsed.timestampMs || Date.now()).toISOString(),
      username,
      host_id: hash(machineName),
      workspace_id: hash(sessionId),
      session_id: sessionId,
      turn_id: row.id,
      provider: value.providerID ?? value.providerId ?? "unknown",
      model: parsed.model,
      status: "ok",
      usage: parsed.usage,
      meta: {
        machine_name: machineName,
        username,
        collector: "opencode-sqlite",
        opencode_cost_usd: parsed.cost || null,
      },
    });
  }
  return out;
}

export function parseMessageData(value) {
  const tokens = value.tokens ?? {};
  const cache = tokens.cache ?? {};
  const input = numberFrom(tokens.input) ?? 0;
  const output = (numberFrom(tokens.output) ?? 0) + (numberFrom(tokens.reasoning) ?? 0);
  const cacheRead = numberFrom(cache.read) ?? 0;
  const cacheWrite = numberFrom(cache.write) ?? 0;
  if (!input && !output && !cacheRead && !cacheWrite) return null;
  return {
    model: String(value.modelID ?? value.modelId ?? "unknown"),
    cost: numberFrom(value.cost) ?? 0,
    timestampMs: numberFrom(value.time?.created) ?? 0,
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      total_tokens: input + output + cacheRead + cacheWrite,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.db ?? DEFAULT_DB;
  const statePath = args.state ?? DEFAULT_STATE_PATH;
  const state = loadState(statePath);
  const seen = new Set(Array.isArray(state.sent) ? state.sent : []);
  const events = collectOpenCodeEvents(dbPath).filter((event) => !seen.has(event.event_id));
  let sent = 0;
  let failed = 0;

  for (const event of events) {
    if (!args.dryRun) {
      try {
        await sendEvent(event);
      } catch (error) {
        failed += 1;
        console.error(`[cultivagent] opencode session collector failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    seen.add(event.event_id);
    sent += 1;
  }

  if (!args.dryRun) saveState(statePath, { sent: [...seen].slice(-MAX_STATE_IDS) });
  const result = { db: dbPath, scanned_events: events.length, sent, failed };
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`opencode session collector: sent ${sent}, failed ${failed}`);
  if (failed) process.exitCode = 1;
}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".cultivagent", "config.json"), "utf8"));
  } catch {
    return {};
  }
}

async function sendEvent(event) {
  const cfg = loadConfig();
  let endpoint = process.env.CULTIVAGENT_ENDPOINT ?? cfg.endpoint ?? "http://127.0.0.1:3737";
  endpoint = endpoint.replace(/\/$/, "");
  if (!endpoint.endsWith("/ingest")) endpoint += "/ingest";
  const token = process.env.CULTIVAGENT_TOKEN ?? cfg.token ?? "";
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(event) });
  if (!response.ok) throw new Error(`ingest failed: ${response.status}`);
}

function parseArgs(argv) {
  const args = { dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") args.db = argv[++i];
    else if (arg === "--state") args.state = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "-h" || arg === "--help") {
      console.log("Usage: session-collector.mjs [--db FILE] [--state FILE] [--dry-run] [--json]");
      process.exit(0);
    }
  }
  return args;
}

function opencodeDataDir() {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "opencode");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "opencode");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode");
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

function resolveUsername(machineName) {
  return process.env.CULTIVAGENT_USERNAME ?? loadConfig().username ?? machineName;
}

function hash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 16);
}

function numberFrom(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
