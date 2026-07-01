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
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, Segoe UI, Arial, sans-serif; background: #17181c; color: #f4f6fb; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; background: #17181c; color: #f4f6fb; }
    main { width: min(1180px, 100%); margin: 0 auto; padding: 20px 20px 32px; display: grid; gap: 20px; }
    header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 26px; line-height: 1.15; }
    h2 { font-size: 19px; }
    .muted { color: #969aa6; }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    select, button { height: 40px; border-radius: 8px; border: 1px solid #343844; background: #1e2027; color: #f4f6fb; padding: 0 12px; font-weight: 700; }
    button.active { background: #0f7bf2; border-color: #0f7bf2; }
    .panel { background: #1f2026; border: 1px solid #30323a; border-radius: 8px; padding: 20px; box-shadow: 0 0 0 1px rgba(255,255,255,0.01) inset; }
    .hero { display: grid; grid-template-columns: 1fr 176px; gap: 20px; align-items: center; }
    .total { display: flex; align-items: center; gap: 14px; min-width: 0; }
    .bolt { width: 42px; height: 42px; border-radius: 14px; display: grid; place-items: center; color: #1b8dff; background: #123052; font-size: 22px; font-weight: 900; }
    .metric-label { color: #9ca0aa; font-size: 12px; font-weight: 800; }
    .big { font-size: clamp(32px, 5vw, 58px); line-height: 1; font-weight: 900; overflow-wrap: anywhere; }
    .summary { border: 1px solid #2d3038; border-radius: 8px; padding: 14px; display: grid; gap: 8px; }
    .summary strong { color: #00d084; }
    .cards { display: grid; grid-template-columns: repeat(5, minmax(130px, 1fr)); gap: 12px; margin-top: 18px; }
    .card { border: 1px solid #2d3038; border-radius: 8px; padding: 14px; min-height: 78px; }
    .card .value { margin-top: 8px; font-size: 19px; font-weight: 900; overflow-wrap: anywhere; }
    .chart-head, .tabs { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
    svg { width: 100%; height: 300px; display: block; overflow: visible; }
    .axis { stroke: #2e3139; stroke-dasharray: 3 4; }
    .tick, .legend { fill: #9ca0aa; font-size: 12px; }
    .line { fill: none; stroke-width: 2.2; }
    .input { stroke: #1b8dff; color: #1b8dff; }
    .output { stroke: #00d084; color: #00d084; }
    .cache { stroke: #ff8a1f; color: #ff8a1f; }
    .total-line { stroke: #a066ff; color: #a066ff; }
    .filters { border: 1px solid #8f94a3; border-radius: 8px; padding: 10px; display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
    .table-wrap { overflow-x: auto; border: 1px solid #30323a; border-radius: 8px; }
    table { width: 100%; min-width: 860px; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; border-bottom: 1px solid #30323a; padding: 16px 18px; vertical-align: middle; white-space: nowrap; }
    th { color: #989ca8; font-size: 13px; font-weight: 800; }
    tr:last-child td { border-bottom: 0; }
    .ok { color: #00d084; font-weight: 800; }
    .bad { color: #ff5f70; font-weight: 800; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .pill { display: inline-flex; align-items: center; height: 26px; padding: 0 9px; border-radius: 8px; background: #252831; color: #cfd3dd; }
    @media (max-width: 820px) {
      main { padding: 16px 12px 24px; }
      .hero { grid-template-columns: 1fr; }
      .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      th, td { padding: 12px; }
      svg { height: 250px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1 data-i18n="title">使用统计</h1>
        <div class="muted" data-i18n="subtitle">查看 AI 模型的使用情况和成本统计</div>
      </div>
      <div class="toolbar">
        <select id="lang">
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
        <select id="sourceFilter"></select>
        <select id="modelFilter"></select>
        <select id="rangeFilter">
          <option value="today" data-i18n="today">当天</option>
          <option value="all" data-i18n="allTime">全部</option>
        </select>
        <button id="refresh">30s</button>
      </div>
    </header>

    <section class="panel">
      <div class="hero">
        <div class="total">
          <div class="bolt">↯</div>
          <div>
            <div class="metric-label" data-i18n="realTokens">真实消耗 Tokens</div>
            <div class="big" id="totalTokens">0</div>
          </div>
        </div>
        <div class="summary">
          <span class="metric-label" data-i18n="requests">总请求数</span>
          <strong id="requestCount">0</strong>
          <span class="metric-label" data-i18n="totalCost">总成本</span>
          <strong id="totalCost">$0.0000</strong>
        </div>
      </div>
      <div class="cards">
        <div class="card"><div class="metric-label" data-i18n="input">新增输入</div><div class="value" id="inputTokens">0</div></div>
        <div class="card"><div class="metric-label" data-i18n="output">Output</div><div class="value" id="outputTokens">0</div></div>
        <div class="card"><div class="metric-label" data-i18n="cacheCreate">创建</div><div class="value" id="cacheWrite">0</div></div>
        <div class="card"><div class="metric-label" data-i18n="cacheHit">命中</div><div class="value" id="cacheRead">0</div></div>
        <div class="card"><div class="metric-label" data-i18n="activeAgents">活跃 Agent</div><div class="value" id="agentCount">0</div></div>
      </div>
    </section>

    <section class="panel">
      <div class="chart-head">
        <h2 data-i18n="trend">使用趋势</h2>
        <div class="legend">● <span class="total-line" data-i18n="total">总量</span>　● <span class="input" data-i18n="inputShort">输入</span>　● <span class="output" data-i18n="outputShort">输出</span>　● <span class="cache" data-i18n="cacheShort">缓存</span></div>
      </div>
      <svg id="chart" viewBox="0 0 1000 300" role="img" aria-label="usage trend"></svg>
    </section>

    <section class="panel">
      <div class="tabs">
        <button class="active" data-i18n="requestLog">请求日志</button>
        <span class="muted" id="health">connecting</span>
      </div>
      <div class="filters">
        <select id="statusFilter">
          <option value="" data-i18n="allStatus">全部状态</option>
          <option value="ok">ok</option>
          <option value="error">error</option>
        </select>
        <select id="hookFilter"></select>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th data-i18n="time">时间</th>
            <th>Agent</th>
            <th data-i18n="machine">机器名</th>
            <th data-i18n="model">模型</th>
            <th data-i18n="status">状态</th>
            <th data-i18n="hookType">Hook 类型</th>
            <th>Tokens</th>
          </tr></thead>
          <tbody id="eventRows"></tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const i18n = {
      zh: {
        title: '使用统计', subtitle: '查看 AI 模型的使用情况和成本统计', realTokens: '真实消耗 Tokens',
        requests: '总请求数', totalCost: '总成本', input: '新增输入', output: 'Output', cacheCreate: '创建',
        cacheHit: '命中', activeAgents: '活跃 Agent', trend: '使用趋势', total: '总量', inputShort: '输入',
        outputShort: '输出', cacheShort: '缓存', requestLog: '请求日志', time: '时间', machine: '机器名',
        model: '模型', status: '状态', hookType: 'Hook 类型', allSources: '全部来源', allModels: '全部模型',
        allHooks: '全部 Hook', allStatus: '全部状态', today: '当天', allTime: '全部', online: 'online', offline: 'offline'
      },
      en: {
        title: 'Usage Stats', subtitle: 'Monitor AI model usage and cost', realTokens: 'Actual Tokens',
        requests: 'Requests', totalCost: 'Total Cost', input: 'Input', output: 'Output', cacheCreate: 'Cache Write',
        cacheHit: 'Cache Hit', activeAgents: 'Active Agents', trend: 'Usage Trend', total: 'Total', inputShort: 'Input',
        outputShort: 'Output', cacheShort: 'Cache', requestLog: 'Request Log', time: 'Time', machine: 'Machine',
        model: 'Model', status: 'Status', hookType: 'Hook Type', allSources: 'All Sources', allModels: 'All Models',
        allHooks: 'All Hooks', allStatus: 'All Status', today: 'Today', allTime: 'All Time', online: 'online', offline: 'offline'
      }
    };
    let state = { events: [], agents: [], lang: localStorage.getItem('cultivagent_lang') || 'zh' };
    const fmt = () => new Intl.NumberFormat(state.lang === 'zh' ? 'zh-CN' : 'en-US');
    async function get(path) { const r = await fetch(path); return r.json(); }
    async function refresh() {
      const [health, events, agents] = await Promise.all([
        get('/api/health'), get('/api/events?limit=500'), get('/api/agents')
      ]);
      state.events = events.events || [];
      state.agents = agents.agents || [];
      document.getElementById('health').textContent = health.ok ? t('online') : t('offline');
      fillFilters();
      render();
    }
    function render() {
      translate();
      const rows = filteredEvents();
      const totals = rows.reduce((sum, e) => {
        const u = e.usage || {};
        sum.input += Number(u.input_tokens || 0);
        sum.output += Number(u.output_tokens || 0);
        sum.cacheRead += Number(u.cache_read_tokens || 0);
        sum.cacheWrite += Number(u.cache_write_tokens || 0);
        sum.total += Number(u.total_tokens || 0);
        sum.cost += Number(u.cost_usd || 0);
        return sum;
      }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
      const nf = fmt();
      document.getElementById('totalTokens').textContent = nf.format(totals.total);
      document.getElementById('requestCount').textContent = nf.format(rows.length);
      document.getElementById('totalCost').textContent = '$' + totals.cost.toFixed(4);
      document.getElementById('inputTokens').textContent = nf.format(totals.input);
      document.getElementById('outputTokens').textContent = nf.format(totals.output);
      document.getElementById('cacheWrite').textContent = nf.format(totals.cacheWrite);
      document.getElementById('cacheRead').textContent = nf.format(totals.cacheRead);
      document.getElementById('agentCount').textContent = nf.format(state.agents.length);
      drawChart(rows);
      document.getElementById('eventRows').innerHTML = rows.slice(0, 100).map(eventRow).join('');
    }
    function eventRow(e) {
      const machine = e.meta?.machine_name || e.host_id || '';
      const status = e.status || '';
      const statusClass = status === 'ok' || status === '200' ? 'ok' : status === 'error' ? 'bad' : '';
      return '<tr><td>' + esc(timeLabel(e.occurred_at)) + '</td><td><b>' + esc(e.source_agent) + '</b></td><td>' +
        esc(machine) + '</td><td class="mono">' + esc(e.model || 'unknown') + '</td><td class="' + statusClass + '">' +
        esc(status) + '</td><td><span class="pill">' + esc(e.event_type) + '</span></td><td>' +
        fmt().format(Number(e.usage?.total_tokens || 0)) + '</td></tr>';
    }
    function filteredEvents() {
      const source = document.getElementById('sourceFilter').value;
      const model = document.getElementById('modelFilter').value;
      const hook = document.getElementById('hookFilter').value;
      const status = document.getElementById('statusFilter').value;
      const today = new Date().toISOString().slice(0, 10);
      return state.events.filter(e =>
        (!source || e.source_agent === source) &&
        (!model || e.model === model) &&
        (!hook || e.event_type === hook) &&
        (!status || e.status === status) &&
        (document.getElementById('rangeFilter').value !== 'today' || String(e.occurred_at).startsWith(today))
      );
    }
    function fillFilters() {
      setOptions('sourceFilter', t('allSources'), unique(state.events.map(e => e.source_agent)));
      setOptions('modelFilter', t('allModels'), unique(state.events.map(e => e.model).filter(Boolean)));
      setOptions('hookFilter', t('allHooks'), unique(state.events.map(e => e.event_type)));
    }
    function setOptions(id, label, values) {
      const el = document.getElementById(id);
      const old = el.value;
      el.innerHTML = '<option value="">' + esc(label) + '</option>' + values.map(v => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('');
      el.value = values.includes(old) ? old : '';
    }
    function drawChart(events) {
      const svg = document.getElementById('chart');
      const buckets = bucket(events);
      const max = Math.max(1, ...buckets.flatMap(b => [b.total, b.input, b.output, b.cache]));
      const plot = (key, cls) => '<path class="line ' + cls + '" d="' + buckets.map((b, i) => point(i, b[key], buckets.length, max)).join(' ') + '"/>';
      svg.innerHTML = grid(max) + plot('total', 'total-line') + plot('input', 'input') + plot('output', 'output') + plot('cache', 'cache') +
        buckets.map((b, i) => i % Math.ceil(buckets.length / 6) === 0 ? '<text class="tick" x="' + (70 + i * (860 / Math.max(1, buckets.length - 1))) + '" y="292" text-anchor="middle">' + esc(b.label) + '</text>' : '').join('');
    }
    function bucket(events) {
      const map = new Map();
      for (const e of events) {
        const d = new Date(e.occurred_at);
        if (!Number.isFinite(d.getTime())) continue;
        d.setMinutes(0, 0, 0);
        const key = d.toISOString();
        const row = map.get(key) || { label: timeLabel(key).slice(0, 11), input: 0, output: 0, cache: 0, total: 0 };
        const u = e.usage || {};
        row.input += Number(u.input_tokens || 0);
        row.output += Number(u.output_tokens || 0);
        row.cache += Number(u.cache_read_tokens || 0) + Number(u.cache_write_tokens || 0);
        row.total += Number(u.total_tokens || 0);
        map.set(key, row);
      }
      const rows = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(x => x[1]);
      return rows.length ? rows : [{ label: '', input: 0, output: 0, cache: 0, total: 0 }];
    }
    function point(i, value, count, max) {
      const x = 70 + i * (860 / Math.max(1, count - 1));
      const y = 252 - (Number(value || 0) / max) * 205;
      return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    function grid(max) {
      let out = '';
      for (let i = 0; i <= 4; i++) {
        const y = 47 + i * 51;
        out += '<line class="axis" x1="70" y1="' + y + '" x2="930" y2="' + y + '"/><text class="tick" x="60" y="' + (y + 4) + '" text-anchor="end">' + fmt().format(Math.round(max * (4 - i) / 4)) + '</text>';
      }
      return out;
    }
    function translate() {
      document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
      document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
      document.getElementById('lang').value = state.lang;
    }
    function t(key) { return i18n[state.lang][key] || key; }
    function unique(values) { return [...new Set(values)].sort(); }
    function timeLabel(value) {
      const d = new Date(value);
      if (!Number.isFinite(d.getTime())) return value || '';
      return new Intl.DateTimeFormat(state.lang === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    }
    function esc(s) { return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    document.getElementById('lang').addEventListener('change', e => { state.lang = e.target.value; localStorage.setItem('cultivagent_lang', state.lang); fillFilters(); render(); });
    for (const id of ['sourceFilter', 'modelFilter', 'rangeFilter', 'statusFilter', 'hookFilter']) document.getElementById(id).addEventListener('change', render);
    document.getElementById('refresh').addEventListener('click', refresh);
    translate();
    refresh();
    setInterval(refresh, 30000);
  </script>
</body>
</html>`;
}
