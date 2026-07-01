#!/usr/bin/env node
// /cultivagent-status —— 打印 plugin 状态：endpoint、token 预览、server 健康。
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
const endpoint = (process.env.CULTIVAGENT_ENDPOINT ?? cfg.endpoint ?? "http://127.0.0.1:3737").replace(/\/$/, "");
const token = process.env.CULTIVAGENT_TOKEN ?? cfg.token ?? "";

console.log("cultivagent plugin status");
console.log(`  endpoint: ${endpoint}`);
console.log(`  token:    ${token ? token.slice(0, 6) + "…" + " (len " + token.length + ")" : "(none — local mode)"}`);

try {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${endpoint}/api/health`, { headers });
  console.log(`  health:   ${r.status === 200 ? "OK" : "HTTP " + r.status}`);
} catch (e) {
  console.log(`  health:   UNREACHABLE (${e.message})`);
}
