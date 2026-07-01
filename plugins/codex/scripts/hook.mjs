#!/usr/bin/env node
// Cultivagent Codex hook 入口。
// Codex 把 hook payload 写到 stdin，event 名兜底从 argv[2] 取。
import { baseEvent, readStdinJson, sendEvent } from "./lib.mjs";

const input = await readStdinJson();
await sendEvent(baseEvent("codex", input, process.argv[2] ?? "hook_event"));
