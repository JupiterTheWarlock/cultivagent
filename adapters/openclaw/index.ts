import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const endpoint = process.env.CULTIVAGENT_ENDPOINT ?? "http://127.0.0.1:3737/ingest";
const token = process.env.CULTIVAGENT_TOKEN ?? "";

export default definePluginEntry({
  id: "cultivagent",
  name: "Cultivagent",
  description: "Export OpenClaw lifecycle and model usage events to Cultivagent.",
  register(api) {
    for (const name of ["model_call_started", "model_call_ended", "llm_output", "agent_end", "before_tool_call", "after_tool_call"]) {
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
          meta: { openclaw_hook: name },
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
