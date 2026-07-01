import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      source_agent TEXT NOT NULL,
      source_surface TEXT NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      day TEXT NOT NULL,
      host_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms REAL,
      usage_json TEXT NOT NULL,
      meta_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_day_idx ON events(day);
    CREATE INDEX IF NOT EXISTS events_agent_idx ON events(source_agent, occurred_at);

    CREATE TABLE IF NOT EXISTS daily_usage (
      day TEXT NOT NULL,
      source_agent TEXT NOT NULL,
      host_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens REAL NOT NULL DEFAULT 0,
      output_tokens REAL NOT NULL DEFAULT 0,
      cache_read_tokens REAL NOT NULL DEFAULT 0,
      cache_write_tokens REAL NOT NULL DEFAULT 0,
      total_tokens REAL NOT NULL DEFAULT 0,
      cost_usd REAL,
      event_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(day, source_agent, host_id, workspace_id, model)
    );

    CREATE TABLE IF NOT EXISTS agent_state (
      agent_key TEXT PRIMARY KEY,
      source_agent TEXT NOT NULL,
      host_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      last_event_at TEXT NOT NULL,
      summary_json TEXT NOT NULL
    );
  `);
  return db;
}

export function insertEvent(db, event) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      event_id, schema_version, source_agent, source_surface, event_type,
      occurred_at, day, host_id, workspace_id, session_id, turn_id, agent_id,
      provider, model, status, duration_ms, usage_json, meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = insert.run(
    event.event_id,
    event.schema_version,
    event.source_agent,
    event.source_surface,
    event.event_type,
    event.occurred_at,
    event.day,
    event.host_id,
    event.workspace_id,
    event.session_id,
    event.turn_id,
    event.agent_id,
    event.provider,
    event.model,
    event.status,
    event.duration_ms,
    JSON.stringify(event.usage),
    JSON.stringify(event.meta),
  );
  if (result.changes === 0) return false;
  upsertDaily(db, event);
  upsertAgentState(db, event);
  return true;
}

export function listEvents(db, limit = 100) {
  const rows = db.prepare(`
    SELECT * FROM events ORDER BY occurred_at DESC LIMIT ?
  `).all(Math.max(1, Math.min(Number(limit) || 100, 1000)));
  return rows.map(rowToEvent);
}

export function listDaily(db, day = null) {
  const rows = day
    ? db.prepare(`SELECT * FROM daily_usage WHERE day = ? ORDER BY total_tokens DESC`).all(day)
    : db.prepare(`SELECT * FROM daily_usage ORDER BY day DESC, total_tokens DESC LIMIT 500`).all();
  return rows;
}

export function listAgents(db) {
  return db.prepare(`
    SELECT * FROM agent_state ORDER BY last_event_at DESC
  `).all().map((row) => ({
    ...row,
    summary: JSON.parse(row.summary_json),
  }));
}

export function resetDatabase(db) {
  db.exec("DELETE FROM events; DELETE FROM daily_usage; DELETE FROM agent_state;");
}

function upsertDaily(db, event) {
  const u = event.usage;
  db.prepare(`
    INSERT INTO daily_usage (
      day, source_agent, host_id, workspace_id, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      total_tokens, cost_usd, event_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(day, source_agent, host_id, workspace_id, model) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
      total_tokens = total_tokens + excluded.total_tokens,
      cost_usd = COALESCE(cost_usd, 0) + COALESCE(excluded.cost_usd, 0),
      event_count = event_count + 1
  `).run(
    event.day,
    event.source_agent,
    event.host_id,
    event.workspace_id,
    event.model,
    u.input_tokens,
    u.output_tokens,
    u.cache_read_tokens,
    u.cache_write_tokens,
    u.total_tokens,
    u.cost_usd,
  );
}

function upsertAgentState(db, event) {
  const key = [event.source_agent, event.host_id, event.workspace_id, event.session_id, event.agent_id].join(":");
  const summary = {
    event_type: event.event_type,
    model: event.model,
    provider: event.provider,
    usage: event.usage,
    meta: event.meta,
  };
  db.prepare(`
    INSERT INTO agent_state (
      agent_key, source_agent, host_id, workspace_id, session_id,
      status, last_event_at, summary_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_key) DO UPDATE SET
      status = excluded.status,
      last_event_at = excluded.last_event_at,
      summary_json = excluded.summary_json
  `).run(
    key,
    event.source_agent,
    event.host_id,
    event.workspace_id,
    event.session_id,
    event.status,
    event.occurred_at,
    JSON.stringify(summary),
  );
}

function rowToEvent(row) {
  return {
    ...row,
    usage: JSON.parse(row.usage_json),
    meta: JSON.parse(row.meta_json),
  };
}
