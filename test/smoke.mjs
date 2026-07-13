import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as THREE from "three";
import { createCultivagentServer } from "../src/server.mjs";
import { buildDysonState } from "../src/dyson-state.mjs";
import {
  buildShotTrajectory,
  firstPhaseIsValid,
  parabolaPoint,
  progradeAngle,
  secondPhaseIsValid,
  tangentFor,
} from "../src/games/dyson-trajectory.mjs";
import { normalizeEvent, normalizeOtelLogs, translateLoopEvent } from "../src/normalize.mjs";
import { collectSessionEventsFromFile } from "../plugins/codex/scripts/session-collector.mjs";
import { collectClaudeSessionEvents } from "../plugins/claude-code/scripts/session-collector.mjs";
import { collectOpenCodeEvents, parseMessageData as parseOpenCodeMessageData } from "../plugins/opencode/session-collector.mjs";
import { collectLocusEvents } from "../plugins/locus/session-collector.mjs";
import { baseEvent as claudeBaseEvent } from "../plugins/claude-code/scripts/lib.mjs";

const dir = mkdtempSync(join(tmpdir(), "cultivagent-"));
const dbPath = join(dir, "test.sqlite");
const server = createCultivagentServer({ dbPath, poolTtlMs: 100 });

try {
  verifyDysonTrajectories();
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
  assert.equal(normalizeEvent({ source_agent: "locus" }).source_agent, "locus");
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

  const locusDb = join(dir, "locus.db");
  const ldb = new DatabaseSync(locusDb);
  ldb.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT, agent_id TEXT);
    CREATE TABLE session_runs (run_id TEXT PRIMARY KEY, session_id TEXT, status TEXT, started_at INTEGER, updated_at INTEGER, finished_at INTEGER);
    CREATE TABLE messages (id TEXT, session_id TEXT, role TEXT, content TEXT, created_at INTEGER, metadata_json TEXT);
    CREATE TABLE session_events (session_id TEXT, run_id TEXT, seq INTEGER, event_type TEXT, payload_json TEXT, created_at INTEGER, PRIMARY KEY (session_id, seq));
  `);
  ldb.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("locus-s1", "unity-test", "dev");
  ldb.prepare("INSERT INTO session_runs VALUES (?, ?, ?, ?, ?, ?)").run("locus-r1", "locus-s1", "done", 1782864400, 1782864405, 1782864410);
  ldb.prepare("INSERT INTO session_runs VALUES (?, ?, ?, ?, ?, ?)").run("locus-r2", "locus-s1", "running", 1782864500, 1782864505, null);
  ldb.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)").run("m1", "locus-s1", "assistant", "", 1782864408, JSON.stringify({
    responseRequest: { model: "gpt-5.5" },
  }));
  ldb.prepare("INSERT INTO session_events VALUES (?, ?, ?, ?, ?, ?)").run("locus-s1", "locus-r1", 1, "usageUpdate", JSON.stringify({
    type: "usageUpdate",
    sessionId: "locus-s1",
    inputTokens: 2,
    outputTokens: 3,
    cacheReadTokens: 4,
    cacheWriteTokens: 5,
    totalInputTokens: 20,
    totalOutputTokens: 30,
    totalCacheReadTokens: 40,
    totalCacheWriteTokens: 50,
    contextTokens: 123,
    contextLimit: 456,
  }), 1782864409);
  ldb.prepare("INSERT INTO session_events VALUES (?, ?, ?, ?, ?, ?)").run("locus-s1", "locus-r2", 2, "usageUpdate", JSON.stringify({
    type: "usageUpdate",
    sessionId: "locus-s1",
    inputTokens: 99,
  }), 1782864509);
  ldb.close();
  const locusEvents = collectLocusEvents(locusDb, { machineName: "HOST", username: "desk", lookbackMinutes: 0 });
  assert.equal(locusEvents.length, 1);
  assert.equal(locusEvents[0].source_agent, "locus");
  assert.equal(locusEvents[0].model, "gpt-5.5");
  assert.equal(locusEvents[0].provider, "locus");
  assert.equal(locusEvents[0].usage.total_tokens, 14);
  assert.equal(locusEvents[0].meta.context_tokens, 123);
  assert.equal(collectLocusEvents(locusDb, { includeIncomplete: true, lookbackMinutes: 0 }).length, 2);

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
  assert.match(dashboard, /href="\/dyson"/);
  assert.match(dashboard, /composedPath/);
  assert.match(dashboard, /BACKFILL_OVERLAP_SECONDS/);
  const dyson = await text(`${base}/dyson`);
  assert.match(dyson, /Cultivagent Dyson/);
  assert.match(dyson, /TOKEN_PER_CLOUD = 100/);
  assert.match(dyson, /STRUCTURE_TOKEN_COST = 10_000_000/);
  assert.match(dyson, /dyson-debug/);
  assert.match(dyson, /debugStructureBtn/);
  assert.match(dyson, /\/api\/dyson\/state/);
  assert.match(dyson, /buildSkySphere/);
  assert.match(dyson, /SKY_STAR_COUNT/);
  assert.match(dyson, /skySphere\.position\.copy\(camera\.position\)/);
  assert.match(dyson, /syncSettledClouds/);
  assert.match(dyson, /detail: "1"/);
  assert.match(dyson, /smoothServerClock/);
  assert.match(dyson, /syncServerClock/);
  assert.match(dyson, /syncServiceShots/);
  assert.match(dyson, /buildShotTrajectory/);
  assert.match(dyson, /horizontalOrbitArc/);
  assert.match(dyson, /structureGroup\.rotation\.y = -tamedRotation/);
  assert.match(dyson, /spawnArrivalFlash/);
  assert.doesNotMatch(dyson, /horizontalHermite/);
  assert.match(dyson, /commitCloudPoints/);
  assert.match(dyson, /new THREE\.Timer/);
  assert.doesNotMatch(dyson, /new THREE\.Clock/);
  assert.match(dyson, /emittedAtMs/);
  assert.match(dyson, /resetServiceReplay/);
  assert.match(dyson, /serviceSeeded/);
  assert.match(dyson, /replayClouds/);
  assert.match(dyson, /planetOrbitPosition/);
  assert.match(dyson, /\[30, -30, 20, -20, 10, -10, 0\]/);
  assert.match(dyson, /orbit\.rotation\.x = inclination/);
  assert.doesNotMatch(dyson, /planet\.pivot\.rotation\.y = planet\.baseAngle/);
  assert.doesNotMatch(dyson, /orbit\.rotation\.z =/);
  assert.match(dyson, /color: 0xffffff/);
  assert.match(dyson, /rangeStart/);
  assert.match(dyson, /drawAtmosphere/);
  assert.match(dyson, /buildOrbitGeometry/);
  assert.match(dyson, /STAR_LIGHT_BASE/);
  assert.doesNotMatch(dyson, /serviceShotSignature/);
  assert.doesNotMatch(dyson, /nextCloudTarget/);
  assert.doesNotMatch(dyson, /batchEntry/);
  assert.doesNotMatch(dyson, /state\.visualClouds = Math\.max\(0, Math\.min\(FREE_CLOUD_MAX, Number\(dyson\.totals\?\.settled_clouds/);
  assert.doesNotMatch(dyson, /state\.cameraYaw \+= 0\.0005/);
  await post(`${base}/ingest`, {
    event_id: "dyson-launch-1",
    source_agent: "codex",
    source_surface: "test",
    event_type: "model_response",
    occurred_at: "2026-07-02T00:00:00.000Z",
    host_id: "dyson-host",
    workspace_id: "dyson-workspace",
    session_id: "dyson-session",
    model: "gpt-dyson",
    usage: { input_tokens: 10000 },
    meta: { machine_name: "dyson-machine", agent_status: "done" },
  });
  await post(`${base}/ingest`, {
    event_id: "dyson-status-only",
    source_agent: "opencode",
    source_surface: "test",
    event_type: "PreToolUse",
    occurred_at: "2026-07-02T00:00:02.000Z",
    host_id: "dyson-host-2",
    workspace_id: "dyson-workspace",
    session_id: "dyson-session-2",
    meta: { machine_name: "dyson-machine-2" },
  });
  const dysonCompact = await get(`${base}/api/dyson/state?day=2026-07-02&now=2026-07-02T00:00:05.000Z`);
  assert.equal("batches" in dysonCompact.agents[0], false);
  assert.equal("active_shots" in dysonCompact.agents[0], false);
  const dysonState = await get(`${base}/api/dyson/state?day=2026-07-02&now=2026-07-02T00:00:05.000Z&detail=1`);
  assert.equal(dysonState.totals.tokens, 10000);
  assert.equal(dysonState.totals.clouds, 100);
  assert.equal(dysonState.totals.free_clouds, 100);
  assert.equal(dysonState.totals.settled_clouds, 0);
  assert.equal(dysonState.agents.length, 1);
  const launchingAgent = dysonState.agents.find((agent) => agent.source_agent === "codex");
  assert.equal(launchingAgent.agent_key, "codex:dyson-host");
  assert.equal(launchingAgent.total_clouds, 100);
  assert.equal(launchingAgent.emitted_clouds, 51);
  assert.equal(launchingAgent.pending_clouds, 49);
  assert.equal(launchingAgent.current_batch.batch_id, "dyson-launch-1:codex:dyson-host");
  assert.equal(launchingAgent.current_batch.phase, "emitting");
  assert.equal(launchingAgent.current_batch.entry_seed, launchingAgent.batches[0].entry_seed);
  assert.equal(launchingAgent.active_shots.length, 51);
  assert.equal(launchingAgent.active_shots[0].cloud_index, 0);
  assert.equal(launchingAgent.active_shots.at(-1).cloud_index, 50);
  const dysonNearRing = await get(`${base}/api/dyson/state?day=2026-07-02&now=2026-07-02T00:00:09.650Z&detail=1`);
  const nearRingAgent = dysonNearRing.agents.find((agent) => agent.source_agent === "codex");
  assert.equal(nearRingAgent.settled_clouds, 1);
  assert.equal(nearRingAgent.active_shots[0].cloud_index, 1);
  assert.equal(nearRingAgent.active_shots.some((shot) => shot.phase !== "shot"), false);
  const statusOnlyAgent = dysonState.agents.find((agent) => agent.source_agent === "opencode");
  assert.equal(statusOnlyAgent, undefined);
  const dysonStatusOnlyRange = await get(`${base}/api/dyson/state?start=2026-07-02T00:00:01.500Z&end=2026-07-02T00:00:02.500Z&now=2026-07-02T00:00:05.000Z`);
  assert.equal(dysonStatusOnlyRange.totals.tokens, 0);
  assert.equal(dysonStatusOnlyRange.agents.length, 0);
  const dysonAfterRefresh = await get(`${base}/api/dyson/state?day=2026-07-02&now=2026-07-02T00:00:05.000Z&detail=1`);
  const launchingAfterRefresh = dysonAfterRefresh.agents.find((agent) => agent.source_agent === "codex");
  assert.deepEqual(launchingAfterRefresh.current_batch, launchingAgent.current_batch);
  assert.deepEqual(launchingAfterRefresh.active_shots, launchingAgent.active_shots);
  await post(`${base}/ingest`, {
    event_id: "dyson-launch-model-2",
    source_agent: "codex",
    source_surface: "test",
    event_type: "model_response",
    occurred_at: "2026-07-02T00:00:01.000Z",
    host_id: "dyson-host",
    workspace_id: "dyson-workspace-2",
    session_id: "dyson-session-2",
    model: "gpt-dyson-other",
    usage: { input_tokens: 100 },
    meta: { machine_name: "dyson-machine", agent_status: "done" },
  });
  const dysonGrouped = await get(`${base}/api/dyson/state?day=2026-07-02&now=2026-07-02T00:00:05.000Z`);
  assert.equal(dysonGrouped.totals.tokens, 10100);
  assert.equal(dysonGrouped.agents.length, 1);
  assert.equal(dysonGrouped.agents[0].agent_key, "codex:dyson-host");
  assert.equal(dysonGrouped.agents[0].total_clouds, 101);
  const trajectorySource = await text(`${base}/dyson-trajectory.mjs`);
  assert.match(trajectorySource, /firstPhaseIsValid/);
  assert.match(trajectorySource, /secondPhaseIsValid/);
  verifyDysonStateConvergence();
  const workerSource = readFileSync(new URL("../worker/index.mjs", import.meta.url), "utf8");
  assert.match(workerSource, /cache-control", "no-store"/);
  assert.match(workerSource, /assetRequest\(request, "\/dyson"\)/);
  assert.match(workerSource, /assetRequest\(request, "\/dyson-trajectory\.mjs"\)/);
  assert.match(workerSource, /start: dateParam\(params\.get\("start"\)\)/);
  assert.match(workerSource, /excluded\.last_event_at >= agent_state\.last_event_at/);
  await post(`${base}/ingest`, {
    event_id: "state-newer",
    source_agent: "codex",
    event_type: "Stop",
    occurred_at: "2026-07-03T00:01:00.000Z",
    host_id: "state-host",
    workspace_id: "state-workspace",
    session_id: "state-session",
    agent_status: "done",
  });
  await post(`${base}/ingest`, {
    event_id: "state-older",
    source_agent: "codex",
    event_type: "PreToolUse",
    occurred_at: "2026-07-03T00:00:00.000Z",
    host_id: "state-host",
    workspace_id: "state-workspace",
    session_id: "state-session",
    agent_status: "tool_calling",
  });
  const stateAgent = (await get(`${base}/api/agents`)).agents.find((agent) => agent.host_id === "state-host");
  assert.equal(stateAgent.summary.meta.agent_status, "done");
  assert.equal(stateAgent.last_event_at, "2026-07-03T00:01:00.000Z");
  const prepareWorkerSource = readFileSync(new URL("../scripts/prepare-worker.mjs", import.meta.url), "utf8");
  assert.match(prepareWorkerSource, /dyson-trajectory\.mjs/);

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

function verifyDysonTrajectories() {
  const config = {
    arcScale: 3.4,
    cloudRadiusMin: 23,
    cloudRadiusMax: 54,
    entryRadius: 57,
    orbitSpeedForRadius: (radius) => 0.06 * Math.pow(78 / radius, 1.5),
    random01: dysonRandom,
    tangentCos: Math.cos(Math.PI / 6),
  };
  const seen = new Set();
  let total = 0;
  for (let planetIndex = 0; planetIndex < 32; planetIndex += 1) {
    for (let sample = 1; sample <= 32; sample += 1) {
      const source = dysonPlanetAt(planetIndex, dysonRandom(sample * 97 + planetIndex) * 1200);
      const seed = (sample * 7919 + planetIndex * 104729) >>> 0;
      const trajectory = buildShotTrajectory(source, seed, 1234.5, config);
      assert.ok(trajectory, `no valid trajectory for planet ${planetIndex}, sample ${sample}`);
      assert.ok(Math.abs(Math.hypot(trajectory.maneuver.x, trajectory.maneuver.z) - 57) < 1e-6);
      assert.ok(Math.abs(trajectory.maneuver.y - trajectory.seed.y) < 1e-6);
      assert.ok(source.clone().setY(0).normalize().dot(trajectory.maneuver.clone().setY(0).normalize()) < -0.999999);
      assert.ok(progradeAngle(trajectory.maneuver, trajectory.seed) > 0);
      assert.ok(progradeAngle(trajectory.maneuver, trajectory.seed) < Math.PI / 6);
      assert.ok(trajectory.tangentManeuver.clone().setY(0).normalize().dot(tangentFor(trajectory.maneuver)) >= config.tangentCos);
      assert.ok(firstPhaseIsValid(source, trajectory.maneuver, trajectory.coefficients, 57, config.tangentCos));
      assert.ok(secondPhaseIsValid(
        trajectory.maneuver,
        trajectory.seed,
        trajectory.tangentManeuver,
        trajectory.tangentSeed,
        config.tangentCos,
      ));
      assert.ok(parabolaPoint(source, trajectory.coefficients, 1).distanceTo(trajectory.maneuver) < 1e-6);
      seen.add(`${trajectory.seed.x.toFixed(4)}:${trajectory.seed.y.toFixed(4)}:${trajectory.seed.z.toFixed(4)}`);
      total += 1;
    }
  }
  assert.ok(seen.size > total * 0.99, "shots must independently select seed points");
}

function verifyDysonStateConvergence() {
  const event = {
    event_id: "bounded-batch",
    day: "2026-07-10",
    occurred_at: "2026-07-10T00:00:00.000Z",
    source_agent: "codex",
    host_id: "host",
    workspace_id: "workspace",
    session_id: "session",
    usage: { total_tokens: 100000 },
    meta: { agent_status: "done" },
  };
  const firing = buildDysonState([event], [], { day: event.day, now: "2026-07-10T00:00:05.000Z", detail: true }).agents[0];
  assert.equal(firing.total_clouds, 1000);
  assert.equal(firing.current_batch.shot_count, 100);
  assert.equal(firing.current_batch.finished_at, "2026-07-10T00:00:10.000Z");
  assert.equal(firing.active_shots[0].cloud_value, 10);
  assert.equal(firing.pending_clouds, 490);
  const coasting = buildDysonState([event], [], { day: event.day, now: "2026-07-10T00:00:10.200Z", detail: true }).agents[0];
  assert.equal(coasting.pending_clouds, 0);
  assert.equal(coasting.current_batch.phase, "coasting");
  const overlapping = buildDysonState(
    [event, { ...event, event_id: "bounded-batch-2", occurred_at: "2026-07-10T00:00:11.000Z" }],
    [],
    { day: event.day, now: "2026-07-10T00:00:11.200Z", detail: true },
  ).agents[0];
  assert.equal(overlapping.current_batch.event_id, "bounded-batch-2");
  assert.equal(overlapping.launch_state, "emitting");
  const burstEvents = Array.from({ length: 10 }, (_, index) => ({
    ...event,
    event_id: `burst-${index}`,
    occurred_at: `2026-07-10T00:00:0${index}.000Z`,
  }));
  const burst = buildDysonState(burstEvents, [], { day: event.day, now: "2026-07-10T00:00:10.200Z", detail: true }).agents[0];
  assert.equal(burst.batches.length, 1);
  assert.equal(burst.pending_clouds, 0);
  assert.equal(burst.current_batch.phase, "coasting");
  const settled = buildDysonState([event], [], { day: event.day, now: "2026-07-10T00:00:20.000Z", detail: true }).agents[0];
  assert.equal(settled.launch_state, "settled");
  assert.equal(settled.current_batch, null);
  assert.equal(settled.settled_clouds, 1000);
  const stale = buildDysonState(
    [{ ...event, event_id: "stale", usage: { input_tokens: 100 }, meta: {} }],
    [{
      source_agent: "codex",
      host_id: "host",
      last_event_at: "2026-07-10T00:01:00.000Z",
      status: "ok",
      summary: { meta: { agent_status: "thinking" } },
    }],
    { day: event.day, now: "2026-07-10T00:10:00.000Z" },
  ).agents[0];
  assert.equal(stale.status, "idle");
}

function dysonPlanetAt(index, time) {
  const radius = 78 + (index % 9) * 18 + Math.floor(index / 9) * 8;
  const speed = 0.06 * Math.pow(78 / radius, 1.5);
  const angle = index * 2.399963 + time * speed;
  const inclination = THREE.MathUtils.degToRad([30, -30, 20, -20, 10, -10, 0][index % 7]);
  const z = Math.sin(angle) * radius;
  return new THREE.Vector3(Math.cos(angle) * radius, -z * Math.sin(inclination), z * Math.cos(inclination));
}

function dysonRandom(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453123;
  return value - Math.floor(value);
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
