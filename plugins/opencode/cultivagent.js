// Cultivagent plugin for OpenCode. Forwards opencode events to POST /ingest.
// 配置：env (CULTIVAGENT_ENDPOINT/CULTIVAGENT_TOKEN) > ~/.cultivagent/config.json > 默认本地。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function loadConfig() {
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

export const Cultivagent = async ({ project, directory, worktree }) => {
  return {
    event: async ({ event }) => {
      await send({
        source_agent: "opencode",
        source_surface: "plugin",
        event_type: event.type,
        occurred_at: new Date().toISOString(),
        workspace_id: project?.id ?? directory ?? worktree ?? "default",
        session_id: event.properties?.sessionID ?? event.properties?.sessionId ?? "unknown",
        turn_id: event.properties?.messageID ?? event.properties?.messageId ?? "",
        model: event.properties?.modelID ?? event.properties?.model ?? "unknown",
        provider: event.properties?.providerID ?? event.properties?.provider ?? "unknown",
        status: event.properties?.error ? "error" : "ok",
        meta: {
          raw_hook: event.type,
          opencode_event: event.type,
        },
      });
    },
  };
};

async function send(body) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  if (!response.ok) console.error(`[cultivagent] ingest failed: ${response.status}`);
}
