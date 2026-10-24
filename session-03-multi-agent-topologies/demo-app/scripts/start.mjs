import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
process.env.SESSION2_MODE = process.argv[2] || process.env.SESSION2_MODE || "local";
const { spawn } = await import("node:child_process");
const child = spawn(process.execPath, ["src/server.mjs"], {
  stdio: "inherit", env: process.env,
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => child.kill(signal));
child.once("exit", (code) => process.exit(code || 0));
