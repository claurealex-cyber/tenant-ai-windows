import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnvFile, loadEnvFile } from "../lib/load-env.js";

describe("parseEnvFile", () => {
  it("parses KEY=VALUE, ignores comments/blank lines, strips inline comments", () => {
    const parsed = parseEnvFile(
      [
        "# comment",
        "",
        "PLAIN=hello",
        "WITH_COMMENT=value   # trailing comment",
        "URL=postgresql://u:p@localhost:5433/db",
        "export EXPORTED=yes",
        "HASH_IN_VALUE=abc#notacomment",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      PLAIN: "hello",
      WITH_COMMENT: "value",
      URL: "postgresql://u:p@localhost:5433/db",
      EXPORTED: "yes",
      HASH_IN_VALUE: "abc#notacomment",
    });
  });

  it("handles quoted values and CRLF line endings (Windows checkouts)", () => {
    const parsed = parseEnvFile('A="quoted # not a comment"\r\nB=\'single\'\r\nC="line1\\nline2"\r\n');
    expect(parsed.A).toBe("quoted # not a comment");
    expect(parsed.B).toBe("single");
    expect(parsed.C).toBe("line1\nline2");
  });

  it("skips malformed keys", () => {
    expect(parseEnvFile("1BAD=x\n=novalue\nOK=1")).toEqual({ OK: "1" });
  });
});

describe("loadEnvFile", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tenant-ai-env-"));
  const file = path.join(dir, ".env");
  const KEY_NEW = "TENANT_AI_TEST_NEW_VAR";
  const KEY_EXISTING = "TENANT_AI_TEST_EXISTING_VAR";

  afterEach(() => {
    delete process.env[KEY_NEW];
    delete process.env[KEY_EXISTING];
  });

  it("sets missing vars but never overrides ones already in the environment", () => {
    writeFileSync(file, `${KEY_NEW}=from-file\n${KEY_EXISTING}=from-file\n`);
    process.env[KEY_EXISTING] = "from-launcher";
    const used = loadEnvFile(file);
    expect(used).toBe(file);
    expect(process.env[KEY_NEW]).toBe("from-file");
    expect(process.env[KEY_EXISTING]).toBe("from-launcher");
    rmSync(dir, { recursive: true, force: true });
  });
});
