import { createHash } from "node:crypto";
import { hostname } from "node:os";

const KNOWN_AGENTS = new Set([
  "codex",
  "claude-code",
  "opencode",
  "openclaw",
  "locus",
  "pi",
  "cultivagent",
]);

// 字段长度上限，防止超长字符串占满数据库
const MAX_FIELD_LEN = 512;
const MAX_EVENT_TYPE_LEN = 256;
const MAX_USAGE_VALUE = 1e15; // 1 千万亿，远超任何合理的 token 数

/**
 * 验证并清洗 normalize 之前的原始输入。
 * 抛出 ValidationError 如果有严重问题。
 * 不抛出的情况下保证返回安全的、截断后的值。
 */
export function validateInput(input = {}) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("event must be an object");
  }

  // source_agent — 已知集合或默认
  const agent = String(input.source_agent ?? "cultivagent").toLowerCase();
  if (!KNOWN_AGENTS.has(agent)) {
    // 不抛错，normalizeEvent 会处理为 'cultivagent'
    // 但我们标记一下
  }

  // event_type — 限长，清洗
  if (input.event_type != null) {
    const et = String(input.event_type);
    if (et.length > MAX_EVENT_TYPE_LEN) input.event_type = et.slice(0, MAX_EVENT_TYPE_LEN);
  }

  // usage 数值验证 — 非负有限数
  const usage = input.usage;
  if (usage != null && typeof usage === "object" && !Array.isArray(usage)) {
    for (const key of Object.keys(usage)) {
      const val = Number(usage[key]);
      if (!Number.isFinite(val) || val < 0) {
        delete usage[key];
      } else if (val > MAX_USAGE_VALUE) {
        usage[key] = MAX_USAGE_VALUE;
      }
    }
  }

  // duration_ms — 非负有限数
  if (input.duration_ms != null) {
    const d = Number(input.duration_ms);
    if (!Number.isFinite(d) || d < 0) delete input.duration_ms;
    else if (d > 864000000) input.duration_ms = 864000000; // 上限 10 天 (ms)
  }

  // 字符串字段截断
  for (const key of ["session_id", "sessionId", "turn_id", "prompt_id", "agent_id", "agentId", "model", "model_id", "modelId", "provider", "workspace_id", "cwd", "host_id", "username", "user_name", "userName", "machine_name", "machineName", "status"]) {
    if (input[key] != null && typeof input[key] === "string" && input[key].length > MAX_FIELD_LEN) {
      input[key] = input[key].slice(0, MAX_FIELD_LEN);
    }
  }

  // occurred_at 时间窗口验证 — 不接受未来 1 小时以后或过去 10 年以前
  const occurredAt = input.occurred_at ?? input.timestamp ?? input.time;
  if (occurredAt != null) {
    const date = new Date(occurredAt);
    if (Number.isFinite(date.getTime())) {
      const now = Date.now();
      const oneHourAhead = now + 60 * 60 * 1000;
      const tenYearsAgo = now - 10 * 365 * 24 * 60 * 60 * 1000;
      if (date.getTime() > oneHourAhead || date.getTime() < tenYearsAgo) {
        delete input.occurred_at;
        delete input.timestamp;
        delete input.time;
      }
    }
  }

  return input;
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

const TOKEN_KEYS = {
  input_tokens: ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens", "input", "prompt"],
  output_tokens: ["output_tokens", "outputTokens", "completion_tokens", "completionTokens", "output", "completion"],
  cache_read_tokens: ["cache_read_tokens", "cacheReadTokens", "cache_read_input_tokens", "cacheRead", "cache_read"],
  cache_write_tokens: ["cache_write_tokens", "cacheWriteTokens", "cache_creation_input_tokens", "cacheWrite", "cacheCreation", "cache_write"],
  total_tokens: ["total_tokens", "totalTokens", "tokens", "total"],
  cost_usd: ["cost_usd", "costUsd", "cost"],
};

export function normalizeEvent(input = {}, defaults = {}) {
  const usage = normalizeUsage(input.usage ?? input);
  const occurredAt = validDate(input.occurred_at ?? input.timestamp ?? input.time) ?? new Date();
  const sourceAgent = normalizeAgent(input.source_agent ?? defaults.source_agent);
  const sourceSurface = String(input.source_surface ?? defaults.source_surface ?? "hook");
  const eventType = String(input.event_type ?? input.type ?? defaults.event_type ?? "event");
  const loop = translateLoopEvent(sourceAgent, eventType, input, usage);
  const defaultMeta = safeObject(defaults.meta);
  const inputMeta = safeObject(input.meta ?? input.metadata);
  const machineName = cleanId(
    input.machine_name ?? input.machineName ?? input.host_name ?? input.hostName ??
    inputMeta.machine_name ?? defaultMeta.machine_name ?? hostname()
  );
  const username = cleanId(
    input.username ?? input.user_name ?? input.userName ??
    inputMeta.username ?? inputMeta.user_name ??
    defaultMeta.username ?? defaultMeta.user_name ??
    machineName
  );
  const hostId = cleanId(input.host_id ?? defaults.host_id ?? shortHash(machineName));
  const workspaceId = cleanId(input.workspace_id ?? input.cwd ?? defaults.workspace_id ?? "default");
  const sessionId = cleanId(input.session_id ?? input.sessionId ?? defaults.session_id ?? "unknown");
  const turnId = cleanId(input.turn_id ?? input.prompt_id ?? input.promptId ?? defaults.turn_id ?? "");
  const agentId = cleanId(input.agent_id ?? input.agentId ?? defaults.agent_id ?? "");
  const model = cleanId(input.model ?? input.model_id ?? input.modelId ?? defaults.model ?? "unknown");
  const provider = cleanId(input.provider ?? input.provider_id ?? input.providerId ?? defaults.provider ?? "unknown");
  const status = cleanId(input.status ?? defaults.status ?? "ok");
  const durationMs = nullableNumber(input.duration_ms ?? input.durationMs);
  const meta = {
    ...defaultMeta,
    ...inputMeta,
    machine_name: inputMeta.machine_name ?? defaultMeta.machine_name ?? machineName,
    username: inputMeta.username ?? defaultMeta.username ?? username,
    loop_event: input.loop_event ?? loop.loop_event,
    agent_status: input.agent_status ?? loop.agent_status,
    event_role: input.event_role ?? loop.event_role,
  };

  const basis = {
    sourceAgent,
    sourceSurface,
    eventType,
    occurred_at: occurredAt.toISOString(),
    username,
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
    username,
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
          username: otelUsername(attrs),
          machine_name: otelMachineName(attrs),
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
          if (metric.name === "claude_code.token.usage") {
            const type = attrs.type ?? attrs["token.type"];
            if (type === "input") usage.input_tokens = value;
            else if (type === "output") usage.output_tokens = value;
            else if (type === "cacheRead") usage.cache_read_tokens = value;
            else if (type === "cacheCreation") usage.cache_write_tokens = value;
            else usage.total_tokens = value;
          }
          if (metric.name === "claude_code.cost.usage") usage.cost_usd = value;
          const isClaudeUsageMetric = metric.name === "claude_code.token.usage" || metric.name === "claude_code.cost.usage";
          records.push(normalizeEvent({
            source_agent: defaults.source_agent ?? agentFromService(attrs["service.name"]),
            source_surface: "otel",
            event_type: metric.name,
            occurred_at: nanosToDate(point.timeUnixNano) ?? new Date(),
            username: otelUsername(attrs),
            machine_name: otelMachineName(attrs),
            host_id: attrs["host.id"] ?? attrs["host.name"],
            workspace_id: attrs["workspace.id"] ?? attrs["workspace.path"],
            session_id: attrs["session.id"],
            provider: attrs.provider,
            model: attrs.model,
            usage,
            meta: { metric_name: metric.name, token_type: attrs.type, metric_value: value, accounting: !isClaudeUsageMetric },
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

function shortHash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 16);
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

export function translateLoopEvent(agent, eventType, input = {}, usage = normalizeUsage(input)) {
  const name = String(eventType ?? "").replace(/^claude_code\./, "").toLowerCase();
  const hasUsage = Boolean(usage.total_tokens || usage.input_tokens || usage.output_tokens || usage.cost_usd != null);
  const exact = new Map([
    ["sessionstart", ["session.start", "idle", "session"]],
    ["session_start", ["session.start", "idle", "session"]],
    ["session.created", ["session.start", "idle", "session"]],
    ["sessionend", ["session.end", "idle", "session"]],
    ["session_end", ["session.end", "idle", "session"]],
    ["session_shutdown", ["session.end", "idle", "session"]],
    ["session.deleted", ["session.end", "idle", "session"]],
    ["setup", ["session.setup", "setup", "session"]],
    ["userpromptsubmit", ["input.received", "receiving_input", "input"]],
    ["input", ["input.received", "receiving_input", "input"]],
    ["tui.prompt.append", ["input.received", "receiving_input", "input"]],
    ["userpromptexpansion", ["input.expanded", "receiving_input", "input"]],
    ["instructionsloaded", ["context.loaded", "loading_context", "context"]],
    ["resources_discover", ["context.loaded", "loading_context", "context"]],
    ["before_agent_start", ["agent.starting", "loading_context", "agent"]],
    ["agent_start", ["agent.start", "thinking", "agent"]],
    ["turn_start", ["turn.start", "thinking", "turn"]],
    ["context", ["context.build", "thinking", "context"]],
    ["before_model_resolve", ["model.resolve", "thinking", "model"]],
    ["model_select", ["model.select", "idle", "model"]],
    ["thinking_level_select", ["thinking.level", "thinking", "model"]],
    ["before_provider_request", ["model.request.start", "thinking", "model"]],
    ["model_call_started", ["model.request.start", "thinking", "model"]],
    ["api_request", ["model.request.start", "thinking", "model"]],
    ["after_provider_response", ["model.response.headers", "streaming", "model"]],
    ["model_call_ended", ["model.response", hasUsage ? "done" : "streaming", "model"]],
    ["llm_output", ["model.response", "done", "model"]],
    ["assistant_response", ["model.response", "done", "model"]],
    ["model_response", ["model.response", "done", "model"]],
    ["messagedisplay", ["message.streaming", "streaming", "message"]],
    ["message_update", ["message.streaming", "streaming", "message"]],
    ["message.updated", ["message.streaming", "streaming", "message"]],
    ["message_start", ["message.start", "streaming", "message"]],
    ["message_end", ["message.end", hasUsage ? "done" : "streaming", "message"]],
    ["pretooluse", ["tool.before", "tool_calling", "tool"]],
    ["before_tool_call", ["tool.before", "tool_calling", "tool"]],
    ["tool_call", ["tool.before", "tool_calling", "tool"]],
    ["tool.execute.before", ["tool.before", "tool_calling", "tool"]],
    ["tool_execution_start", ["tool.start", "tool_calling", "tool"]],
    ["tool_execution_update", ["tool.update", "tool_calling", "tool"]],
    ["tool_result", ["tool.result", "tool_calling", "tool"]],
    ["posttooluse", ["tool.end", "thinking", "tool"]],
    ["after_tool_call", ["tool.end", "thinking", "tool"]],
    ["tool.execute.after", ["tool.end", "thinking", "tool"]],
    ["tool_execution_end", ["tool.end", "thinking", "tool"]],
    ["posttoolbatch", ["tool.batch.end", "thinking", "tool"]],
    ["permissionrequest", ["approval.request", "waiting_approval", "approval"]],
    ["permission.asked", ["approval.request", "waiting_approval", "approval"]],
    ["permission.replied", ["approval.response", "thinking", "approval"]],
    ["permissiondenied", ["approval.denied", "thinking", "approval"]],
    ["elicitation", ["user.input.request", "waiting_user", "approval"]],
    ["elicitationresult", ["user.input.response", "thinking", "approval"]],
    ["subagentstart", ["subagent.start", "delegating", "subagent"]],
    ["subagent_start", ["subagent.start", "delegating", "subagent"]],
    ["subagent_spawned", ["subagent.start", "delegating", "subagent"]],
    ["taskcreated", ["subagent.start", "delegating", "subagent"]],
    ["subagentstop", ["subagent.end", "thinking", "subagent"]],
    ["subagent_end", ["subagent.end", "thinking", "subagent"]],
    ["subagent_ended", ["subagent.end", "thinking", "subagent"]],
    ["taskcompleted", ["subagent.end", "thinking", "subagent"]],
    ["before_agent_finalize", ["agent.finalizing", "finalizing", "agent"]],
    ["stop", ["agent.end", "done", "agent"]],
    ["agent_end", ["agent.end", "done", "agent"]],
    ["session.idle", ["agent.idle", "idle", "agent"]],
    ["teammateidle", ["agent.idle", "idle", "agent"]],
    ["precompact", ["compaction.before", "compacting", "context"]],
    ["session_before_compact", ["compaction.before", "compacting", "context"]],
    ["before_compaction", ["compaction.before", "compacting", "context"]],
    ["postcompact", ["compaction.after", "thinking", "context"]],
    ["session_compact", ["compaction.after", "thinking", "context"]],
    ["session.compacted", ["compaction.after", "thinking", "context"]],
    ["after_compaction", ["compaction.after", "thinking", "context"]],
    ["configchange", ["environment.changed", "idle", "environment"]],
    ["cwdchanged", ["environment.changed", "idle", "environment"]],
    ["filechanged", ["environment.changed", "idle", "environment"]],
    ["file.edited", ["environment.changed", "idle", "environment"]],
    ["file.watcher.updated", ["environment.changed", "idle", "environment"]],
    ["command.executed", ["command.executed", "thinking", "tool"]],
    ["notification", ["notification", "idle", "notification"]],
    ["cli_detected", ["probe.detected", "idle", "probe"]],
  ]);
  const mapped = exact.get(name);
  if (mapped) return loopObject(mapped);
  if (name.includes("error") || name.includes("failure")) return loopObject(["error", "error", "error"]);
  if (name.includes("tool")) return loopObject(["tool.event", "tool_calling", "tool"]);
  if (name.includes("message")) return loopObject(["message.event", "streaming", "message"]);
  if (name.includes("session")) return loopObject(["session.event", "idle", "session"]);
  if (hasUsage) return loopObject(["model.response", "done", "model"]);
  return loopObject(["hook.raw", "running", "raw"]);
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

function loopObject([loop_event, agent_status, event_role]) {
  return { loop_event, agent_status, event_role };
}

function agentFromService(service) {
  if (service === "claude-code") return "claude-code";
  if (service === "codex" || service === "openai-codex") return "codex";
  return "cultivagent";
}

function otelUsername(attrs) {
  return attrs["cultivagent.username"] ?? attrs.username ?? attrs["user.name"] ?? "unknown";
}

function otelMachineName(attrs) {
  return attrs["cultivagent.machine_name"] ?? attrs["host.name"];
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
