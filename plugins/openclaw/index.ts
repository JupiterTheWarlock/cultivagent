import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 配置：env (CULTIVAGENT_ENDPOINT/CULTIVAGENT_TOKEN) > ~/.cultivagent/config.json > 默认本地
function loadConfig(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".cultivagent", "config.json"), "utf8"));
  } catch {
    return {};
  }
}

const cfg = loadConfig();
let endpoint = process.env.CULTIVAGENT_ENDPOINT ?? cfg.endpoint ?? "http://127.0.0.1:3737";
endpoint = endpoint.replace(/\/$/, "");
if (!endpoint.endsWith("/ingest")) endpoint += "/ingest";
const token = process.env.CULTIVAGENT_TOKEN ?? cfg.token ?? "";

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
      api.on(name, async (event: any) => {
        await send({
          source_agent: "openclaw",
          source_surface: "plugin",
          event_type: name,
          occurred_at: new Date().toISOString(),
          session_id: event.sessionKey ?? event.sessionId ?? "unknown",
          turn_id: event.turnId ?? event.requestId ?? "",
          model: event.model ?? event.modelId ?? "unknown",
          provider: event.provider ?? event.providerId ?? "unknown",
          status: event.error ? "error" : "ok",
          usage: event.usage ?? {},
          meta: { raw_hook: name, openclaw_hook: name },
        });
      });
    }
  },
});

async function send(body: Record<string, unknown>) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  if (!response.ok) console.error(`[cultivagent] ingest failed: ${response.status}`);
}
