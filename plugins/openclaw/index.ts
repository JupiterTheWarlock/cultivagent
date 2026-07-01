import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type CultivagentConfig = {
  endpoint?: string;
  token?: string;
};

type HookContext = {
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  agentId?: string;
};

const CONFIG_PATH = join(homedir(), ".cultivagent", "config.json");
const DEFAULT_ENDPOINT = "http://127.0.0.1:3737";
const INGEST_TIMEOUT_MS = Number(process.env.CULTIVAGENT_TIMEOUT_MS ?? "3000");

// 配置：env (CULTIVAGENT_ENDPOINT/CULTIVAGENT_TOKEN) > ~/.cultivagent/config.json > 默认本地
function loadConfig(): CultivagentConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function resolveIngestConfig() {
  const cfg = loadConfig();
  let endpoint = process.env.CULTIVAGENT_ENDPOINT ?? cfg.endpoint ?? DEFAULT_ENDPOINT;
  endpoint = endpoint.replace(/\/$/, "");
  if (!endpoint.endsWith("/ingest")) endpoint += "/ingest";
  const token = process.env.CULTIVAGENT_TOKEN ?? cfg.token ?? "";
  return { endpoint, token };
}

export default definePluginEntry({
  id: "cultivagent",
  name: "Cultivagent",
  description: "Export OpenClaw lifecycle and model usage events to Cultivagent.",
  register(api) {
    for (const name of [
      "inbound_claim",
      "message_received",
      "message_sending",
      "reply_payload_sending",
      "message_sent",
      "before_dispatch",
      "reply_dispatch",
      "session_start",
      "session_end",
      "before_compaction",
      "after_compaction",
      "before_reset",
      "subagent_spawned",
      "subagent_ended",
      "subagent_delivery_target",
      "gateway_start",
      "gateway_stop",
      "cron_changed",
      "before_install",
      "before_model_resolve",
      "model_call_started",
      "model_call_ended",
      "llm_input",
      "llm_output",
      "agent_turn_prepare",
      "before_agent_run",
      "before_agent_reply",
      "before_agent_finalize",
      "agent_end",
      "heartbeat_prompt_contribution",
      "before_tool_call",
      "after_tool_call",
    ]) {
      api.on(name, async (event: any, ctx?: HookContext) => {
        const usage = pickUsage(event);
        await send({
          source_agent: "openclaw",
          source_surface: "plugin",
          event_type: name,
          occurred_at: new Date().toISOString(),
          session_id: event?.sessionKey ?? event?.sessionId ?? ctx?.sessionKey ?? ctx?.sessionId ?? "unknown",
          turn_id: event?.turnId ?? event?.requestId ?? ctx?.runId ?? "",
          agent_id: event?.agentId ?? ctx?.agentId ?? "",
          model: event?.model ?? event?.modelId ?? event?.agentMeta?.model ?? event?.usageState?.model ?? "unknown",
          provider: event?.provider ?? event?.providerId ?? event?.agentMeta?.provider ?? event?.usageState?.provider ?? "unknown",
          status: event?.error ? "error" : "ok",
          duration_ms: event?.durationMs ?? event?.duration_ms,
          usage,
          meta: { raw_hook: name, openclaw_hook: name },
        });
      });
    }
  },
});

function pickUsage(event: any) {
  for (const candidate of [
    event?.usage,
    event?.lastCallUsage,
    event?.usageState?.usage,
    event?.usageState?.lastCallUsage,
    event?.agentMeta?.usage,
    event?.agentMeta?.lastCallUsage,
    event?.meta?.agentMeta?.usage,
    event?.meta?.agentMeta?.lastCallUsage,
    event?.result?.meta?.agentMeta?.usage,
    event?.result?.meta?.agentMeta?.lastCallUsage,
    event?.payload?.meta?.agentMeta?.usage,
    event?.payload?.meta?.agentMeta?.lastCallUsage,
    event?.response?.usage,
    event?.output?.usage,
  ]) {
    const usage = normalizeUsage(candidate);
    if (usage) return usage;
  }
  return {};
}

function normalizeUsage(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const usage = {
    input_tokens: numberFrom(record.input_tokens ?? record.inputTokens ?? record.prompt_tokens ?? record.promptTokens ?? record.input ?? record.prompt),
    output_tokens: numberFrom(record.output_tokens ?? record.outputTokens ?? record.completion_tokens ?? record.completionTokens ?? record.output ?? record.completion),
    cache_read_tokens: numberFrom(record.cache_read_tokens ?? record.cacheReadTokens ?? record.cache_read_input_tokens ?? record.cacheRead ?? record.cache_read),
    cache_write_tokens: numberFrom(record.cache_write_tokens ?? record.cacheWriteTokens ?? record.cache_creation_input_tokens ?? record.cacheWrite ?? record.cacheCreation ?? record.cache_write),
    total_tokens: numberFrom(record.total_tokens ?? record.totalTokens ?? record.tokens ?? record.total),
    cost_usd: numberFrom(record.cost_usd ?? record.costUsd ?? record.cost),
  };
  if (usage.total_tokens == null) {
    usage.total_tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
  }
  const hasUsage = usage.total_tokens || usage.input_tokens || usage.output_tokens || usage.cache_read_tokens || usage.cache_write_tokens || usage.cost_usd != null;
  if (!hasUsage) return null;
  return Object.fromEntries(Object.entries(usage).filter(([, value]) => value != null));
}

function numberFrom(value: unknown) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function send(body: Record<string, unknown>) {
  const { endpoint, token } = resolveIngestConfig();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) console.error(`[cultivagent] ingest failed: ${response.status}`);
  } catch (error) {
    console.error(`[cultivagent] ingest failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}
