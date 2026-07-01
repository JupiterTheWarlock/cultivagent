#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createCultivagentServer } from "../src/server.mjs";

// cultivagent token —— 生成 32 字节 hex token，用于 CULTIVAGENT_TOKEN 配置
if (process.argv[2] === "token") {
  process.stdout.write(`${randomBytes(32).toString("hex")}\n`);
  process.exit(0);
}

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (process.argv[i]?.startsWith("--")) args.set(process.argv[i].slice(2), process.argv[i + 1]);
}

const host = args.get("host") ?? process.env.HOST ?? "127.0.0.1";
const port = Number(args.get("port") ?? process.env.PORT ?? 3737);
const dbPath = resolve(args.get("db") ?? process.env.CULTIVAGENT_DB ?? "data/cultivagent.sqlite");
const token = args.get("token") ?? process.env.CULTIVAGENT_TOKEN ?? "";

const server = createCultivagentServer({ dbPath, token });
server.listen(port, host, () => {
  console.log(`cultivagent listening on http://${host}:${port}`);
  console.log(`database: ${dbPath}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      server.cultivagent.db.close();
      process.exit(0);
    });
  });
}
