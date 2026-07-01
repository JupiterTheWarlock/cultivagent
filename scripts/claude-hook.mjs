#!/usr/bin/env node
import { baseEvent, readStdinJson, sendEvent } from "./hook-lib.mjs";

const input = await readStdinJson();
await sendEvent(baseEvent("claude-code", input, process.argv[2] ?? "hook_event"));
