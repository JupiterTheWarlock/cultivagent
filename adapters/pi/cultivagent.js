const endpoint = process.env.CULTIVAGENT_ENDPOINT ?? "http://127.0.0.1:3737/ingest";
const token = process.env.CULTIVAGENT_TOKEN ?? "";

export default function cultivagent(pi) {
  for (const eventName of [
    "project_trust",
    "session_start",
    "session_info_changed",
    "session_before_switch",
    "session_before_fork",
    "session_before_compact",
    "session_compact",
    "session_shutdown",
    "resources_discover",
    "input",
    "before_agent_start",
    "agent_start",
    "agent_end",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "context",
    "before_provider_request",
    "after_provider_response",
    "tool_call",
    "tool_result",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "model_select",
    "thinking_level_select",
  ]) {
    pi.on(eventName, async (event) => {
      const messageUsage = event?.message?.usage ?? {};
      await send({
        source_agent: "pi",
        source_surface: "extension",
        event_type: eventName,
        occurred_at: new Date().toISOString(),
        session_id: event?.sessionId ?? "unknown",
        turn_id: event?.turnIndex == null ? "" : String(event.turnIndex),
        model: event?.model?.id ?? "unknown",
        provider: event?.model?.provider ?? "unknown",
        status: event?.isError ? "error" : "ok",
        usage: {
          input_tokens: messageUsage.inputTokens ?? messageUsage.input_tokens ?? 0,
          output_tokens: messageUsage.outputTokens ?? messageUsage.output_tokens ?? 0,
          total_tokens: messageUsage.totalTokens ?? messageUsage.total_tokens ?? 0,
          cost_usd: messageUsage.cost?.total ?? null,
        },
        meta: { raw_hook: eventName, pi_event: eventName },
      });
      if (eventName === "project_trust") return { trusted: "undecided" };
    });
  }
}

async function send(body) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  if (!response.ok) console.error(`[cultivagent] ingest failed: ${response.status}`);
}
