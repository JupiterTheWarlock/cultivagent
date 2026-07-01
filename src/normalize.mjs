import { createHash } from "node:crypto";

const KNOWN_AGENTS = new Set([
  "codex",
  "claude-code",
  "opencode",
  "openclaw",
  "pi",
  "cultivagent",
]);

const TOKEN_KEYS = {
  input_tokens: ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"],
  output_tokens: ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"],
  cache_read_tokens: ["cache_read_tokens", "cacheReadTokens", "cache_read_input_tokens"],
  cache_write_tokens: ["cache_write_tokens", "cacheWriteTokens", "cache_creation_input_tokens"],
  total_tokens: ["total_tokens", "totalTokens", "tokens"],
  cost_usd: ["cost_usd", "costUsd", "cost"],
};

export function normalizeEvent(input = {}, defaults = {}) {
  const usage = normalizeUsage(input.usage ?? input);
  const occurredAt = validDate(input.occurred_at ?? input.timestamp ?? input.time) ?? new Date();
  const sourceAgent = normalizeAgent(input.source_agent ?? defaults.source_agent);
  const sourceSurface = String(input.source_surface ?? defaults.source_surface ?? "hook");
  const eventType = String(input.event_type ?? input.type ?? defaults.event_type ?? "event");
  const hostId = cleanId(input.host_id ?? defaults.host_id ?? "local");
  const workspaceId = cleanId(input.workspace_id ?? input.cwd ?? defaults.workspace_id ?? "default");
  const sessionId = cleanId(input.session_id ?? input.sessionId ?? defaults.session_id ?? "unknown");
  const turnId = cleanId(input.turn_id ?? input.prompt_id ?? input.promptId ?? defaults.turn_id ?? "");
  const agentId = cleanId(input.agent_id ?? input.agentId ?? defaults.agent_id ?? "");
  const model = cleanId(input.model ?? input.model_id ?? input.modelId ?? defaults.model ?? "unknown");
  const provider = cleanId(input.provider ?? input.provider_id ?? input.providerId ?? defaults.provider ?? "unknown");
  const status = cleanId(input.status ?? defaults.status ?? "ok");
  const durationMs = nullableNumber(input.duration_ms ?? input.durationMs);
  const meta = safeObject(input.meta ?? input.metadata ?? defaults.meta);

  const basis = {
    sourceAgent,
    sourceSurface,
    eventType,
    occurred_at: occurredAt.toISOString(),
    hostId,
    workspaceId,
    sessionId,
    turnId,
    agentId,
    provider,
    model,
    usage,
    status,
    durationMs,
    meta,
  };

  return {
    schema_version: 1,
    event_id: cleanId(input.event_id ?? input.id) || stableHash(basis),
    source_agent: sourceAgent,
    source_surface: sourceSurface,
    event_type: eventType,
    occurred_at: occurredAt.toISOString(),
    day: occurredAt.toISOString().slice(0, 10),
    host_id: hostId,
    workspace_id: workspaceId,
    session_id: sessionId,
    turn_id: turnId,
    agent_id: agentId,
    provider,
    model,
    usage,
    status,
    duration_ms: durationMs,
    meta,
    privacy: {
      redacted: input.privacy?.redacted ?? true,
      raw_stored: false,
    },
  };
}

export function normalizeOtelLogs(body, defaults = {}) {
  const records = [];
  for (const resourceLog of body?.resourceLogs ?? []) {
    const resourceAttrs = attrsToObject(resourceLog.resource?.attributes);
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const logRecord of scopeLog.logRecords ?? []) {
        const attrs = {
          ...resourceAttrs,
          ...attrsToObject(logRecord.attributes),
        };
        const name = attrs["event.name"] ?? attrs.event_name ?? bodyValue(logRecord.body) ?? "otel_log";
        const agent = defaults.source_agent ?? agentFromService(attrs["service.name"]);
        const kind = attrs["sse.event"] ?? attrs.event ?? attrs.type ?? name;
        const usage = normalizeUsage(attrs);
        records.push(normalizeEvent({
          event_id: attrs["event.id"] ?? attrs.event_id,
          source_agent: agent,
          source_surface: "otel",
          event_type: otelEventType(agent, name, kind, usage),
          occurred_at: nanosToDate(logRecord.timeUnixNano) ?? attrs["event.timestamp"],
          host_id: attrs["host.id"] ?? attrs["host.name"],
          workspace_id: attrs["workspace.id"] ?? attrs["workspace.path"],
          session_id: attrs["session.id"] ?? attrs["conversation.id"],
          turn_id: attrs["prompt.id"] ?? attrs["response.id"],
          provider: attrs.provider,
          model: attrs.model,
          usage,
          status: attrs.success === false ? "error" : "ok",
          duration_ms: attrs.duration_ms ?? attrs["duration.ms"],
          meta: {
            otel_name: name,
            otel_kind: kind,
          },
        }, defaults));
      }
    }
  }
  return records;
}

export function normalizeOtelMetrics(body, defaults = {}) {
  const records = [];
  for (const resourceMetric of body?.resourceMetrics ?? []) {
    const resourceAttrs = attrsToObject(resourceMetric.resource?.attributes);
    for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
      for (const metric of scopeMetric.metrics ?? []) {
        const points = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
        for (const point of points) {
          const attrs = {
            ...resourceAttrs,
            ...attrsToObject(point.attributes),
          };
          const value = Number(point.asDouble ?? point.asInt ?? point.value ?? 0);
          const usage = {};
          if (metric.name === "claude_code.token.usage") usage.total_tokens = value;
          if (metric.name === "claude_code.cost.usage") usage.cost_usd = value;
          records.push(normalizeEvent({
            source_agent: defaults.source_agent ?? agentFromService(attrs["service.name"]),
            source_surface: "otel",
            event_type: metric.name,
            occurred_at: nanosToDate(point.timeUnixNano) ?? new Date(),
            host_id: attrs["host.id"] ?? attrs["host.name"],
            workspace_id: attrs["workspace.id"] ?? attrs["workspace.path"],
            session_id: attrs["session.id"],
            provider: attrs.provider,
            model: attrs.model,
            usage,
            meta: { metric_name: metric.name },
          }, defaults));
        }
      }
    }
  }
  return records;
}

export function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

export function normalizeUsage(input = {}) {
  const out = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
    cost_usd: null,
  };
  for (const [target, keys] of Object.entries(TOKEN_KEYS)) {
    for (const key of keys) {
      const value = numberFrom(input?.[key]);
      if (value != null) {
        out[target] = value;
        break;
      }
    }
  }
  if (!out.total_tokens) {
    out.total_tokens = out.input_tokens + out.output_tokens + out.cache_read_tokens + out.cache_write_tokens;
  }
  return out;
}

function normalizeAgent(value) {
  const agent = String(value ?? "cultivagent").toLowerCase();
  return KNOWN_AGENTS.has(agent) ? agent : "cultivagent";
}

function otelEventType(agent, name, kind, usage) {
  if (agent === "codex" && String(kind).includes("response.completed")) return "model_response";
  if (name === "assistant_response") return "model_response";
  if (usage.total_tokens || usage.cost_usd != null) return "model_response";
  return String(name).replace(/^claude_code\./, "");
}

function agentFromService(service) {
  if (service === "claude-code") return "claude-code";
  if (service === "codex" || service === "openai-codex") return "codex";
  return "cultivagent";
}

function attrsToObject(attrs = []) {
  const out = {};
  for (const attr of attrs) out[attr.key] = otelValue(attr.value);
  return out;
}

function otelValue(value) {
  if (!value || typeof value !== "object") return value;
  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("boolValue" in value) return Boolean(value.boolValue);
  if ("bytesValue" in value) return value.bytesValue;
  return value;
}

function bodyValue(body) {
  const value = otelValue(body);
  return typeof value === "string" ? value : undefined;
}

function nanosToDate(value) {
  if (!value) return null;
  const ms = Number(BigInt(value) / 1000000n);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function validDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function numberFrom(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nullableNumber(value) {
  const n = numberFrom(value);
  return n == null ? null : n;
}

function cleanId(value) {
  return String(value ?? "").slice(0, 512);
}

function safeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}
