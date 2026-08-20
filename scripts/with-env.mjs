#!/usr/bin/env node
/**
 * Run a command with the repo-root .env loaded (never overriding variables
 * already set in the shell). Cross-platform replacement for `set -a; . .env`.
 *
 *   node scripts/with-env.mjs npx prisma migrate deploy
 *   node scripts/with-env.mjs npm run prisma:seed --workspace=apps/server
 *
 * The Prisma CLI only auto-loads .env from its own cwd/prisma dir, Next.js
 * loads it per app, and plain `node` never does — so the root npm scripts go
 * through this to behave identically on macOS, Linux and Windows.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(ROOT, ".env");
if (existsSync(envFile)) {
  for (const raw of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else { const h = value.search(/\s#/); if (h >= 0) value = value.slice(0, h).trimEnd(); }
    process.env[key] = value;
  }
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error("usage: with-env.mjs <command> [args…]"); process.exit(2); }
// npm/npx are .cmd shims on Windows and need a shell to launch.
const isShim = process.platform === "win32" && /^(npm|npx|turbo|prisma|tsx|next)$/.test(cmd);
const child = spawn(cmd, args, { stdio: "inherit", shell: isShim, env: process.env, windowsHide: true });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
