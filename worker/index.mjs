import { normalizeEvent, normalizeOtelLogs, normalizeOtelMetrics } from "../src/normalize.mjs";
import { buildDysonState } from "../src/dyson-state.mjs";

const COOKIE_NAME = "cultivagent_token";
const COOKIE_MAX_AGE = 2592000;
const MAX_JSON_BYTES = 1024 * 1024;

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      if (error instanceof SyntaxError) return json({ error: "invalid_json" }, 400);
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({ message: "worker_request_failed", error: error instanceof Error ? error.message : String(error) }));
      return json({ error: "internal_error" }, 500);
    }
  },
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  if (request.method === "GET" && url.pathname === "/api/health") return json({ ok: true });
  if (request.method === "POST" && url.pathname === "/api/login") return handleLogin(request, env);
  if (request.method === "POST" && url.pathname === "/api/logout") return handleLogout();

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    if (!(await isAuthorized(request, env))) return html(loginPageHtml());
    return noStore(await env.ASSETS.fetch(assetRequest(request, "/")));
  }
  if (request.method === "GET" && (url.pathname === "/dyson" || url.pathname === "/dyson.html")) {
    if (!(await isAuthorized(request, env))) return html(loginPageHtml());
    return noStore(await env.ASSETS.fetch(assetRequest(request, "/dyson")));
  }

  if (!(await isAuthorized(request, env))) return json({ error: "unauthorized" }, 401);

  if (request.method === "GET" && url.pathname === "/dyson-trajectory.mjs") {
    return noStore(await env.ASSETS.fetch(assetRequest(request, "/dyson-trajectory.mjs")));
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    return json({ events: await listEvents(env.DB, eventFilters(url.searchParams)) });
  }
  if (request.method === "GET" && url.pathname === "/api/daily") {
    return json({ daily: await listDaily(env.DB, url.searchParams.get("day")) });
  }
  if (request.method === "GET" && url.pathname === "/api/agents") {
    return json({ agents: await listAgents(env.DB) });
  }
  if (request.method === "GET" && url.pathname === "/api/dyson/state") {
    return json(await listDysonState(env.DB, dysonFilters(url.searchParams)));
  }
  if (request.method === "GET" && url.pathname === "/api/request-stats") {
    return json(await listRequestStats(env.DB, statsFilters(url.searchParams)));
  }
  if (request.method === "GET" && url.pathname === "/api/usage/summary") {
    return json({ summary: await listUsageSummary(env.DB, statsFilters(url.searchParams)) });
  }
  if (request.method === "GET" && url.pathname === "/api/usage/trends") {
    return json({ trends: await listUsageTrends(env.DB, statsFilters(url.searchParams)) });
  }
  if (request.method === "GET" && url.pathname === "/api/usage/providers") {
    return json(await listUsageProviderStats(env.DB, statsFilters(url.searchParams)));
  }
  if (request.method === "GET" && url.pathname === "/api/usage/models") {
    return json(await listUsageModelStats(env.DB, statsFilters(url.searchParams)));
  }
  if (request.method === "GET" && url.pathname === "/api/usage/logs") {
    return json(await listUsageLogs(env.DB, statsFilters(url.searchParams), url.searchParams.get("page"), url.searchParams.get("pageSize")));
  }
  if (request.method === "GET" && url.pathname === "/api/pool") return json({ events: [] });

  if (request.method === "POST" && url.pathname === "/api/reset") {
    await resetDatabase(env.DB);
    return json({ ok: true });
  }
  if (request.method === "POST" && url.pathname === "/ingest") {
    const body = await readJson(request);
    return json(await saveEvents(env.DB, normalizeInputEvents(body)), 202);
  }
  if (request.method === "POST" && url.pathname === "/otel/v1/logs") {
    const body = await readJson(request);
    return json(await saveEvents(env.DB, normalizeOtelLogs(body)), 202);
  }
  if (request.method === "POST" && url.pathname === "/otel/v1/metrics") {
    const body = await readJson(request);
    return json(await saveEvents(env.DB, normalizeOtelMetrics(body)), 202);
  }
  if (request.method === "GET" && url.pathname === "/docs/install") {
    return text("See https://github.com/JupiterTheWarlock/cultivagent/blob/main/docs/INSTALL.md\n", "text/markdown; charset=utf-8");
  }

  return json({ error: "not_found" }, 404);
}

function normalizeInputEvents(body) {
  const events = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : [body];
  return events.map((event) => normalizeEvent(event));
}

async function saveEvents(db, events) {
  let inserted = 0;
  let duplicate = 0;
  for (const event of events) {
    if (await insertEvent(db, event)) inserted += 1;
    else duplicate += 1;
  }
  return { ok: true, inserted, duplicate, pool_size: 0 };
}

async function insertEvent(db, event) {
  event = await withCorrelatedUsername(db, event);
  if (await shouldSkipSessionCollectorUsage(db, event)) return false;
  const result = await db.prepare(`
    INSERT OR IGNORE INTO events (
      event_id, schema_version, source_agent, source_surface, event_type,
      occurred_at, day, username, host_id, workspace_id, session_id, turn_id, agent_id,
      provider, model, status, duration_ms, usage_json, meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
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
  ).run();
  const changed = Number(result.meta?.changes ?? result.meta?.rows_written ?? 0) > 0;
  if (!changed) return false;
  const statements = [agentStateStatement(db, event)];
  if (isUsageEvent(event)) statements.unshift(dailyUsageStatement(db, event));
  await db.batch(statements);
  return true;
}

function dailyUsageStatement(db, event) {
  const u = event.usage;
  return db.prepare(`
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
  `).bind(
    event.day,
    event.source_agent,
    event.host_id,
    event.workspace_id,
    event.model,
    event.provider || "unknown",
    event.usage.input_tokens,
    event.usage.output_tokens,
    event.usage.cache_read_tokens,
    event.usage.cache_write_tokens,
    event.usage.total_tokens,
    event.usage.cost_usd,
    event.status === "error" ? 1 : 0,
  );
}

function agentStateStatement(db, event) {
  const key = [event.source_agent, event.host_id, event.workspace_id, event.session_id, event.agent_id].join(":");
  const summary = {
    username: event.username,
    event_type: event.event_type,
    model: event.model,
    provider: event.provider,
    usage: event.usage,
    meta: event.meta,
  };
  return db.prepare(`
    INSERT INTO agent_state (
      agent_key, source_agent, host_id, workspace_id, session_id,
      status, last_event_at, summary_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_key) DO UPDATE SET
      status = excluded.status,
      last_event_at = excluded.last_event_at,
      summary_json = excluded.summary_json
    WHERE excluded.last_event_at >= agent_state.last_event_at
  `).bind(
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

async function listEvents(db, options = {}) {
  const conditions = [];
  const params = [];
  if (options.start) {
    conditions.push("occurred_at >= ?");
    params.push(options.start);
  }
  if (options.end) {
    conditions.push("occurred_at <= ?");
    params.push(options.end);
  }
  if (options.since) {
    conditions.push("occurred_at > ?");
    params.push(options.since);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const order = options.order === "asc" ? "ASC" : "DESC";
  const limit = clampLimit(options.limit, 1000, 20000);
  const columns = options.compact
    ? `event_id, source_agent, source_surface, event_type, provider, model, status,
      duration_ms, occurred_at, username, host_id, workspace_id, session_id, usage_json`
    : "*";
  const { results } = await db.prepare(`SELECT ${columns} FROM events ${where} ORDER BY occurred_at ${order} LIMIT ?`).bind(...params, limit).all();
  return results.map(rowToEvent);
}

async function listDaily(db, day = null) {
  const stmt = day
    ? db.prepare("SELECT * FROM daily_usage WHERE day = ? ORDER BY total_tokens DESC").bind(day)
    : db.prepare("SELECT * FROM daily_usage ORDER BY day DESC, total_tokens DESC LIMIT 500");
  const { results } = await stmt.all();
  return results;
}

async function listAgents(db) {
  const { results } = await db.prepare("SELECT * FROM agent_state ORDER BY last_event_at DESC").all();
  return results.map((row) => ({ ...row, summary: JSON.parse(row.summary_json) }));
}

async function listDysonState(db, options = {}) {
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
  const { results } = await db.prepare(`SELECT * FROM events WHERE ${conditions.join(" AND ")} ORDER BY occurred_at ASC`).bind(...params).all();
  return buildDysonState(results.map(rowToEvent), await listAgents(db), { ...options, day });
}

async function listRequestStats(db, filters = {}) {
  const events = await listFilteredEvents(db, filters);
  const limit = clampLimit(filters.limit, 100, 1000);
  return {
    summary: {
      total_requests: events.length,
      agents: unique(events.map((event) => event.source_agent)).length,
      users: unique(events.map(eventUsername)).length,
      machines: unique(events.map(eventMachine)).length,
      hook_types: unique(events.map((event) => event.event_type)).length,
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

// —— usage 聚合：优先走 daily_usage（百级行）；daily_usage 不支持的过滤维度（username/status/hook_type/machine）降级到 events，但仍在 SQL 端 SUM/GROUP BY，不把原始行拉回 Worker ——

// daily_usage 无 username/status/event_type/machine_name 列，带这些过滤时降级 events
function dailyEligible(filters) {
  return !filters.username && !filters.status && !filters.hook_type && !filters.machine;
}

// provider 维度归并，与 usageProvider 一致：provider 非 unknown 取 provider，否则回退 source_agent
const PROVIDER_EXPR = "(CASE WHEN provider IS NULL OR provider = 'unknown' THEN source_agent ELSE provider END)";

function dailyWhere(filters) {
  const conditions = [];
  const params = [];
  if (filters.start) { conditions.push("day >= ?"); params.push(filters.start.slice(0, 10)); }
  if (filters.end) { conditions.push("day <= ?"); params.push(filters.end.slice(0, 10)); }
  if (filters.agent) { conditions.push("source_agent = ?"); params.push(filters.agent); }
  if (filters.model) { conditions.push("model = ?"); params.push(filters.model); }
  if (filters.provider) { conditions.push(`${PROVIDER_EXPR} = ?`); params.push(filters.provider); }
  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

// isUsageEvent 的 SQL 等价：accounting !== false 且任一 token > 0
function usageConditions() {
  const tok = (key) => `COALESCE(CAST(json_extract(usage_json, '$.${key}') AS REAL), 0)`;
  return [
    "(json_extract(meta_json, '$.accounting') IS NULL OR json_extract(meta_json, '$.accounting') != 0)",
    `(${tok("input_tokens")} + ${tok("output_tokens")} + ${tok("cache_read_tokens")} + ${tok("cache_write_tokens")} + ${tok("total_tokens")}) > 0`,
  ];
}

function eventsUsageWhere(filters) {
  const conditions = usageConditions();
  const params = [];
  if (filters.start) { conditions.push("occurred_at >= ?"); params.push(filters.start); }
  if (filters.end) { conditions.push("occurred_at <= ?"); params.push(filters.end); }
  if (filters.agent) { conditions.push("source_agent = ?"); params.push(filters.agent); }
  if (filters.model) { conditions.push("model = ?"); params.push(filters.model); }
  if (filters.username) { conditions.push("username = ?"); params.push(filters.username); }
  if (filters.status) { conditions.push("status = ?"); params.push(filters.status); }
  if (filters.hook_type) { conditions.push("event_type = ?"); params.push(filters.hook_type); }
  if (filters.provider) { conditions.push(`${PROVIDER_EXPR} = ?`); params.push(filters.provider); }
  if (filters.machine) {
    conditions.push("COALESCE(json_extract(meta_json, '$.machine_name'), host_id) = ?");
    params.push(filters.machine);
  }
  return { where: `WHERE ${conditions.join(" AND ")}`, params };
}

function summaryFromRow(row) {
  row = row || {};
  const input = Number(row.input_tokens || 0);
  const output = Number(row.output_tokens || 0);
  const cacheRead = Number(row.cache_read_tokens || 0);
  const cacheWrite = Number(row.cache_write_tokens || 0);
  const total = Number(row.total_requests || 0);
  const errors = Number(row.error_count || 0);
  const cacheable = input + cacheRead + cacheWrite;
  return {
    total_requests: total,
    total_input_tokens: input,
    total_output_tokens: output,
    total_cache_write_tokens: cacheWrite,
    total_cache_read_tokens: cacheRead,
    real_total_tokens: input + output + cacheRead + cacheWrite,
    cache_hit_rate: cacheable > 0 ? cacheRead / cacheable : 0,
    success_rate: total ? ((total - errors) / total) * 100 : 0,
  };
}

async function listUsageSummary(db, filters = {}) {
  if (dailyEligible(filters)) {
    const { where, params } = dailyWhere(filters);
    return summaryFromRow(await db.prepare(`
      SELECT
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_write_tokens) AS cache_write_tokens,
        SUM(event_count) AS total_requests,
        SUM(error_count) AS error_count
      FROM daily_usage ${where}
    `).bind(...params).first());
  }
  const tok = (key) => `COALESCE(CAST(json_extract(usage_json, '$.${key}') AS REAL), 0)`;
  const { where, params } = eventsUsageWhere(filters);
  return summaryFromRow(await db.prepare(`
    SELECT
      SUM(${tok("input_tokens")}) AS input_tokens,
      SUM(${tok("output_tokens")}) AS output_tokens,
      SUM(${tok("cache_read_tokens")}) AS cache_read_tokens,
      SUM(${tok("cache_write_tokens")}) AS cache_write_tokens,
      COUNT(*) AS total_requests,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count
    FROM events ${where}
  `).bind(...params).first());
}

async function listUsageProviderStats(db, filters = {}) {
  if (dailyEligible(filters)) {
    const { where, params } = dailyWhere(filters);
    const { results } = await db.prepare(`
      SELECT
        ${PROVIDER_EXPR} AS provider,
        SUM(event_count) AS request_count,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS total_tokens,
        SUM(event_count - error_count) AS ok_count
      FROM daily_usage ${where}
      GROUP BY provider ORDER BY total_tokens DESC
    `).bind(...params).all();
    return { providers: results.map((r) => ({
      provider: r.provider,
      request_count: Number(r.request_count || 0),
      total_tokens: Number(r.total_tokens || 0),
      success_rate: Number(r.request_count || 0) ? (Number(r.ok_count || 0) / Number(r.request_count)) * 100 : 0,
      avg_latency_ms: null,
    })) };
  }
  const tok = (key) => `COALESCE(CAST(json_extract(usage_json, '$.${key}') AS REAL), 0)`;
  const { where, params } = eventsUsageWhere(filters);
  const { results } = await db.prepare(`
    SELECT
      ${PROVIDER_EXPR} AS provider,
      COUNT(*) AS request_count,
      SUM(${tok("input_tokens")} + ${tok("output_tokens")} + ${tok("cache_read_tokens")} + ${tok("cache_write_tokens")}) AS total_tokens,
      SUM(CASE WHEN status != 'error' THEN 1 ELSE 0 END) AS ok_count,
      AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) AS avg_latency_ms
    FROM events ${where}
    GROUP BY provider ORDER BY total_tokens DESC
  `).bind(...params).all();
  return { providers: results.map((r) => ({
    provider: r.provider,
    request_count: Number(r.request_count || 0),
    total_tokens: Number(r.total_tokens || 0),
    success_rate: Number(r.request_count || 0) ? (Number(r.ok_count || 0) / Number(r.request_count)) * 100 : 0,
    avg_latency_ms: r.avg_latency_ms != null ? Math.round(Number(r.avg_latency_ms)) : null,
  })) };
}

async function listUsageModelStats(db, filters = {}) {
  if (dailyEligible(filters)) {
    const { where, params } = dailyWhere(filters);
    const { results } = await db.prepare(`
      SELECT model,
        SUM(event_count) AS request_count,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS total_tokens
      FROM daily_usage ${where}
      GROUP BY model ORDER BY total_tokens DESC
    `).bind(...params).all();
    return { models: results.map((r) => ({ model: r.model, request_count: Number(r.request_count || 0), total_tokens: Number(r.total_tokens || 0) })) };
  }
  const tok = (key) => `COALESCE(CAST(json_extract(usage_json, '$.${key}') AS REAL), 0)`;
  const { where, params } = eventsUsageWhere(filters);
  const { results } = await db.prepare(`
    SELECT model,
      COUNT(*) AS request_count,
      SUM(${tok("input_tokens")} + ${tok("output_tokens")} + ${tok("cache_read_tokens")} + ${tok("cache_write_tokens")}) AS total_tokens
    FROM events ${where}
    GROUP BY model ORDER BY total_tokens DESC
  `).bind(...params).all();
  return { models: results.map((r) => ({ model: r.model || "unknown", request_count: Number(r.request_count || 0), total_tokens: Number(r.total_tokens || 0) })) };
}

function normalizeTrendRow(r) {
  return {
    time: r.time,
    request_count: Number(r.request_count || 0),
    total_input_tokens: Number(r.total_input_tokens || 0),
    total_output_tokens: Number(r.total_output_tokens || 0),
    total_cache_write_tokens: Number(r.total_cache_write_tokens || 0),
    total_cache_read_tokens: Number(r.total_cache_read_tokens || 0),
    real_total_tokens: Number(r.real_total_tokens || 0),
  };
}

async function listUsageTrends(db, filters = {}) {
  const hourly = filters.start && filters.end
    && (Date.parse(filters.end) - Date.parse(filters.start)) <= 24 * 60 * 60 * 1000;
  if (!hourly && dailyEligible(filters)) {
    const { where, params } = dailyWhere(filters);
    const { results } = await db.prepare(`
      SELECT
        day || 'T00:00:00.000Z' AS time,
        SUM(event_count) AS request_count,
        SUM(input_tokens) AS total_input_tokens,
        SUM(output_tokens) AS total_output_tokens,
        SUM(cache_write_tokens) AS total_cache_write_tokens,
        SUM(cache_read_tokens) AS total_cache_read_tokens,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS real_total_tokens
      FROM daily_usage ${where}
      GROUP BY day ORDER BY day ASC
    `).bind(...params).all();
    return results.map(normalizeTrendRow);
  }
  const tok = (key) => `COALESCE(CAST(json_extract(usage_json, '$.${key}') AS REAL), 0)`;
  const { where, params } = eventsUsageWhere(filters);
  const bucket = hourly
    ? "strftime('%Y-%m-%dT%H:00:00.000Z', occurred_at)"
    : "substr(occurred_at, 1, 10) || 'T00:00:00.000Z'";
  const { results } = await db.prepare(`
    SELECT
      ${bucket} AS time,
      COUNT(*) AS request_count,
      SUM(${tok("input_tokens")}) AS total_input_tokens,
      SUM(${tok("output_tokens")}) AS total_output_tokens,
      SUM(${tok("cache_write_tokens")}) AS total_cache_write_tokens,
      SUM(${tok("cache_read_tokens")}) AS total_cache_read_tokens,
      SUM(${tok("input_tokens")} + ${tok("output_tokens")} + ${tok("cache_read_tokens")} + ${tok("cache_write_tokens")}) AS real_total_tokens
    FROM events ${where}
    GROUP BY time ORDER BY time ASC
  `).bind(...params).all();
  return results.map(normalizeTrendRow);
}

async function listUsageLogs(db, filters = {}, page = 0, pageSize = 20) {
  const size = clampLimit(pageSize, 20, 100);
  const currentPage = Math.max(0, Number(page) || 0);
  // 无时间窗时默认最近 7 天，避免深翻页 OFFSET + 全表 COUNT
  const ranged = filters.start || filters.end
    ? filters
    : { ...filters, start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), end: new Date().toISOString() };
  const { where, params } = eventsUsageWhere(ranged);
  const total = Number((await db.prepare(`SELECT COUNT(*) AS n FROM events ${where}`).bind(...params).first())?.n || 0);
  const { results } = await db.prepare(`
    SELECT event_id, occurred_at, source_agent, username, provider, model, status,
           duration_ms, source_surface, usage_json
    FROM events ${where}
    ORDER BY occurred_at DESC
    LIMIT ? OFFSET ?
  `).bind(...params, size, currentPage * size).all();
  return {
    logs: results.map((row) => {
      let u = {};
      try { u = JSON.parse(row.usage_json || "{}"); } catch { u = {}; }
      const total_tokens = Number(u.input_tokens || 0) + Number(u.output_tokens || 0)
        + Number(u.cache_read_tokens || 0) + Number(u.cache_write_tokens || 0);
      return {
        event_id: row.event_id,
        time: row.occurred_at,
        agent: row.source_agent,
        username: row.username || "unknown",
        provider: row.provider && row.provider !== "unknown" ? row.provider : row.source_agent,
        model: row.model || "unknown",
        input_tokens: Number(u.input_tokens || 0),
        output_tokens: Number(u.output_tokens || 0),
        cache_read_tokens: Number(u.cache_read_tokens || 0),
        cache_write_tokens: Number(u.cache_write_tokens || 0),
        total_tokens,
        latency_ms: row.duration_ms ?? null,
        status: row.status,
        source: row.source_surface,
      };
    }),
    total,
    page: currentPage,
    page_size: size,
  };
}

async function resetDatabase(db) {
  await db.batch([
    db.prepare("DELETE FROM events"),
    db.prepare("DELETE FROM daily_usage"),
    db.prepare("DELETE FROM agent_state"),
  ]);
}

async function listUsageEvents(db, filters = {}) {
  return (await listFilteredEvents(db, filters)).filter(isUsageEvent);
}

async function listFilteredEvents(db, filters = {}) {
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
    params.push(filters.provider, filters.provider);
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
  const limit = clampLimit(filters.limit, 1000, 20000);
  const { results } = await db.prepare(`SELECT * FROM events ${where} ORDER BY occurred_at DESC LIMIT ?`).bind(...params, limit).all();
  let events = results.map(rowToEvent);
  if (filters.machine) events = events.filter((event) => eventMachine(event) === filters.machine);
  return events;
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

async function withCorrelatedUsername(db, event) {
  if (event.username !== "unknown" || event.session_id === "unknown") return event;
  const row = await db.prepare(`
    SELECT username FROM events
    WHERE source_agent = ? AND session_id = ? AND source_surface != 'otel'
      AND username != '' AND username != 'unknown'
    ORDER BY occurred_at DESC LIMIT 1
  `).bind(event.source_agent, event.session_id).first();
  if (!row?.username) return event;
  return { ...event, username: row.username, meta: { ...event.meta, username: row.username } };
}

async function shouldSkipSessionCollectorUsage(db, event) {
  if (event.source_surface !== "session_collector" || !isUsageEvent(event)) return false;
  const occurredMs = Date.parse(event.occurred_at);
  if (!Number.isFinite(occurredMs)) return false;
  const u = event.usage || {};
  const start = new Date(occurredMs - 10 * 60 * 1000).toISOString();
  const end = new Date(occurredMs + 10 * 60 * 1000).toISOString();
  const { results } = await db.prepare(`
    SELECT model, usage_json FROM events
    WHERE source_agent = ?
      AND source_surface != 'session_collector'
      AND status != 'error'
      AND occurred_at BETWEEN ? AND ?
      AND (LOWER(model) = LOWER(?) OR LOWER(model) = 'unknown' OR LOWER(?) = 'unknown')
    LIMIT 100
  `).bind(
    event.source_agent,
    start,
    end,
    event.model || "unknown",
    event.model || "unknown",
  ).all();
  return results.some((row) => {
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

function isUsageEvent(event) {
  const u = event.usage || {};
  return event.meta?.accounting !== false && (
    Number(u.input_tokens || 0) > 0 ||
    Number(u.output_tokens || 0) > 0 ||
    Number(u.cache_read_tokens || 0) > 0 ||
    Number(u.cache_write_tokens || 0) > 0 ||
    Number(u.total_tokens || 0) > 0
  );
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
  return bucketEvents(events, filters).map((bucket) => ({ time: bucket.time, request_count: bucket.events.length }));
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
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([time, rows]) => ({ time, events: rows }));
}

function statsFilters(params) {
  return {
    start: dateParam(params.get("start")),
    end: dateParam(params.get("end")),
    agent: emptyToUndefined(params.get("agent")),
    username: emptyToUndefined(params.get("username")),
    provider: emptyToUndefined(params.get("provider")),
    model: emptyToUndefined(params.get("model")),
    status: emptyToUndefined(params.get("status")),
    hook_type: emptyToUndefined(params.get("hook_type") ?? params.get("hookType")),
    machine: emptyToUndefined(params.get("machine")),
    limit: params.get("limit"),
  };
}

function eventFilters(params) {
  const ranged = params.has("start") || params.has("end") || params.has("since");
  return {
    start: dateParam(params.get("start")),
    end: dateParam(params.get("end")),
    since: dateParam(params.get("since")),
    limit: params.get("limit"),
    compact: params.get("compact") === "1",
    order: ranged ? "asc" : "desc",
  };
}

function dysonFilters(params) {
  return {
    day: dayParam(params.get("day")),
    start: dateParam(params.get("start")),
    end: dateParam(params.get("end")),
    now: dateParam(params.get("now")),
    detail: params.get("detail") === "1",
  };
}

async function isAuthorized(request, env) {
  if (!env.CULTIVAGENT_TOKEN) return true;
  const candidates = [];
  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) candidates.push(auth.slice(7));
  const xToken = request.headers.get("x-cultivagent-token");
  if (xToken) candidates.push(xToken);
  const cookie = parseCookie(request.headers.get("cookie") || "");
  if (cookie[COOKIE_NAME]) candidates.push(cookie[COOKIE_NAME]);
  for (const candidate of candidates) {
    if (await safeEq(candidate, env.CULTIVAGENT_TOKEN)) return true;
  }
  return false;
}

async function handleLogin(request, env) {
  if (!env.CULTIVAGENT_TOKEN) return json({ ok: true });
  const body = await readJson(request);
  if (!(await safeEq(body.token ?? "", env.CULTIVAGENT_TOKEN))) return json({ error: "invalid token" }, 401);
  const cookie = `${COOKIE_NAME}=${encodeURIComponent(body.token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
  return json({ ok: true }, 200, { "set-cookie": cookie });
}

function handleLogout() {
  const cookie = `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  return json({ ok: true }, 200, { "set-cookie": cookie });
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_JSON_BYTES) throw new HttpError(413, "request_too_large");
  const textBody = await request.text();
  if (textBody.length > MAX_JSON_BYTES) throw new HttpError(413, "request_too_large");
  return textBody ? JSON.parse(textBody) : {};
}

async function safeEq(a, b) {
  const [aa, bb] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let diff = 0;
  for (let i = 0; i < aa.length; i += 1) diff |= aa[i] ^ bb[i];
  return diff === 0 && String(b).length > 0;
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function text(body, type, status = 200) {
  return new Response(body, { status, headers: { "content-type": type } });
}

function html(body) {
  return text(body, "text/html; charset=utf-8");
}

function noStore(response) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

function assetRequest(request, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
}

function parseCookie(header) {
  const out = {};
  for (const pair of String(header).split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    out[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
  }
  return out;
}

function dateParam(value) {
  if (!value) return undefined;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric * 1000) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function dayParam(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : undefined;
}

function emptyToUndefined(value) {
  return value == null || value === "" || value === "all" ? undefined : value;
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

function usageProvider(event) {
  return event.provider && event.provider !== "unknown" ? event.provider : event.source_agent;
}

function usageTotal(event) {
  const u = event.usage || {};
  const components = Number(u.input_tokens || 0) + Number(u.output_tokens || 0) + Number(u.cache_read_tokens || 0) + Number(u.cache_write_tokens || 0);
  return components || Number(u.total_tokens || 0);
}

function eventMachine(event) {
  return event.meta?.machine_name || event.host_id || "unknown";
}

function eventUsername(event) {
  return event.username || event.meta?.username || event.meta?.machine_name || event.host_id || "unknown";
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function loginPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cultivagent</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 2rem; width: 320px; }
  h1 { margin: 0 0 1.5rem; font-size: 1.25rem; font-weight: 600; }
  label { display: block; margin-bottom: .375rem; font-size: .8rem; color: #8b949e; }
  input { width: 100%; padding: .5rem .625rem; border-radius: 6px; border: 1px solid #30363d; background: #0d1117; color: #c9d1d9; font-size: .9rem; }
  input:focus { outline: none; border-color: #58a6ff; }
  button { margin-top: 1rem; width: 100%; padding: .5rem; border: 0; border-radius: 6px; background: #238636; color: #fff; cursor: pointer; font-size: .9rem; font-weight: 500; }
  button:hover { background: #2ea043; }
  .err { color: #f85149; margin-top: .75rem; font-size: .8rem; min-height: 1em; }
</style>
</head>
<body>
<form class="card" id="f" autocomplete="on">
  <h1>Cultivagent</h1>
  <label for="t">Token</label>
  <input id="t" name="token" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Sign in</button>
  <div class="err" id="e"></div>
</form>
<script>
  const f = document.getElementById('f'), e = document.getElementById('e');
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    e.textContent = '';
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: document.getElementById('t').value }),
    });
    if (r.ok) location.reload();
    else e.textContent = 'Invalid token';
  });
</script>
</body>
</html>`;
}
