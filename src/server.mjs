import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, insertEvent, listAgents, listDaily, listEvents, resetDatabase } from "./db.mjs";
import { normalizeEvent, normalizeOtelLogs, normalizeOtelMetrics } from "./normalize.mjs";

export function createCultivagentServer(options = {}) {
  const db = options.db ?? openDatabase(options.dbPath);
  const pool = new Map();
  const poolTtlMs = options.poolTtlMs ?? 10 * 60 * 1000;
  const token = options.token ?? "";

  const server = createServer(async (req, res) => {
    try {
      if (token && isWrite(req) && !isAuthorized(req, token)) {
        return json(res, 401, { error: "unauthorized" });
      }

      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/") return html(res, dashboardHtml());
      if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/api/events") {
        return json(res, 200, { events: listEvents(db, url.searchParams.get("limit")) });
      }
      if (req.method === "GET" && url.pathname === "/api/daily") {
        return json(res, 200, { daily: listDaily(db, url.searchParams.get("day")) });
      }
      if (req.method === "GET" && url.pathname === "/api/agents") return json(res, 200, { agents: listAgents(db) });
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

function isWrite(req) {
  return req.method !== "GET" && req.method !== "HEAD";
}

function isAuthorized(req, token) {
  return req.headers.authorization === `Bearer ${token}` || req.headers["x-cultivagent-token"] === token;
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
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cultivagent</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, Segoe UI, Arial, sans-serif; }
    body { margin: 0; background: #f6f7f2; color: #1f2420; }
    header { display: flex; justify-content: space-between; align-items: center; padding: 20px 24px; border-bottom: 1px solid #d8ddcf; background: #fbfcf7; }
    h1 { margin: 0; font-size: 22px; letter-spacing: 0; }
    main { padding: 20px 24px; display: grid; gap: 18px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .stat, section { background: #ffffff; border: 1px solid #d8ddcf; border-radius: 8px; padding: 14px; }
    .label { color: #66705f; font-size: 12px; text-transform: uppercase; }
    .value { font-size: 26px; font-weight: 700; margin-top: 6px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; border-bottom: 1px solid #e5e8df; padding: 8px; vertical-align: top; }
    th { color: #66705f; font-weight: 600; }
    .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
    @media (prefers-color-scheme: dark) {
      body { background: #171a18; color: #eef1e8; }
      header, .stat, section { background: #20251f; border-color: #384033; }
      th, td { border-color: #343b31; }
      .label, th { color: #aab4a1; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Cultivagent</h1>
    <div id="health">connecting</div>
  </header>
  <main>
    <div class="stats">
      <div class="stat"><div class="label">Today Tokens</div><div class="value" id="tokens">0</div></div>
      <div class="stat"><div class="label">Events</div><div class="value" id="events">0</div></div>
      <div class="stat"><div class="label">Agents</div><div class="value" id="agents">0</div></div>
      <div class="stat"><div class="label">Pool</div><div class="value" id="pool">0</div></div>
    </div>
    <div class="grid">
      <section>
        <h2>Agent State</h2>
        <table><thead><tr><th>Agent</th><th>Status</th><th>Session</th><th>Last Event</th></tr></thead><tbody id="agentRows"></tbody></table>
      </section>
      <section>
        <h2>Daily Usage</h2>
        <table><thead><tr><th>Day</th><th>Agent</th><th>Model</th><th>Tokens</th></tr></thead><tbody id="dailyRows"></tbody></table>
      </section>
    </div>
    <section>
      <h2>Recent Events</h2>
      <table><thead><tr><th>Time</th><th>Agent</th><th>Type</th><th>Model</th><th>Tokens</th></tr></thead><tbody id="eventRows"></tbody></table>
    </section>
  </main>
  <script>
    const fmt = new Intl.NumberFormat();
    async function get(path) { const r = await fetch(path); return r.json(); }
    async function refresh() {
      const [health, events, daily, agents, pool] = await Promise.all([
        get('/api/health'), get('/api/events?limit=50'), get('/api/daily'), get('/api/agents'), get('/api/pool')
      ]);
      document.getElementById('health').textContent = health.ok ? 'online' : 'offline';
      document.getElementById('events').textContent = fmt.format(events.events.length);
      document.getElementById('agents').textContent = fmt.format(agents.agents.length);
      document.getElementById('pool').textContent = fmt.format(pool.events.length);
      const today = new Date().toISOString().slice(0, 10);
      const todayTokens = daily.daily.filter(x => x.day === today).reduce((sum, x) => sum + Number(x.total_tokens || 0), 0);
      document.getElementById('tokens').textContent = fmt.format(todayTokens);
      rows('eventRows', events.events, e => [e.occurred_at, e.source_agent, e.event_type, e.model, fmt.format(e.usage.total_tokens || 0)]);
      rows('dailyRows', daily.daily, d => [d.day, d.source_agent, d.model, fmt.format(d.total_tokens || 0)]);
      rows('agentRows', agents.agents, a => [a.source_agent, a.status, a.session_id, a.last_event_at]);
    }
    function rows(id, list, map) {
      document.getElementById(id).innerHTML = list.map(item => '<tr>' + map(item).map(cell => '<td>' + esc(String(cell ?? '')) + '</td>').join('') + '</tr>').join('');
    }
    function esc(s) { return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}
