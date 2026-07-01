#!/usr/bin/env node
// Cultivagent Claude Code hook 入口。
// Claude Code 把 hook payload 写到 stdin，event 名兜底从 argv[2] 取。
// 实际 event_type 优先用 stdin payload 的 hook_event_name（见 lib.mjs baseEvent）。
import { baseEvent, readStdinJson, sendEvent } from "./lib.mjs";

const input = await readStdinJson();
await sendEvent(baseEvent("claude-code", input, process.argv[2] ?? "hook_event"));
