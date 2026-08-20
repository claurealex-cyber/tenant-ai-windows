import { defineConfig, type Plugin } from "vitest/config";
import path from "path";
import { existsSync, readFileSync } from "fs";

const ROOT = __dirname;

/**
 * Load the local-infra connection strings from the repo-root .env into the
 * test environment WITHOUT overriding variables the shell already set.
 *
 * Only DATABASE_URL and REDIS_URL are taken: the integration tests need a
 * database, but several tests assert "no integration env vars are set"
 * (PUBLIC_URL, TWILIO_*, …), so loading the whole file would change their
 * outcome. Same non-overriding rule as apps/server/src/lib/load-env.ts and
 * scripts/launch.mjs; makes `npx vitest run` work from a bare prompt on
 * macOS, Linux and Windows alike.
 */
const TEST_ENV_KEYS = new Set(["DATABASE_URL", "REDIS_URL"]);
function envFromDotenv(): Record<string, string> {
  const file = path.join(ROOT, ".env");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!TEST_ENV_KEYS.has(key) || process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else { const h = value.search(/\s#/); if (h >= 0) value = value.slice(0, h).trimEnd(); }
    out[key] = value;
  }
  return out;
}
const TENANT_SITE_SRC = path.resolve(ROOT, "apps/tenant-site/src");
const DASHBOARD_SRC = path.resolve(ROOT, "apps/dashboard/src");

/**
 * Resolves the @/ alias contextually based on the importing file's location.
 * Files in apps/tenant-site/ → apps/tenant-site/src/
 * Files in apps/dashboard/  → apps/dashboard/src/
 * Fallback                  → apps/dashboard/src/
 */
function contextualAliasPlugin(): Plugin {
  return {
    name: "contextual-at-alias",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!source.startsWith("@/")) return null;
      const relative = source.slice(2); // strip "@/"
      // Normalize to forward slashes so the match also works on Windows,
      // where Vite hands us backslash-separated importer paths.
      const importerPosix = importer ? importer.replace(/\\/g, "/") : "";
      const base = importerPosix.includes("/apps/tenant-site/")
        ? TENANT_SITE_SRC
        : DASHBOARD_SRC;
      const fullPath = path.resolve(base, relative);
      // Use Vite's resolver for extension resolution (.ts, .js, /index.ts, etc.)
      const resolved = await this.resolve(fullPath, importer, {
        ...options,
        skipSelf: true,
      });
      return resolved ?? fullPath;
    },
  };
}

export default defineConfig({
  plugins: [contextualAliasPlugin()],
  test: {
    include: [
      "packages/shared/src/__tests__/**/*.test.ts",
      "apps/server/src/__tests__/**/*.test.ts",
      "apps/dashboard/src/__tests__/**/*.test.ts",
      "apps/dashboard/src/__tests__/**/*.test.tsx",
      "apps/tenant-site/src/__tests__/**/*.test.ts",
      "apps/tenant-site/src/__tests__/**/*.test.tsx",
    ],
    exclude: ["**/dist/**", "**/node_modules/**"],
    testTimeout: 30000,
    env: envFromDotenv(),
  },
});
