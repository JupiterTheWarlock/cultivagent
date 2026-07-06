#!/usr/bin/env node
// Cultivagent Codex hook 入口。
// Codex 把 hook payload 写到 stdin，event 名兜底从 argv[2] 取。
import { baseEvent, readStdinJson, sendEvent } from "./lib.mjs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const input = await readStdinJson();
const event = baseEvent("codex", input, process.argv[2] ?? "hook_event");
await sendEvent(event);

if (isStopEvent(event.event_type, process.argv[2])) {
  spawn(process.execPath, [
    join(dirname(fileURLToPath(import.meta.url)), "session-collector.mjs"),
    "--delay-ms", "3000",
    "--lookback-minutes", "60",
    "--include-incomplete",
    "--batch-size", "10",
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

function isStopEvent(...values) {
  return values.some((value) => String(value ?? "").toLowerCase() === "stop");
}
