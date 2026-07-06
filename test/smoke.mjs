import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCultivagentServer } from "../src/server.mjs";
import { normalizeEvent, normalizeOtelLogs, translateLoopEvent } from "../src/normalize.mjs";
import { collectSessionEventsFromFile } from "../plugins/codex/scripts/session-collector.mjs";
import { collectClaudeSessionEvents } from "../plugins/claude-code/scripts/session-collector.mjs";
import { collectOpenCodeEvents, parseMessageData as parseOpenCodeMessageData } from "../plugins/opencode/session-collector.mjs";
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
  await post(`${base}/ingest`, {
    event_id: "smoke-codex-hook-user",
    source_agent: "codex",
    source_surface: "hook",
    event_type: "UserPromptSubmit",
    occurred_at: "2026-07-01T00:02:00.000Z",
    host_id: "codex-host",
    session_id: "codex-otel-session",
    meta: { username: "desk", machine_name: "codex-machine" },
  });
  await post(`${base}/otel/v1/logs`, {
    resourceLogs: [{
      resource: { attributes: [
        { key: "service.name", value: { stringValue: "codex" } },
        { key: "host.id", value: { stringValue: "codex-host" } },
        { key: "host.name", value: { stringValue: "localhost" } },
      ] },
      scopeLogs: [{
        logRecords: [{
          timeUnixNano: "1782864120000000000",
          body: { stringValue: "codex.sse_event" },
          attributes: [
            { key: "event.name", value: { stringValue: "codex.sse_event" } },
            { key: "sse.event", value: { stringValue: "response.completed" } },
            { key: "session.id", value: { stringValue: "codex-otel-session" } },
            { key: "model", value: { stringValue: "gpt-test" } },
            { key: "input_tokens", value: { intValue: "4" } },
            { key: "output_tokens", value: { intValue: "1" } },
          ],
        }],
      }],
    }],
  });
  await post(`${base}/ingest`, {
    event_id: "smoke-codex-session-dup",
    source_agent: "codex",
    source_surface: "session_collector",
    event_type: "model_response",
    occurred_at: "2026-07-01T00:02:01.000Z",
    host_id: "codex-host",
    session_id: "codex-otel-session",
    model: "gpt-test",
    usage: { input_tokens: 4, output_tokens: 1 },
    meta: { machine_name: "codex-machine" },
  });

  const daily = await get(`${base}/api/daily`);
  const codexRows = daily.daily.filter((x) => x.source_agent === "codex");
  const claude = daily.daily.find((x) => x.source_agent === "claude-code");
  assert.equal(codexRows.reduce((sum, row) => sum + row.total_tokens, 0), 18);
  assert.equal(codexRows.reduce((sum, row) => sum + row.event_count, 0), 2);
  assert.equal(claude.input_tokens, 7);
  assert.equal(claude.output_tokens, 2);
  assert.equal(claude.cache_read_tokens, 5);
  assert.equal(claude.total_tokens, 14);
  assert.equal(claude.event_count, 1);

  const requestStats = await get(`${base}/api/request-stats?limit=20`);
  assert.equal(requestStats.summary.total_requests, 8);
  assert.equal(requestStats.summary.users, 3);
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
  assert.equal(usageSummary.summary.total_requests, 3);
  assert.equal(usageSummary.summary.total_input_tokens, 21);
  assert.equal(usageSummary.summary.total_output_tokens, 6);
  assert.equal(usageSummary.summary.total_cache_read_tokens, 5);
  assert.equal(usageSummary.summary.real_total_tokens, 32);
  assert.equal("total_cost" in usageSummary.summary, false);

  const codexProviderUsage = await get(`${base}/api/usage/summary?provider=codex`);
  assert.equal(codexProviderUsage.summary.total_requests, 2);
  const codexUserUsage = await get(`${base}/api/usage/summary?username=test-machine`);
  assert.equal(codexUserUsage.summary.total_requests, 1);
  const codexCorrelatedUserUsage = await get(`${base}/api/usage/summary?username=desk`);
  assert.equal(codexCorrelatedUserUsage.summary.total_requests, 1);

  const usageLogs = await get(`${base}/api/usage/logs?pageSize=10`);
  assert.equal(usageLogs.total, 3);
  assert.equal(usageLogs.logs.some((x) => x.event_id === "smoke-codex-session-dup"), false);
  assert.equal(usageLogs.logs.some((x) => x.event_id === "smoke-hook-1"), false);
  assert.equal(usageLogs.logs.find((x) => x.event_id === "smoke-1").username, "test-machine");
  assert.equal(usageLogs.logs.find((x) => x.model === "gpt-test" && x.input_tokens === 4).username, "desk");

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
  const openClawSource = readFileSync(new URL("../plugins/openclaw/index.ts", import.meta.url), "utf8");
  for (const needle of ["model_call_ended", "llm_output", "event?.usageState?.lastCallUsage", "event?.result?.meta?.agentMeta?.lastCallUsage", "event?.payload?.meta?.agentMeta?.lastCallUsage"]) {
    assert.match(openClawSource, new RegExp(escapeRegExp(needle)));
  }
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
        info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, total_tokens: 12 } },
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-01T00:03:02.500Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 18, cached_input_tokens: 7, output_tokens: 5, total_tokens: 23 } },
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-01T00:03:03.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-1", duration_ms: 123, time_to_first_token_ms: 45 },
    }),
  ].join("\n") + "\n");
  const codexSessionEvents = collectSessionEventsFromFile(codexSessionPath, { machineName: "HOST", username: "desk" });
  assert.equal(codexSessionEvents.length, 2);
  assert.equal(codexSessionEvents[0].source_surface, "session_collector");
  assert.equal(codexSessionEvents[0].username, "desk");
  assert.equal(codexSessionEvents[0].usage.input_tokens, 6);
  assert.equal(codexSessionEvents[0].usage.cache_read_tokens, 4);
  assert.equal(codexSessionEvents[0].usage.output_tokens, 2);
  assert.equal(codexSessionEvents[0].duration_ms, 123);
  assert.equal(codexSessionEvents[1].usage.input_tokens, 5);
  assert.equal(codexSessionEvents[1].usage.cache_read_tokens, 3);
  assert.equal(codexSessionEvents[1].usage.output_tokens, 3);
  assert.equal(codexSessionEvents[1].duration_ms, 123);

  const claudeRoot = join(dir, "claude-projects");
  const claudeProject = join(claudeRoot, "tmp-project");
  const claudeSubagents = join(claudeProject, "claude-session-1", "subagents");
  const claudeWorkflow = join(claudeSubagents, "workflows", "wf_1");
  mkdirSync(claudeWorkflow, { recursive: true });
  writeFileSync(join(claudeProject, "main.jsonl"), claudeLine("msg_main", 3, 5, 7, 11));
  writeFileSync(join(claudeSubagents, "agent.jsonl"), claudeLine("msg_agent", 2, 1, 13, 0));
  writeFileSync(join(claudeWorkflow, "agent-wf.jsonl"), claudeLine("msg_wf", 1, 0, 17, 19, null));
  const claudeSessionEvents = collectClaudeSessionEvents(claudeRoot, { machineName: "HOST", username: "desk", lookbackMinutes: 0 });
  assert.equal(claudeSessionEvents.length, 3);
  assert.equal(claudeSessionEvents.reduce((sum, event) => sum + event.usage.cache_read_tokens, 0), 37);
  assert.equal(claudeSessionEvents.some((event) => event.turn_id === "msg_wf"), true);

  const opencodeUsage = parseOpenCodeMessageData({
    role: "assistant",
    cost: 0.002,
    tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
    modelID: "deepseek-v4-pro",
    time: { created: 1782864300000, completed: 1782864301000 },
  });
  assert.equal(opencodeUsage.usage.output_tokens, 5);
  assert.equal(opencodeUsage.usage.cache_read_tokens, 4);
  assert.equal(opencodeUsage.usage.cache_write_tokens, 5);

  const opencodeDb = join(dir, "opencode.db");
  const odb = new DatabaseSync(opencodeDb);
  odb.exec("CREATE TABLE session (id TEXT, time_updated INTEGER); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);");
  odb.prepare("INSERT INTO session VALUES (?, ?)").run("opencode-s1", 1782864301000);
  odb.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("m1", "opencode-s1", 1, 2, JSON.stringify({
    role: "assistant",
    tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
    modelID: "deepseek-v4-pro",
    providerID: "deepseek",
    time: { created: 1782864300000, completed: 1782864301000 },
  }));
  odb.close();
  const opencodeEvents = collectOpenCodeEvents(opencodeDb, { machineName: "HOST", username: "desk" });
  assert.equal(opencodeEvents.length, 1);
  assert.equal(opencodeEvents[0].usage.total_tokens, 24);

  // plugin hooks.json 合法性（取代已移除的 generate-hook-config 测试）
  const claudeHooks = JSON.parse(readFileSync(new URL("../plugins/claude-code/hooks/hooks.json", import.meta.url), "utf8"));
  assert.ok(claudeHooks.hooks.SessionStart, "claude-code hooks.json missing SessionStart");
  assert.ok(claudeHooks.hooks.SessionEnd, "claude-code hooks.json missing SessionEnd");
  assert.ok(claudeHooks.hooks.PreToolUse, "claude-code hooks.json missing PreToolUse");
  assert.ok(claudeHooks.hooks.PostToolUse, "claude-code hooks.json missing PostToolUse");
  assert.ok(claudeHooks.hooks.Stop, "claude-code hooks.json missing Stop");
  assert.match(claudeHooks.hooks.SessionStart[0].hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.match(claudeHooks.hooks.Stop[0].hooks[1].command, /session-collector\.mjs/);
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
  assert.equal(codexHooks.hooks.Stop[0].hooks.length, 1);
  assert.match(codexHooks.hooks.Stop[0].hooks[0].command, /__CULTIVAGENT_PLUGIN_ROOT__/);
  const codexHookScript = readFileSync(new URL("../plugins/codex/scripts/hook.mjs", import.meta.url), "utf8");
  assert.match(codexHookScript, /session-collector\.mjs/);
  assert.match(codexHookScript, /--delay-ms/);
  assert.match(codexHookScript, /--include-incomplete/);

  const agents = await get(`${base}/api/agents`);
  assert.equal(agents.agents.length, 3);

  const dashboard = await text(`${base}/`);
  assert.match(dashboard, /id="lang"/);
  assert.match(dashboard, /id="usernameSelect"/);
  assert.match(dashboard, /OpenClaw/);
  assert.match(dashboard, /data-i18n="hookType"/);
  assert.match(dashboard, /data-i18n="machine"/);
  assert.match(dashboard, /data-i18n="user"/);
  assert.match(dashboard, /使用统计/);
  assert.match(dashboard, /请求统计/);
  assert.match(dashboard, /composedPath/);
  assert.match(dashboard, /BACKFILL_OVERLAP_SECONDS/);
  const workerSource = readFileSync(new URL("../worker/index.mjs", import.meta.url), "utf8");
  assert.match(workerSource, /cache-control", "no-store"/);

  const events = await get(`${base}/api/events?limit=20`);
  const otelEvent = events.events.find((x) => x.source_surface === "otel" && x.source_agent === "claude-code");
  assert.notEqual(otelEvent.host_id, "local");
  assert.equal(otelEvent.meta.machine_name, hostname());

  const rangedEvents = await get(`${base}/api/events?start=2026-07-01T00:00:30.000Z&end=2026-07-01T00:01:30.000Z&limit=20`);
  assert.equal(rangedEvents.events.some((x) => x.event_id === "smoke-hook-1"), true);
  assert.equal(rangedEvents.events.some((x) => x.event_id === "smoke-1"), false);
  const compactRangedEvents = await get(`${base}/api/events?start=1782864030&end=1782864090&limit=20&compact=1`);
  assert.equal(compactRangedEvents.events.some((x) => x.event_id === "smoke-hook-1"), true);
  assert.equal(compactRangedEvents.events.some((x) => x.event_id === "smoke-1"), false);
  assert.equal("meta_json" in compactRangedEvents.events[0], false);
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

function claudeLine(id, input, output, cacheRead, cacheWrite, stopReason = "end_turn") {
  return JSON.stringify({
    type: "assistant",
    sessionId: "claude-session-1",
    timestamp: "2026-07-01T00:04:00.000Z",
    message: {
      id,
      model: "claude-test",
      stop_reason: stopReason,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
      },
    },
  }) + "\n";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
