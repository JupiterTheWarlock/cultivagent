import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createCultivagentServer } from "../src/server.mjs";
import { translateLoopEvent } from "../src/normalize.mjs";

const dir = mkdtempSync(join(tmpdir(), "cultivagent-"));
const dbPath = join(dir, "test.sqlite");
const server = createCultivagentServer({ dbPath, poolTtlMs: 100 });

try {
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;

  await post(`${base}/ingest`, {
    event_id: "smoke-1",
    source_agent: "codex",
    source_surface: "test",
    event_type: "model_response",
    occurred_at: "2026-07-01T00:00:00.000Z",
    host_id: "test-host",
    session_id: "s1",
    model: "gpt-test",
    usage: { input_tokens: 10, output_tokens: 3 },
    meta: { machine_name: "test-machine" },
  });
  await post(`${base}/ingest`, {
    event_id: "smoke-1",
    source_agent: "codex",
    source_surface: "test",
    event_type: "model_response",
    occurred_at: "2026-07-01T00:00:00.000Z",
    host_id: "test-host",
    session_id: "s1",
    model: "gpt-test",
    usage: { input_tokens: 10, output_tokens: 3 },
    meta: { machine_name: "test-machine" },
  });
  await post(`${base}/ingest`, {
    event_id: "smoke-hook-1",
    source_agent: "codex",
    source_surface: "test",
    event_type: "PreToolUse",
    occurred_at: "2026-07-01T00:01:00.000Z",
    host_id: "test-host",
    session_id: "s1",
    meta: { machine_name: "test-machine" },
  });
  await post(`${base}/otel/v1/metrics`, {
    resourceMetrics: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
      scopeMetrics: [{
        metrics: [{
          name: "claude_code.token.usage",
          sum: { dataPoints: [
            { asInt: "7", timeUnixNano: "1782864000000000000", attributes: [{ key: "model", value: { stringValue: "claude-test" } }, { key: "type", value: { stringValue: "input" } }] },
            { asInt: "2", timeUnixNano: "1782864000000000000", attributes: [{ key: "model", value: { stringValue: "claude-test" } }, { key: "type", value: { stringValue: "output" } }] },
            { asInt: "5", timeUnixNano: "1782864000000000000", attributes: [{ key: "model", value: { stringValue: "claude-test" } }, { key: "type", value: { stringValue: "cacheRead" } }] },
          ] },
        }],
      }],
    }],
  });
  await post(`${base}/otel/v1/logs`, {
    resourceLogs: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
      scopeLogs: [{
        logRecords: [{
          timeUnixNano: "1782864000000000000",
          body: { stringValue: "api_request" },
          attributes: [
            { key: "event.name", value: { stringValue: "api_request" } },
            { key: "model", value: { stringValue: "claude-test" } },
            { key: "input_tokens", value: { intValue: "7" } },
            { key: "output_tokens", value: { intValue: "2" } },
            { key: "cache_read_tokens", value: { intValue: "5" } },
            { key: "cost_usd", value: { doubleValue: 0.01 } },
          ],
        }],
      }],
    }],
  });

  const daily = await get(`${base}/api/daily`);
  const codex = daily.daily.find((x) => x.source_agent === "codex");
  const claude = daily.daily.find((x) => x.source_agent === "claude-code");
  assert.equal(codex.total_tokens, 13);
  assert.equal(codex.event_count, 1);
  assert.equal(claude.input_tokens, 7);
  assert.equal(claude.output_tokens, 2);
  assert.equal(claude.cache_read_tokens, 5);
  assert.equal(claude.total_tokens, 14);
  assert.equal(claude.event_count, 1);

  const requestStats = await get(`${base}/api/request-stats?limit=20`);
  assert.equal(requestStats.summary.total_requests, 6);
  const hookRequest = requestStats.requests.find((x) => x.event_id === "smoke-hook-1");
  assert.equal(hookRequest.agent, "codex");
  assert.equal(hookRequest.time, "2026-07-01T00:01:00.000Z");
  assert.equal(hookRequest.machine, "test-machine");
  assert.equal(hookRequest.hook_type, "PreToolUse");
  assert.equal(requestStats.by_hook_type.find((x) => x.hook_type === "PreToolUse").count, 1);

  const usageSummary = await get(`${base}/api/usage/summary`);
  assert.equal(usageSummary.summary.total_requests, 2);
  assert.equal(usageSummary.summary.total_input_tokens, 17);
  assert.equal(usageSummary.summary.total_output_tokens, 5);
  assert.equal(usageSummary.summary.total_cache_read_tokens, 5);
  assert.equal(usageSummary.summary.real_total_tokens, 27);
  assert.equal("total_cost" in usageSummary.summary, false);

  const codexProviderUsage = await get(`${base}/api/usage/summary?provider=codex`);
  assert.equal(codexProviderUsage.summary.total_requests, 1);

  const usageLogs = await get(`${base}/api/usage/logs?pageSize=10`);
  assert.equal(usageLogs.total, 2);
  assert.equal(usageLogs.logs.some((x) => x.event_id === "smoke-hook-1"), false);

  assert.equal(translateLoopEvent("claude-code", "PreToolUse").loop_event, "tool.before");
  assert.equal(translateLoopEvent("pi", "before_provider_request").agent_status, "thinking");
  assert.equal(translateLoopEvent("openclaw", "subagent_spawned").agent_status, "delegating");

  const codexHooks = generatedHooks("codex");
  assert.equal(codexHooks.hooks.PreToolUse[0].hooks[0].command.includes("PreToolUse"), true);
  const claudeHooks = generatedHooks("claude");
  assert.equal(claudeHooks.hooks.MessageDisplay[0].hooks[0].command.includes("MessageDisplay"), true);

  const agents = await get(`${base}/api/agents`);
  assert.equal(agents.agents.length, 2);

  const dashboard = await text(`${base}/`);
  assert.match(dashboard, /id="lang"/);
  assert.match(dashboard, /data-i18n="hookType"/);
  assert.match(dashboard, /data-i18n="machine"/);
  assert.match(dashboard, /使用统计/);
  assert.match(dashboard, /请求统计/);

  const events = await get(`${base}/api/events?limit=20`);
  const otelEvent = events.events.find((x) => x.source_surface === "otel");
  assert.notEqual(otelEvent.host_id, "local");
  assert.equal(otelEvent.meta.machine_name, hostname());

  await new Promise((resolve) => setTimeout(resolve, 140));
  const pool = await get(`${base}/api/pool`);
  assert.equal(pool.events.length, 0);

  console.log("smoke ok");
} finally {
  await close(server);
  server.cultivagent.db.close();
  rmSync(dir, { recursive: true, force: true });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}

async function get(url) {
  const response = await fetch(url);
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}

async function text(url) {
  const response = await fetch(url);
  if (!response.ok) assert.fail(await response.text());
  return response.text();
}

function generatedHooks(agent) {
  const result = spawnSync(process.execPath, ["./scripts/generate-hook-config.mjs", agent, process.cwd()], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
