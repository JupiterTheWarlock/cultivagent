import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildDysonState } from "./dyson-state.mjs";

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
      username TEXT NOT NULL,
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
      provider TEXT NOT NULL DEFAULT 'unknown',
      input_tokens REAL NOT NULL DEFAULT 0,
      output_tokens REAL NOT NULL DEFAULT 0,
      cache_read_tokens REAL NOT NULL DEFAULT 0,
      cache_write_tokens REAL NOT NULL DEFAULT 0,
      total_tokens REAL NOT NULL DEFAULT 0,
      cost_usd REAL,
      error_count INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(day, source_agent, host_id, workspace_id, model, provider)
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
  migrateDatabase(db);
  return db;
}

export function insertEvent(db, event) {
  event = withCorrelatedUsername(db, event);
  if (shouldSkipSessionCollectorUsage(db, event)) return false;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      event_id, schema_version, source_agent, source_surface, event_type,
      occurred_at, day, username, host_id, workspace_id, session_id, turn_id, agent_id,
      provider, model, status, duration_ms, usage_json, meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = insert.run(
    event.event_id,
    event.schema_version,
    event.source_agent,
    event.source_surface,
    event.event_type,
    event.occurred_at,
    event.day,
    event.username || event.meta?.username || event.meta?.machine_name || event.host_id || "unknown",
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
  if (isUsageEvent(event)) upsertDaily(db, event);
  upsertAgentState(db, event);
  return true;
}

export function listEvents(db, options = 100) {
  const filters = typeof options === "object" && options !== null ? options : { limit: options };
  const conditions = [];
  const params = [];
  if (filters.start) {
    conditions.push("occurred_at >= ?");
    params.push(filters.start);
  }
  if (filters.end) {
    conditions.push("occurred_at <= ?");
    params.push(filters.end);
  }
  if (filters.since) {
    conditions.push("occurred_at > ?");
    params.push(filters.since);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const order = filters.order === "asc" ? "ASC" : "DESC";
  const columns = filters.compact
    ? `event_id, source_agent, source_surface, event_type, provider, model, status,
      duration_ms, occurred_at, username, host_id, workspace_id, session_id, usage_json`
    : "*";
  const rows = db.prepare(`
    SELECT ${columns} FROM events ${where} ORDER BY occurred_at ${order} LIMIT ?
  `).all(...params, clampLimit(filters.limit, 1000, 20000));
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

export function listDysonState(db, options = {}) {
  const day = options.day || new Date(Date.parse(options.start) || Date.now()).toISOString().slice(0, 10);
  const conditions = [];
  const params = [];
  if (options.start || options.end) {
    if (options.start) {
      conditions.push("occurred_at >= ?");
      params.push(options.start);
    }
    if (options.end) {
      conditions.push("occurred_at <= ?");
      params.push(options.end);
    }
  } else {
    conditions.push("day = ?");
    params.push(day);
  }
  const events = db.prepare(`SELECT * FROM events WHERE ${conditions.join(" AND ")} ORDER BY occurred_at ASC`).all(...params).map(rowToEvent);
  return buildDysonState(events, listAgents(db), { ...options, day });
}

export function listRequestStats(db, filters = {}) {
  const events = listFilteredEvents(db, filters);
  const limit = clampLimit(filters.limit, 100, 1000);
  return {
    summary: {
      total_requests: events.length,
      agents: unique(events.map((e) => e.source_agent)).length,
      users: unique(events.map(eventUsername)).length,
      machines: unique(events.map(eventMachine)).length,
      hook_types: unique(events.map((e) => e.event_type)).length,
    },
    requests: events.slice(0, limit).map((event) => ({
      event_id: event.event_id,
      agent: event.source_agent,
      time: event.occurred_at,
      username: eventUsername(event),
      machine: eventMachine(event),
      hook_type: event.event_type,
    })),
    by_agent: countBy(events, (event) => event.source_agent, "agent"),
    by_username: countBy(events, eventUsername, "username"),
    by_machine: countBy(events, eventMachine, "machine"),
    by_hook_type: countBy(events, (event) => event.event_type, "hook_type"),
    trend: requestTrend(events, filters),
  };
}

export function listUsageSummary(db, filters = {}) {
  const events = listUsageEvents(db, filters);
  return { summary: usageSummary(events) };
}

export function listUsageTrends(db, filters = {}) {
  return { trends: usageTrend(listUsageEvents(db, filters), filters) };
}

export function listUsageProviderStats(db, filters = {}) {
  const groups = groupBy(listUsageEvents(db, filters), usageProvider);
  return {
    providers: [...groups.entries()].map(([provider, events]) => {
      const summary = usageSummary(events);
      return {
        provider,
        request_count: summary.total_requests,
        total_tokens: summary.real_total_tokens,
        success_rate: summary.success_rate,
        avg_latency_ms: average(events.map((event) => event.duration_ms).filter((n) => n != null)),
      };
    }).sort((a, b) => b.total_tokens - a.total_tokens),
  };
}

export function listUsageModelStats(db, filters = {}) {
  const groups = groupBy(listUsageEvents(db, filters), (event) => event.model || "unknown");
  return {
    models: [...groups.entries()].map(([model, events]) => {
      const summary = usageSummary(events);
      return {
        model,
        request_count: summary.total_requests,
        total_tokens: summary.real_total_tokens,
      };
    }).sort((a, b) => b.total_tokens - a.total_tokens),
  };
}

export function listUsageLogs(db, filters = {}, page = 0, pageSize = 20) {
  const events = listUsageEvents(db, filters);
  const size = clampLimit(pageSize, 20, 100);
  const currentPage = Math.max(0, Number(page) || 0);
  const start = currentPage * size;
  return {
    logs: events.slice(start, start + size).map((event) => {
      const u = event.usage || {};
      return {
        event_id: event.event_id,
        time: event.occurred_at,
        agent: event.source_agent,
        username: eventUsername(event),
        provider: usageProvider(event),
        model: event.model || "unknown",
        input_tokens: Number(u.input_tokens || 0),
        output_tokens: Number(u.output_tokens || 0),
        cache_read_tokens: Number(u.cache_read_tokens || 0),
        cache_write_tokens: Number(u.cache_write_tokens || 0),
        total_tokens: usageTotal(event),
        latency_ms: event.duration_ms ?? null,
        status: event.status,
        source: event.source_surface,
      };
    }),
    total: events.length,
    page: currentPage,
    page_size: size,
  };
}

export function resetDatabase(db) {
  db.exec("DELETE FROM events; DELETE FROM daily_usage; DELETE FROM agent_state;");
}

export function isUsageEvent(event) {
  const u = event.usage || {};
  return event.meta?.accounting !== false && (
    Number(u.input_tokens || 0) > 0 ||
    Number(u.output_tokens || 0) > 0 ||
    Number(u.cache_read_tokens || 0) > 0 ||
    Number(u.cache_write_tokens || 0) > 0 ||
    Number(u.total_tokens || 0) > 0
  );
}

function upsertDaily(db, event) {
  const u = event.usage;
  db.prepare(`
    INSERT INTO daily_usage (
      day, source_agent, host_id, workspace_id, model, provider,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      total_tokens, cost_usd, error_count, event_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(day, source_agent, host_id, workspace_id, model, provider) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
      total_tokens = total_tokens + excluded.total_tokens,
      cost_usd = COALESCE(cost_usd, 0) + COALESCE(excluded.cost_usd, 0),
      error_count = error_count + excluded.error_count,
      event_count = event_count + 1
  `).run(
    event.day,
    event.source_agent,
    event.host_id,
    event.workspace_id,
    event.model,
    event.provider || "unknown",
    u.input_tokens,
    u.output_tokens,
    u.cache_read_tokens,
    u.cache_write_tokens,
    u.total_tokens,
    u.cost_usd,
    event.status === "error" ? 1 : 0,
  );
}

function upsertAgentState(db, event) {
  const key = [event.source_agent, event.host_id, event.workspace_id, event.session_id, event.agent_id].join(":");
  const summary = {
    username: event.username,
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
  const event = {
    ...row,
    usage: JSON.parse(row.usage_json || "{}"),
    meta: JSON.parse(row.meta_json || "{}"),
  };
  event.username = row.username || eventUsername(event);
  return event;
}

function withCorrelatedUsername(db, event) {
  if (event.username !== "unknown" || event.session_id === "unknown") return event;
  const row = db.prepare(`
    SELECT username FROM events
    WHERE source_agent = ? AND session_id = ? AND source_surface != 'otel'
      AND username != '' AND username != 'unknown'
    ORDER BY occurred_at DESC LIMIT 1
  `).get(event.source_agent, event.session_id);
  if (!row?.username) return event;
  return { ...event, username: row.username, meta: { ...event.meta, username: row.username } };
}

function shouldSkipSessionCollectorUsage(db, event) {
  if (event.source_surface !== "session_collector" || !isUsageEvent(event)) return false;
  const occurredMs = Date.parse(event.occurred_at);
  if (!Number.isFinite(occurredMs)) return false;
  const u = event.usage || {};
  const start = new Date(occurredMs - 10 * 60 * 1000).toISOString();
  const end = new Date(occurredMs + 10 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT model, usage_json FROM events
    WHERE source_agent = ?
      AND source_surface != 'session_collector'
      AND status != 'error'
      AND occurred_at BETWEEN ? AND ?
      AND (LOWER(model) = LOWER(?) OR LOWER(model) = 'unknown' OR LOWER(?) = 'unknown')
    LIMIT 100
  `).all(
    event.source_agent,
    start,
    end,
    event.model || "unknown",
    event.model || "unknown",
  );
  return rows.some((row) => {
    let existing = {};
    try {
      existing = JSON.parse(row.usage_json || "{}");
    } catch {
      existing = {};
    }
    return Number(existing.input_tokens || 0) === Number(u.input_tokens || 0) &&
      Number(existing.output_tokens || 0) === Number(u.output_tokens || 0) &&
      Number(existing.cache_read_tokens || 0) === Number(u.cache_read_tokens || 0) &&
      Number(existing.cache_write_tokens || 0) === Number(u.cache_write_tokens || 0);
  });
}

function listUsageEvents(db, filters) {
  return listFilteredEvents(db, filters).filter(isUsageEvent);
}

function listFilteredEvents(db, filters = {}) {
  const conditions = [];
  const params = [];
  if (filters.start) {
    conditions.push("occurred_at >= ?");
    params.push(filters.start);
  }
  if (filters.end) {
    conditions.push("occurred_at <= ?");
    params.push(filters.end);
  }
  if (filters.agent) {
    conditions.push("source_agent = ?");
    params.push(filters.agent);
  }
  if (filters.username) {
    conditions.push("username = ?");
    params.push(filters.username);
  }
  if (filters.provider) {
    conditions.push("(provider = ? OR (provider = 'unknown' AND source_agent = ?))");
    params.push(filters.provider);
    params.push(filters.provider);
  }
  if (filters.model) {
    conditions.push("model = ?");
    params.push(filters.model);
  }
  if (filters.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters.hook_type) {
    conditions.push("event_type = ?");
    params.push(filters.hook_type);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  let events = db.prepare(`SELECT * FROM events ${where} ORDER BY occurred_at DESC`).all(...params).map(rowToEvent);
  if (filters.machine) events = events.filter((event) => eventMachine(event) === filters.machine);
  return events;
}

function usageSummary(events) {
  const totals = events.reduce((sum, event) => {
    const u = event.usage || {};
    sum.input += Number(u.input_tokens || 0);
    sum.output += Number(u.output_tokens || 0);
    sum.cacheRead += Number(u.cache_read_tokens || 0);
    sum.cacheWrite += Number(u.cache_write_tokens || 0);
    if (event.status !== "error") sum.success += 1;
    return sum;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, success: 0 });
  const realTotal = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  const cacheableInput = totals.input + totals.cacheRead + totals.cacheWrite;
  return {
    total_requests: events.length,
    total_input_tokens: totals.input,
    total_output_tokens: totals.output,
    total_cache_write_tokens: totals.cacheWrite,
    total_cache_read_tokens: totals.cacheRead,
    real_total_tokens: realTotal,
    cache_hit_rate: cacheableInput > 0 ? totals.cacheRead / cacheableInput : 0,
    success_rate: events.length ? (totals.success / events.length) * 100 : 0,
  };
}

function usageTrend(events, filters) {
  return bucketEvents(events, filters).map((bucket) => {
    const summary = usageSummary(bucket.events);
    return {
      time: bucket.time,
      request_count: summary.total_requests,
      total_input_tokens: summary.total_input_tokens,
      total_output_tokens: summary.total_output_tokens,
      total_cache_write_tokens: summary.total_cache_write_tokens,
      total_cache_read_tokens: summary.total_cache_read_tokens,
      real_total_tokens: summary.real_total_tokens,
    };
  });
}

function requestTrend(events, filters) {
  return bucketEvents(events, filters).map((bucket) => ({
    time: bucket.time,
    request_count: bucket.events.length,
  }));
}

function bucketEvents(events, filters) {
  const sorted = [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const startMs = filters.start ? Date.parse(filters.start) : Date.parse(sorted[0]?.occurred_at || "");
  const endMs = filters.end ? Date.parse(filters.end) : Date.parse(sorted.at(-1)?.occurred_at || "");
  const spanMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
  const stepMs = spanMs <= 24 * 60 * 60 * 1000 ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const map = new Map();

  if (Number.isFinite(startMs) && Number.isFinite(endMs) && filters.start && filters.end) {
    for (let ms = floorTime(startMs, stepMs); ms <= endMs; ms += stepMs) {
      map.set(new Date(ms).toISOString(), []);
    }
  }

  for (const event of sorted) {
    const ms = Date.parse(event.occurred_at);
    if (!Number.isFinite(ms)) continue;
    const key = new Date(floorTime(ms, stepMs)).toISOString();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(event);
  }

  if (!map.size) return [{ time: "", events: [] }];
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([time, bucket]) => ({ time, events: bucket }));
}

function floorTime(ms, stepMs) {
  const date = new Date(ms);
  if (stepMs >= 24 * 60 * 60 * 1000) {
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime();
  }
  date.setUTCMinutes(0, 0, 0);
  return date.getTime();
}

function countBy(events, keyFn, keyName) {
  return [...groupBy(events, keyFn).entries()]
    .map(([key, rows]) => ({ [keyName]: key, count: rows.length }))
    .sort((a, b) => b.count - a.count || String(a[keyName]).localeCompare(String(b[keyName])));
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item) || "unknown";
    const rows = map.get(key) || [];
    rows.push(item);
    map.set(key, rows);
  }
  return map;
}

function usageProvider(event) {
  return event.provider && event.provider !== "unknown" ? event.provider : event.source_agent;
}

function usageTotal(event) {
  const u = event.usage || {};
  return Number(u.input_tokens || 0) + Number(u.output_tokens || 0) + Number(u.cache_read_tokens || 0) + Number(u.cache_write_tokens || 0);
}

function eventMachine(event) {
  return event.meta?.machine_name || event.host_id || "unknown";
}

function eventUsername(event) {
  return event.username || event.meta?.username || event.meta?.machine_name || event.host_id || "unknown";
}

function migrateDatabase(db) {
  const columns = db.prepare("PRAGMA table_info(events)").all().map((row) => row.name);
  if (!columns.includes("username")) {
    db.exec("ALTER TABLE events ADD COLUMN username TEXT NOT NULL DEFAULT ''");
    const rows = db.prepare("SELECT event_id, host_id, meta_json FROM events WHERE username = ''").all();
    const update = db.prepare("UPDATE events SET username = ? WHERE event_id = ?");
    for (const row of rows) {
      let meta = {};
      try {
        meta = JSON.parse(row.meta_json || "{}");
      } catch {
        meta = {};
      }
      update.run(meta.username || meta.machine_name || row.host_id || "unknown", row.event_id);
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS events_username_idx ON events(username, occurred_at)");
  db.exec("CREATE INDEX IF NOT EXISTS events_occurred_at_idx ON events(occurred_at)");

  // daily_usage 升级：补 provider（纳入主键）+ error_count；SQLite 无法直接改主键，需重建表
  const dailyCols = db.prepare("PRAGMA table_info(daily_usage)").all().map((row) => row.name);
  if (!dailyCols.includes("provider")) {
    db.exec(`
      CREATE TABLE daily_usage_v2 (
        day TEXT NOT NULL,
        source_agent TEXT NOT NULL,
        host_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'unknown',
        input_tokens REAL NOT NULL DEFAULT 0,
        output_tokens REAL NOT NULL DEFAULT 0,
        cache_read_tokens REAL NOT NULL DEFAULT 0,
        cache_write_tokens REAL NOT NULL DEFAULT 0,
        total_tokens REAL NOT NULL DEFAULT 0,
        cost_usd REAL,
        error_count INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(day, source_agent, host_id, workspace_id, model, provider)
      );
      INSERT INTO daily_usage_v2 (
        day, source_agent, host_id, workspace_id, model, provider,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        total_tokens, cost_usd, error_count, event_count
      )
      SELECT
        day, source_agent, host_id, workspace_id, model,
        COALESCE(NULLIF(provider, ''), 'unknown'),
        SUM(COALESCE(CAST(json_extract(usage_json, '$.input_tokens') AS REAL), 0)),
        SUM(COALESCE(CAST(json_extract(usage_json, '$.output_tokens') AS REAL), 0)),
        SUM(COALESCE(CAST(json_extract(usage_json, '$.cache_read_tokens') AS REAL), 0)),
        SUM(COALESCE(CAST(json_extract(usage_json, '$.cache_write_tokens') AS REAL), 0)),
        SUM(COALESCE(CAST(json_extract(usage_json, '$.total_tokens') AS REAL), 0)),
        SUM(COALESCE(CAST(json_extract(usage_json, '$.cost_usd') AS REAL), 0)),
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END),
        COUNT(*)
      FROM events
      WHERE (json_extract(meta_json, '$.accounting') IS NULL OR json_extract(meta_json, '$.accounting') != 0)
        AND (
          COALESCE(CAST(json_extract(usage_json, '$.input_tokens') AS REAL), 0) +
          COALESCE(CAST(json_extract(usage_json, '$.output_tokens') AS REAL), 0) +
          COALESCE(CAST(json_extract(usage_json, '$.cache_read_tokens') AS REAL), 0) +
          COALESCE(CAST(json_extract(usage_json, '$.cache_write_tokens') AS REAL), 0) +
          COALESCE(CAST(json_extract(usage_json, '$.total_tokens') AS REAL), 0)
        ) > 0
      GROUP BY day, source_agent, host_id, workspace_id, model, provider;
      DROP TABLE daily_usage;
      ALTER TABLE daily_usage_v2 RENAME TO daily_usage;
    `);
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function average(values) {
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length);
}

function clampLimit(value, fallback, max) {
  return Math.max(1, Math.min(Number(value) || fallback, max));
}
