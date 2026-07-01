import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { createHash } from "node:crypto";

export async function readStdinJson() {
  const text = readFileSync(0, "utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

export async function sendEvent(event) {
  const endpoint = process.env.CULTIVAGENT_ENDPOINT ?? "http://127.0.0.1:3737/ingest";
  const token = process.env.CULTIVAGENT_TOKEN ?? "";
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(event),
  });
  if (!response.ok) throw new Error(`cultivagent ingest failed: ${response.status} ${await response.text()}`);
}

export function baseEvent(agent, hookInput, eventType = "hook_event") {
  return {
    source_agent: agent,
    source_surface: "hook",
    event_type: String(hookInput.hook_event ?? hookInput.event ?? hookInput.type ?? eventType),
    occurred_at: new Date().toISOString(),
    host_id: hash(hostname()),
    workspace_id: hash(hookInput.cwd ?? process.cwd()),
    session_id: hookInput.session_id ?? hookInput.sessionId ?? hookInput.conversation_id ?? "unknown",
    turn_id: hookInput.prompt_id ?? hookInput.promptId ?? hookInput.turn_id ?? "",
    agent_id: hookInput.agent_id ?? "",
    model: hookInput.model ?? "unknown",
    provider: hookInput.provider ?? "unknown",
    status: hookInput.status ?? "ok",
    meta: {
      hook_event: hookInput.hook_event ?? hookInput.event ?? hookInput.type ?? eventType,
      tool_name: hookInput.tool_name ?? hookInput.toolName ?? "",
    },
  };
}

export function hash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 16);
}
