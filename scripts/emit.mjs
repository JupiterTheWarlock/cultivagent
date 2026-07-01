#!/usr/bin/env node
import { readStdinJson, sendEvent } from "./hook-lib.mjs";

const event = await readStdinJson();
await sendEvent(event);
console.log("sent");
