// Cultivagent plugin 共享库（claude-code 副本）。
// 与仓库根 scripts/hook-lib.mjs 同源；每个 plugin 自带一份，不跨 plugin 引用。
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// ~/.cultivagent/config.json —— 本地 agent 凭此处的 token 访问远端 server
const CONFIG_PATH = join(homedir(), ".cultivagent", "config.json");

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

export async function readStdinJson() {
  const text = readFileSync(0, "utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

export async function sendEvent(event) {
  const cfg = loadConfig();
  // 优先级：env > config.json > 默认本地
  let endpoint = process.env.CULTIVAGENT_ENDPOINT ?? cfg.endpoint ?? "http://127.0.0.1:3737";
  endpoint = endpoint.replace(/\/$/, "");
  if (!endpoint.endsWith("/ingest")) endpoint += "/ingest";
  const token = process.env.CULTIVAGENT_TOKEN ?? cfg.token ?? "";
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
  const hookEvent = hookInput.hook_event ?? hookInput.hookEventName ?? hookInput.hook_event_name ?? hookInput.event ?? hookInput.type ?? eventType;
  return {
    source_agent: agent,
    source_surface: "hook",
    event_type: String(hookEvent),
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
      machine_name: hostname(),
      hook_event: hookEvent,
      tool_name: hookInput.tool_name ?? hookInput.toolName ?? "",
    },
  };
}

export function hash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 16);
}
