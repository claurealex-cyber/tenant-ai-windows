/**
 * Minimal .env reader shared by the root scripts (launcher, infra, with-env).
 * Same rules as apps/server/src/lib/load-env.ts: `KEY=value`, optional
 * `export `, quotes stripped, ` #` starts a comment, and loading NEVER
 * overrides a variable the shell already set.
 */
import { existsSync, readFileSync } from "node:fs";

export function parseEnvFile(contents) {
  const out = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      const q = value[0];
      value = value.slice(1, -1);
      if (q === '"') value = value.replace(/\\n/g, "\n");
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    out[key] = value;
  }
  return out;
}

/** Load `file` into process.env without overriding existing variables. Returns the parsed map. */
export function loadEnvFile(file) {
  if (!existsSync(file)) return {};
  const parsed = parseEnvFile(readFileSync(file, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return parsed;
}
