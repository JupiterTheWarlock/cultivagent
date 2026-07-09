import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  openDatabase,
  insertEvent,
  listAgents,
  listDaily,
  listDysonState,
  listEvents,
  listRequestStats,
  listUsageLogs,
  listUsageModelStats,
  listUsageProviderStats,
  listUsageSummary,
  listUsageTrends,
  resetDatabase,
} from "./db.mjs";
import { normalizeEvent, normalizeOtelLogs, normalizeOtelMetrics } from "./normalize.mjs";
import { isAuthorized, handleLogin, handleLogout, loginPageHtml } from "./auth.mjs";

export function createCultivagentServer(options = {}) {
  const db = options.db ?? openDatabase(options.dbPath);
  const pool = new Map();
  const poolTtlMs = options.poolTtlMs ?? 10 * 60 * 1000;
  const token = options.token ?? "";

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");

      // 公开白名单：token 非空时也放行（探活 + 登录流程）
      if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true });
      if (req.method === "POST" && url.pathname === "/api/login") return await handleLogin(req, res, token);
      if (req.method === "POST" && url.pathname === "/api/logout") return handleLogout(res);

      // dashboard：已登录（或本地无 token）返回 dashboard，否则返回登录页
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return html(res, isAuthorized(req, token) ? dashboardHtml() : loginPageHtml());
      }
      if (req.method === "GET" && (url.pathname === "/dyson" || url.pathname === "/dyson.html")) {
        return html(res, isAuthorized(req, token) ? dysonHtml() : loginPageHtml());
      }

      // 其余所有路径：token 非空时强制 auth（含 GET，堵住 /api/* 裸奔）
      if (!isAuthorized(req, token)) {
        return json(res, 401, { error: "unauthorized" });
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        return json(res, 200, { events: listEvents(db, eventFilters(url.searchParams)) });
      }
      if (req.method === "GET" && url.pathname === "/api/daily") {
        return json(res, 200, { daily: listDaily(db, url.searchParams.get("day")) });
      }
      if (req.method === "GET" && url.pathname === "/api/agents") return json(res, 200, { agents: listAgents(db) });
      if (req.method === "GET" && url.pathname === "/api/dyson/state") {
        return json(res, 200, listDysonState(db, dysonFilters(url.searchParams)));
      }
      if (req.method === "GET" && url.pathname === "/api/request-stats") {
        return json(res, 200, listRequestStats(db, statsFilters(url.searchParams)));
      }
      if (req.method === "GET" && url.pathname === "/api/usage/summary") {
        return json(res, 200, listUsageSummary(db, statsFilters(url.searchParams)));
      }
      if (req.method === "GET" && url.pathname === "/api/usage/trends") {
        return json(res, 200, listUsageTrends(db, statsFilters(url.searchParams)));
      }
      if (req.method === "GET" && url.pathname === "/api/usage/providers") {
        return json(res, 200, listUsageProviderStats(db, statsFilters(url.searchParams)));
      }
      if (req.method === "GET" && url.pathname === "/api/usage/models") {
        return json(res, 200, listUsageModelStats(db, statsFilters(url.searchParams)));
      }
      if (req.method === "GET" && url.pathname === "/api/usage/logs") {
        return json(res, 200, listUsageLogs(
          db,
          statsFilters(url.searchParams),
          url.searchParams.get("page"),
          url.searchParams.get("pageSize"),
        ));
      }
      if (req.method === "GET" && url.pathname === "/api/pool") {
        cleanupPool(pool);
        return json(res, 200, { events: [...pool.values()].map((x) => x.event) });
      }
      if (req.method === "POST" && url.pathname === "/api/reset") {
        resetDatabase(db);
        pool.clear();
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/ingest") {
        const body = await readJson(req);
        const events = normalizeInputEvents(body);
        const result = saveEvents(db, pool, poolTtlMs, events);
        return json(res, 202, result);
      }
      if (req.method === "POST" && url.pathname === "/otel/v1/logs") {
        const body = await readJson(req);
        const result = saveEvents(db, pool, poolTtlMs, normalizeOtelLogs(body));
        return json(res, 202, result);
      }
      if (req.method === "POST" && url.pathname === "/otel/v1/metrics") {
        const body = await readJson(req);
        const result = saveEvents(db, pool, poolTtlMs, normalizeOtelMetrics(body));
        return json(res, 202, result);
      }
      if (req.method === "GET" && url.pathname === "/docs/install") {
        const content = readFileSync(join(process.cwd(), "docs", "INSTALL.md"), "utf8");
        return text(res, 200, content, "text/markdown; charset=utf-8");
      }
      return json(res, 404, { error: "not_found" });
    } catch (error) {
      // malformed request body → 400（而非 500）
      if (error instanceof SyntaxError) return json(res, 400, { error: "invalid_json" });
      return json(res, 500, { error: error.message });
    }
  });

  server.cultivagent = { db, pool };
  return server;
}

function normalizeInputEvents(body) {
  const events = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : [body];
  return events.map((event) => normalizeEvent(event));
}

function saveEvents(db, pool, poolTtlMs, events) {
  cleanupPool(pool);
  let inserted = 0;
  let duplicate = 0;
  for (const event of events) {
    pool.set(event.event_id, { event, expires_at: Date.now() + poolTtlMs });
    if (insertEvent(db, event)) inserted += 1;
    else duplicate += 1;
  }
  return { ok: true, inserted, duplicate, pool_size: pool.size };
}

function cleanupPool(pool) {
  const now = Date.now();
  for (const [id, item] of pool) {
    if (item.expires_at <= now) pool.delete(id);
  }
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
    now: dateParam(params.get("now")),
  };
}

function dateParam(value) {
  if (!value) return undefined;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric * 1000) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function emptyToUndefined(value) {
  return value == null || value === "" || value === "all" ? undefined : value;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function text(res, status, body, type) {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

function html(res, body) {
  text(res, 200, body, "text/html; charset=utf-8");
}

function dashboardHtml() {
  return readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");
}

function dayParam(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : undefined;
}

function dysonHtml() {
  return readFileSync(new URL("./games/dyson.html", import.meta.url), "utf8");
}
