import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load `.env` into process.env at boot — without overriding variables that are
 * already set (a launcher or systemd/Task Scheduler environment always wins).
 *
 * Why this exists: Next.js and the Prisma CLI read `.env` themselves, but a
 * plain `node dist/index.js` does not. On the Mac the launcher sourced `.env`
 * into the shell (`set -a; . ./.env`), which hid this. This makes the server
 * self-sufficient on every OS: `npm start` from a bare prompt just works.
 *
 * Lookup order (first hit wins): $TENANT_AI_ENV_FILE, ./.env (cwd), and the
 * repo root `.env` relative to this file (works from src/ via tsx and from
 * dist/ after tsc — both are two levels below apps/server).
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n");
    } else {
      // Unquoted: strip a trailing "  # comment"
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    out[key] = value;
  }
  return out;
}

export function loadEnvFile(explicitPath?: string): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicitPath,
    process.env.TENANT_AI_ENV_FILE,
    path.resolve(process.cwd(), ".env"),
    // apps/server/{src,dist}/lib → repo root
    path.resolve(here, "..", "..", "..", "..", ".env"),
  ].filter((p): p is string => Boolean(p));

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const parsed = parseEnvFile(readFileSync(file, "utf8"));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
    return file;
  }
  return null;
}

// Side-effect import: `import "./lib/load-env.js"` at the very top of index.ts.
loadEnvFile();
