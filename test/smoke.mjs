import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createCultivagentServer } from "../src/server.mjs";
import { normalizeEvent, normalizeOtelLogs, translateLoopEvent } from "../src/normalize.mjs";
import { collectSessionEventsFromFile } from "../plugins/codex/scripts/session-collector.mjs";
import { baseEvent as claudeBaseEvent } from "../plugins/claude-code/scripts/lib.mjs";

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
  assert.equal(requestStats.summary.users, 2);
  const hookRequest = requestStats.requests.find((x) => x.event_id === "smoke-hook-1");
  assert.equal(hookRequest.agent, "codex");
  assert.equal(hookRequest.time, "2026-07-01T00:01:00.000Z");
  assert.equal(hookRequest.username, "test-machine");
  assert.equal(hookRequest.machine, "test-machine");
  assert.equal(hookRequest.hook_type, "PreToolUse");
  assert.equal(requestStats.by_username.find((x) => x.username === "test-machine").count, 2);
  assert.equal(requestStats.by_hook_type.find((x) => x.hook_type === "PreToolUse").count, 1);

  const userRequestStats = await get(`${base}/api/request-stats?username=test-machine&limit=20`);
  assert.equal(userRequestStats.summary.total_requests, 2);
  assert.equal(userRequestStats.summary.users, 1);

  const usageSummary = await get(`${base}/api/usage/summary`);
  assert.equal(usageSummary.summary.total_requests, 2);
  assert.equal(usageSummary.summary.total_input_tokens, 17);
  assert.equal(usageSummary.summary.total_output_tokens, 5);
  assert.equal(usageSummary.summary.total_cache_read_tokens, 5);
  assert.equal(usageSummary.summary.real_total_tokens, 27);
  assert.equal("total_cost" in usageSummary.summary, false);

  const codexProviderUsage = await get(`${base}/api/usage/summary?provider=codex`);
  assert.equal(codexProviderUsage.summary.total_requests, 1);
  const codexUserUsage = await get(`${base}/api/usage/summary?username=test-machine`);
  assert.equal(codexUserUsage.summary.total_requests, 1);

  const usageLogs = await get(`${base}/api/usage/logs?pageSize=10`);
  assert.equal(usageLogs.total, 2);
  assert.equal(usageLogs.logs.some((x) => x.event_id === "smoke-hook-1"), false);
  assert.equal(usageLogs.logs.find((x) => x.event_id === "smoke-1").username, "test-machine");

  assert.equal(translateLoopEvent("claude-code", "PreToolUse").loop_event, "tool.before");
  assert.equal(translateLoopEvent("pi", "before_provider_request").agent_status, "thinking");
  assert.equal(translateLoopEvent("openclaw", "subagent_spawned").agent_status, "delegating");
  const openClawUsage = normalizeEvent({
    source_agent: "openclaw",
    event_type: "llm_output",
    usage: { input: 4, output: 2, cacheRead: 3, cacheWrite: 1 },
  }).usage;
  assert.equal(openClawUsage.input_tokens, 4);
  assert.equal(openClawUsage.output_tokens, 2);
  assert.equal(openClawUsage.cache_read_tokens, 3);
  assert.equal(openClawUsage.cache_write_tokens, 1);
  assert.equal(openClawUsage.total_tokens, 10);
  assert.equal(normalizeEvent({ meta: { machine_name: "HOST" } }).username, "HOST");
  assert.equal(normalizeEvent({ username: "desk", meta: { machine_name: "HOST" } }).username, "desk");
  const explicitOtelUser = normalizeOtelLogs(otelLogFixture([
    ["service.name", "claude-code"],
    ["cultivagent.username", "desk"],
    ["cultivagent.machine_name", "HOST"],
    ["host.name", "localhost"],
  ]))[0];
  assert.equal(explicitOtelUser.username, "desk");
  assert.equal(explicitOtelUser.meta.machine_name, "HOST");
  const missingOtelUser = normalizeOtelLogs(otelLogFixture([
    ["service.name", "claude-code"],
    ["host.name", "localhost"],
  ]))[0];
  assert.equal(missingOtelUser.username, "unknown");
  assert.equal(missingOtelUser.meta.machine_name, "localhost");

  const codexSessionPath = join(dir, "codex-session.jsonl");
  writeFileSync(codexSessionPath, [
    JSON.stringify({
      timestamp: "2026-07-01T00:03:00.000Z",
      type: "session_meta",
      payload: { session_id: "codex-session-1", cwd: "/tmp/project", source: "exec", model_provider: "openai", cli_version: "0.142.0" },
    }),
    JSON.stringify({
      timestamp: "2026-07-01T00:03:01.000Z",
      type: "turn_context",
      payload: { turn_id: "turn-1", cwd: "/tmp/project", model: "gpt-5.5" },
    }),
    JSON.stringify({
      timestamp: "2026-07-01T00:03:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, total_tokens: 12 } },
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-01T00:03:03.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-1", duration_ms: 123, time_to_first_token_ms: 45 },
    }),
  ].join("\n") + "\n");
  const codexSessionEvents = collectSessionEventsFromFile(codexSessionPath, { machineName: "HOST", username: "desk" });
  assert.equal(codexSessionEvents.length, 1);
  assert.equal(codexSessionEvents[0].source_surface, "session_collector");
  assert.equal(codexSessionEvents[0].username, "desk");
  assert.equal(codexSessionEvents[0].usage.input_tokens, 6);
  assert.equal(codexSessionEvents[0].usage.cache_read_tokens, 4);
  assert.equal(codexSessionEvents[0].usage.output_tokens, 2);
  assert.equal(codexSessionEvents[0].duration_ms, 123);

  // plugin hooks.json 合法性（取代已移除的 generate-hook-config 测试）
  const claudeHooks = JSON.parse(readFileSync(new URL("../plugins/claude-code/hooks/hooks.json", import.meta.url), "utf8"));
  assert.ok(claudeHooks.hooks.SessionStart, "claude-code hooks.json missing SessionStart");
  assert.ok(claudeHooks.hooks.SessionEnd, "claude-code hooks.json missing SessionEnd");
  assert.ok(claudeHooks.hooks.PreToolUse, "claude-code hooks.json missing PreToolUse");
  assert.ok(claudeHooks.hooks.PostToolUse, "claude-code hooks.json missing PostToolUse");
  assert.ok(claudeHooks.hooks.MessageDisplay, "claude-code hooks.json missing MessageDisplay");
  assert.match(claudeHooks.hooks.SessionStart[0].hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  const claudeToolEvent = claudeBaseEvent("claude-code", {
    hook_event_name: "PostToolUse",
    cwd: "D:/repo",
    session_id: "claude-s1",
    tool_name: "Bash",
    tool_use_id: "tool-1",
    tool_input: { command: "echo hi" },
    tool_response: { stdout: "hi" },
    duration_ms: 42,
  });
  assert.equal(claudeToolEvent.event_type, "PostToolUse");
  assert.equal(claudeToolEvent.duration_ms, 42);
  assert.equal(claudeToolEvent.meta.tool_name, "Bash");
  assert.match(claudeToolEvent.meta.tool_input_preview, /echo hi/);
  const codexHooks = JSON.parse(readFileSync(new URL("../plugins/codex/hooks/hooks.json", import.meta.url), "utf8"));
  assert.ok(codexHooks.hooks.Stop, "codex hooks.json missing Stop");
  assert.match(codexHooks.hooks.Stop[0].hooks[0].command, /__CULTIVAGENT_PLUGIN_ROOT__/);

  const agents = await get(`${base}/api/agents`);
  assert.equal(agents.agents.length, 2);

  const dashboard = await text(`${base}/`);
  assert.match(dashboard, /id="lang"/);
  assert.match(dashboard, /id="usernameSelect"/);
  assert.match(dashboard, /OpenClaw/);
  assert.match(dashboard, /data-i18n="hookType"/);
  assert.match(dashboard, /data-i18n="machine"/);
  assert.match(dashboard, /data-i18n="user"/);
  assert.match(dashboard, /使用统计/);
  assert.match(dashboard, /请求统计/);

  const events = await get(`${base}/api/events?limit=20`);
  const otelEvent = events.events.find((x) => x.source_surface === "otel");
  assert.notEqual(otelEvent.host_id, "local");
  assert.equal(otelEvent.meta.machine_name, hostname());

  const rangedEvents = await get(`${base}/api/events?start=2026-07-01T00:00:30.000Z&end=2026-07-01T00:01:30.000Z&limit=20`);
  assert.equal(rangedEvents.events.some((x) => x.event_id === "smoke-hook-1"), true);
  assert.equal(rangedEvents.events.some((x) => x.event_id === "smoke-1"), false);
  const incrementalEvents = await get(`${base}/api/events?since=2026-07-01T00:00:30.000Z&limit=20`);
  assert.equal(incrementalEvents.events.some((x) => x.event_id === "smoke-hook-1"), true);
  assert.equal(incrementalEvents.events.some((x) => x.event_id === "smoke-1"), false);

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

function otelLogFixture(resourceAttrs) {
  return {
    resourceLogs: [{
      resource: {
        attributes: resourceAttrs.map(([key, value]) => ({ key, value: { stringValue: value } })),
      },
      scopeLogs: [{
        logRecords: [{
          body: { stringValue: "api_request" },
          attributes: [{ key: "event.name", value: { stringValue: "api_request" } }],
        }],
      }],
    }],
  };
}
