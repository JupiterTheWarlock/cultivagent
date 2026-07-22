#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_LOOKBACK_MINUTES = 7 * 24 * 60;
const DEFAULT_STATE_PATH = join(homedir(), ".cultivagent", "locus-session-collector-state.json");
const MAX_STATE_IDS = 50000;
const SQLITE_BUSY_TIMEOUT_MS = 5000;

export function collectLocusEvents(dbPath = resolveLocusDbPath(), options = {}) {
  if (!existsSync(dbPath)) return [];
  const machineName = options.machineName ?? hostname();
  const username = options.username ?? resolveUsername(machineName);
  const now = options.now ?? Date.now();
  const lookbackMs = Number(options.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES) * 60 * 1000;
  const cutoffSec = Number.isFinite(lookbackMs) && lookbackMs > 0 ? Math.floor((now - lookbackMs) / 1000) : 0;
  const includeIncomplete = Boolean(options.includeIncomplete);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    try {
      db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    } catch {
      // Best effort only; the collector loop handles transient locks.
    }
    const statusFilter = includeIncomplete ? "" : "AND sr.status = 'done'";
    const rows = db.prepare(`
      SELECT e.session_id,
             e.run_id,
             e.seq,
             e.created_at,
             e.payload_json,
             s.workspace_id,
             s.agent_id,
             sr.status AS run_status,
             sr.started_at,
             sr.finished_at,
             (
               SELECT m.metadata_json
               FROM messages m
               WHERE m.session_id = e.session_id
                 AND m.role = 'assistant'
                 AND m.metadata_json IS NOT NULL
                 AND (sr.started_at IS NULL OR m.created_at >= sr.started_at)
                 AND (sr.finished_at IS NULL OR m.created_at <= sr.finished_at + 5)
               ORDER BY m.created_at DESC
               LIMIT 1
             ) AS metadata_json
      FROM session_events e
      LEFT JOIN session_runs sr ON sr.run_id = e.run_id
      LEFT JOIN sessions s ON s.id = e.session_id
      WHERE e.event_type = 'usageUpdate'
        AND e.created_at >= ?
        ${statusFilter}
      ORDER BY e.created_at, e.session_id, e.seq
    `).all(cutoffSec);
    return rows.flatMap((row) => {
      const event = eventFromRow(row, machineName, username);
      return event ? [event] : [];
    });
  } finally {
    db.close();
  }
}

export function resolveLocusDbPath(options = {}) {
  const explicit = options.db ?? process.env.LOCUS_DB;
  if (explicit) return explicit;
  if (options.dataDir ?? process.env.LOCUS_DATA_DIR) return join(options.dataDir ?? process.env.LOCUS_DATA_DIR, "locus.db");

  for (const file of storageOverrideFiles()) {
    const dir = readJson(file)?.path;
    if (dir) {
      const db = join(dir, "locus.db");
      if (existsSync(db)) return db;
    }
  }

  const candidates = defaultDbCandidates();
  return candidates.find(existsSync) ?? candidates[0] ?? join(homedir(), ".locus", "locus.db");
}

export async function runSessionCollector(args = {}) {
  const dbPath = resolveLocusDbPath(args);
  const statePath = args.state ?? DEFAULT_STATE_PATH;
  const state = loadState(statePath);
  const seen = new Set(Array.isArray(state.sent) ? state.sent : []);
  let events;
  try {
    events = collectLocusEvents(dbPath, {
      lookbackMinutes: args.lookbackMinutes,
      includeIncomplete: args.includeIncomplete,
    }).filter((event) => !seen.has(event.event_id));
  } catch (error) {
    if (isSqliteLocked(error)) {
      return { db: dbPath, scanned_events: 0, sent: 0, failed: 0, warning: "database_locked" };
    }
    throw error;
  }
  let sent = 0;
  let failed = 0;

  for (const batch of chunks(events, Number(args.batchSize ?? 100))) {
    if (!args.dryRun) {
      try {
        await sendEvents(batch);
      } catch (error) {
        failed += batch.length;
        console.error(`[cultivagent] locus session collector failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    for (const event of batch) seen.add(event.event_id);
    sent += batch.length;
  }

  if (!args.dryRun) saveState(statePath, { sent: [...seen].slice(-MAX_STATE_IDS) });
  return { db: dbPath, scanned_events: events.length, sent, failed };
}

function eventFromRow(row, machineName, username) {
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return null;
  }
  const input = numberFrom(payload.inputTokens) ?? 0;
  const output = numberFrom(payload.outputTokens) ?? 0;
  const cacheRead = numberFrom(payload.cacheReadTokens) ?? 0;
  const cacheWrite = numberFrom(payload.cacheWriteTokens) ?? 0;
  if (!input && !output && !cacheRead && !cacheWrite) return null;

  const responseRequest = readJsonText(row.metadata_json)?.responseRequest ?? {};
  const model = clean(responseRequest.model) || "unknown";
  const provider = clean(responseRequest.provider) || "locus";
  const occurredAt = new Date((numberFrom(row.created_at) ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();

  return {
    event_id: `locus-session-${hash(`${row.session_id}:${row.seq}`)}`,
    source_agent: "locus",
    source_surface: "session_collector",
    event_type: "model_response",
    occurred_at: occurredAt,
    username,
    host_id: hash(machineName),
    workspace_id: clean(row.workspace_id) || hash("locus"),
    session_id: clean(row.session_id) || "unknown",
    turn_id: clean(row.run_id),
    agent_id: clean(row.agent_id),
    provider,
    model,
    status: row.run_status === "error" ? "error" : "ok",
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      total_tokens: input + output + cacheRead + cacheWrite,
    },
    meta: {
      machine_name: machineName,
      username,
      collector: "locus-sqlite",
      locus_run_id: clean(row.run_id),
      locus_seq: numberFrom(row.seq) ?? 0,
      locus_run_status: clean(row.run_status),
      context_tokens: numberFrom(payload.contextTokens) ?? 0,
      context_limit: numberFrom(payload.contextLimit) ?? 0,
      total_input_tokens: numberFrom(payload.totalInputTokens) ?? 0,
      total_output_tokens: numberFrom(payload.totalOutputTokens) ?? 0,
      total_cache_read_tokens: numberFrom(payload.totalCacheReadTokens) ?? 0,
      total_cache_write_tokens: numberFrom(payload.totalCacheWriteTokens) ?? 0,
      total_cost_usd: numberFrom(payload.totalCostUsd) ?? 0,
      priced_rounds: numberFrom(payload.pricedRounds) ?? 0,
    },
  };
}

function isSqliteLocked(error) {
  const text = [
    error?.code,
    error?.errcode,
    error?.errstr,
    error instanceof Error ? error.message : String(error ?? ""),
  ].join(" ").toLowerCase();
  return text.includes("database is locked") || text.includes("sqlite_busy") || text.includes("errcode 5");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runSessionCollector(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`locus session collector: sent ${result.sent}, failed ${result.failed}`);
  if (result.failed) process.exitCode = 1;
}

function storageOverrideFiles() {
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return [
      join(roaming, "locus", "storage_dir_override.json"),
      join(roaming, "com.locus.app", "storage_dir_override.json"),
    ];
  }
  if (process.platform === "darwin") {
    return [
      join(homedir(), "Library", "Application Support", "locus", "storage_dir_override.json"),
      join(homedir(), "Library", "Application Support", "com.locus.app", "storage_dir_override.json"),
    ];
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return [
    join(configHome, "locus", "storage_dir_override.json"),
    join(configHome, "com.locus.app", "storage_dir_override.json"),
  ];
}

function defaultDbCandidates() {
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return [
      join(roaming, "locus", "locus.db"),
      join(roaming, "com.locus.app", "locus.db"),
      join(local, "com.locus.app", "locus.db"),
      join(local, "locus", "locus.db"),
    ];
  }
  if (process.platform === "darwin") {
    return [
      join(homedir(), "Library", "Application Support", "locus", "locus.db"),
      join(homedir(), "Library", "Application Support", "com.locus.app", "locus.db"),
    ];
  }
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return [
    join(dataHome, "locus", "locus.db"),
    join(dataHome, "com.locus.app", "locus.db"),
  ];
}

function loadConfig() {
  return readJson(join(homedir(), ".cultivagent", "config.json")) ?? {};
}

async function sendEvents(events) {
  const cfg = loadConfig();
  let endpoint = process.env.CULTIVAGENT_ENDPOINT ?? cfg.endpoint ?? "http://127.0.0.1:3737";
  endpoint = endpoint.replace(/\/$/, "");
  if (!endpoint.endsWith("/ingest")) endpoint += "/ingest";
  const token = process.env.CULTIVAGENT_TOKEN ?? cfg.token ?? "";
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(events.length === 1 ? events[0] : events) });
  if (!response.ok) throw new Error(`ingest failed: ${response.status} ${await response.text()}`);
}

function parseArgs(argv) {
  const args = { dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") args.db = argv[++i];
    else if (arg === "--data-dir") args.dataDir = argv[++i];
    else if (arg === "--state") args.state = argv[++i];
    else if (arg === "--lookback-minutes") args.lookbackMinutes = Number(argv[++i]);
    else if (arg === "--include-incomplete") args.includeIncomplete = true;
    else if (arg === "--batch-size") args.batchSize = Number(argv[++i]);
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "-h" || arg === "--help") {
      console.log("Usage: session-collector.mjs [--db FILE|--data-dir DIR] [--state FILE] [--lookback-minutes N] [--include-incomplete] [--batch-size N] [--dry-run] [--json]");
      process.exit(0);
    }
  }
  return args;
}

function loadState(path) {
  return readJson(path) ?? {};
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

function resolveUsername(machineName) {
  return process.env.CULTIVAGENT_USERNAME ?? loadConfig().username ?? machineName;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readJsonText(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function hash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 16);
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
