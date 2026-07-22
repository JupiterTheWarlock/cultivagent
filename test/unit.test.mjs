// Unit tests for normalize.mjs and auth.mjs
// Run with: npm test (uses node:test)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEvent,
  normalizeUsage,
  validateInput,
  ValidationError,
  translateLoopEvent,
  stableHash,
} from "../src/normalize.mjs";
import { isAuthorized } from "../src/auth.mjs";

// ── normalizeUsage ──

describe("normalizeUsage", () => {
  it("handles empty input", () => {
    const u = normalizeUsage({});
    assert.equal(u.input_tokens, 0);
    assert.equal(u.output_tokens, 0);
    assert.equal(u.total_tokens, 0);
  });

  it("maps snake_case keys", () => {
    const u = normalizeUsage({ input_tokens: 100, output_tokens: 50 });
    assert.equal(u.input_tokens, 100);
    assert.equal(u.output_tokens, 50);
    assert.equal(u.total_tokens, 150);
  });

  it("maps camelCase keys", () => {
    const u = normalizeUsage({ inputTokens: 200, outputTokens: 100 });
    assert.equal(u.input_tokens, 200);
    assert.equal(u.output_tokens, 100);
  });

  it("maps prompt_tokens / completion_tokens", () => {
    const u = normalizeUsage({ prompt_tokens: 10, completion_tokens: 5 });
    assert.equal(u.input_tokens, 10);
    assert.equal(u.output_tokens, 5);
  });

  it("includes cache tokens in total", () => {
    const u = normalizeUsage({ input_tokens: 10, cache_read_tokens: 90 });
    assert.equal(u.total_tokens, 100);
  });
});

// ── validateInput ──

describe("validateInput", () => {
  it("passes valid events through", () => {
    const input = { source_agent: "codex", event_type: "model_response", usage: { input_tokens: 10 } };
    const result = validateInput(input);
    assert.equal(result.source_agent, "codex");
  });

  it("rejects non-object input", () => {
    assert.throws(() => validateInput("hello"), ValidationError);
    assert.throws(() => validateInput(null), ValidationError);
    assert.throws(() => validateInput([1, 2]), ValidationError);
  });

  it("clamps negative usage values", () => {
    const input = { usage: { input_tokens: -5, output_tokens: 10 } };
    validateInput(input);
    assert.equal(input.usage.input_tokens, undefined);
    assert.equal(input.usage.output_tokens, 10);
  });

  it("clamps absurdly large usage values", () => {
    const input = { usage: { input_tokens: 1e20 } };
    validateInput(input);
    assert.equal(input.usage.input_tokens, 1e15);
  });

  it("removes non-finite usage values", () => {
    const input = { usage: { input_tokens: NaN, output_tokens: Infinity } };
    validateInput(input);
    assert.equal(input.usage.input_tokens, undefined);
    assert.equal(input.usage.output_tokens, undefined);
  });

  it("truncates overlong string fields", () => {
    const long = "x".repeat(1000);
    const input = { session_id: long, model: long };
    validateInput(input);
    assert.ok(input.session_id.length <= 512);
    assert.ok(input.model.length <= 512);
  });

  it("rejects future timestamps beyond 1 hour", () => {
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const input = { occurred_at: future };
    validateInput(input);
    assert.equal(input.occurred_at, undefined);
  });

  it("rejects timestamps older than 10 years", () => {
    const ancient = new Date(Date.now() - 11 * 365 * 24 * 60 * 60 * 1000).toISOString();
    const input = { occurred_at: ancient };
    validateInput(input);
    assert.equal(input.occurred_at, undefined);
  });

  it("clamps duration_ms to reasonable max", () => {
    const input = { duration_ms: 999999999999 };
    validateInput(input);
    assert.equal(input.duration_ms, 864000000);
  });

  it("removes negative duration_ms", () => {
    const input = { duration_ms: -100 };
    validateInput(input);
    assert.equal(input.duration_ms, undefined);
  });
});

// ── normalizeEvent ──

describe("normalizeEvent", () => {
  it("produces a well-formed event", () => {
    const event = normalizeEvent({
      source_agent: "codex",
      event_type: "model_response",
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    assert.equal(event.source_agent, "codex");
    assert.equal(event.event_type, "model_response");
    assert.equal(event.usage.input_tokens, 100);
    assert.equal(event.schema_version, 1);
    assert.equal(event.privacy.raw_stored, false);
    assert.ok(event.event_id);
    assert.ok(event.day);
  });

  it("defaults unknown agent to cultivagent", () => {
    const event = normalizeEvent({ source_agent: "random-thing" });
    assert.equal(event.source_agent, "cultivagent");
  });

  it("generates stable event_id for same input", () => {
    const input = { source_agent: "codex", event_type: "test", usage: { input_tokens: 1 } };
    const e1 = normalizeEvent({ ...input });
    const e2 = normalizeEvent({ ...input });
    assert.equal(e1.event_id, e2.event_id);
  });
});

// ── translateLoopEvent ──

describe("translateLoopEvent", () => {
  it("maps known hooks", () => {
    const r = translateLoopEvent("codex", "model_response", {}, { total_tokens: 10 });
    assert.equal(r.loop_event, "model.response");
    assert.equal(r.agent_status, "done");
  });

  it("maps session_start", () => {
    const r = translateLoopEvent("codex", "session_start", {}, {});
    assert.equal(r.loop_event, "session.start");
  });

  it("maps tool hooks", () => {
    const r = translateLoopEvent("claude-code", "pretooluse", {}, {});
    assert.equal(r.loop_event, "tool.before");
    assert.equal(r.event_role, "tool");
  });

  it("falls back to hook.raw for unknown", () => {
    const r = translateLoopEvent("codex", "some_unknown_event", {}, {});
    assert.equal(r.loop_event, "hook.raw");
  });
});

// ── stableHash ──

describe("stableHash", () => {
  it("produces consistent hashes", () => {
    const h1 = stableHash({ a: 1 });
    const h2 = stableHash({ a: 1 });
    assert.equal(h1, h2);
    assert.equal(h1.length, 32);
  });

  it("produces different hashes for different input", () => {
    const h1 = stableHash({ a: 1 });
    const h2 = stableHash({ a: 2 });
    assert.notEqual(h1, h2);
  });
});

// ── isAuthorized (local mode) ──

describe("isAuthorized", () => {
  it("allows all when no token configured (local mode)", () => {
    const req = { headers: {} };
    assert.equal(isAuthorized(req, ""), true);
  });

  it("rejects when token configured but not provided", () => {
    const req = { headers: {} };
    assert.equal(isAuthorized(req, "secret"), false);
  });

  it("accepts Bearer token", () => {
    const req = { headers: { authorization: "Bearer secret" } };
    assert.equal(isAuthorized(req, "secret"), true);
  });

  it("accepts x-cultivagent-token header", () => {
    const req = { headers: { "x-cultivagent-token": "secret" } };
    assert.equal(isAuthorized(req, "secret"), true);
  });

  it("accepts cookie token", () => {
    const req = { headers: { cookie: "cultivagent_token=secret" } };
    assert.equal(isAuthorized(req, "secret"), true);
  });

  it("rejects wrong token", () => {
    const req = { headers: { authorization: "Bearer wrong" } };
    assert.equal(isAuthorized(req, "secret"), false);
  });
});
