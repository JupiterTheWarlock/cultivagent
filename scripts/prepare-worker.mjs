import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

mkdirSync(join("worker", "public"), { recursive: true });
copyFileSync(join("src", "dashboard.html"), join("worker", "public", "index.html"));
