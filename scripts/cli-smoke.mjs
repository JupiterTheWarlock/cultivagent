#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { baseEvent, sendEvent } from "./hook-lib.mjs";

const checks = [
  ["codex", "codex", ["--version"]],
  ["claude-code", "claude", ["--version"]],
  ["opencode", "opencode", ["--version"]],
];

let failed = false;
for (const [agent, command, args] of checks) {
  const result = process.platform === "win32"
    ? spawnSync([command, ...args].join(" "), { encoding: "utf8", shell: true })
    : spawnSync(command, args, { encoding: "utf8" });
  const version = (result.stdout || result.stderr || "").trim();
  const ok = result.status === 0;
  console.log(`${agent}: ${ok ? version : "missing"}`);
  if (!ok) failed = true;
  try {
    const event = baseEvent(agent, { type: "cli_detected", status: ok ? "ok" : "error" });
    await sendEvent({
      ...event,
      source_surface: "cli-smoke",
      event_type: "cli_detected",
      status: ok ? "ok" : "error",
      meta: { ...event.meta, command, version },
    });
  } catch (error) {
    console.error(`ingest failed for ${agent}: ${error.message}`);
    failed = true;
  }
}

if (failed) process.exitCode = 1;
