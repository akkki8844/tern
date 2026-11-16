import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertGitHubSlug,
  assertSafeBranchName,
  assertSafeCommandName,
  assertNotOption,
  assertSafeProcessArg,
  isForbiddenPath,
  isWithin,
  normalizeRelativePath,
  resolveWithin,
  safeEqual
} from "./security.js";
import { SecurityError } from "./errors.js";

describe("normalizeRelativePath", () => {
  it("normalises ordinary paths", () => {
    assert.equal(normalizeRelativePath("src/./api/client.ts"), "src/api/client.ts");
    assert.equal(normalizeRelativePath("src\\api\\client.ts"), "src/api/client.ts");
  });

  const rejected = [
    ["traversal", "../../etc/passwd"],
    ["embedded traversal", "src/../../etc/passwd"],
    ["absolute", "/etc/passwd"],
    ["windows absolute", "C:\\Windows\\system32"],
    ["unc", "\\\\server\\share"],
    ["null byte", "src/a\0b.ts"],
    ["empty", ""],
    ["dot only", "."]
  ] as const;

  for (const [name, value] of rejected) {
    it(`rejects ${name}`, () => {
      assert.throws(() => normalizeRelativePath(value), SecurityError);
    });
  }
});

describe("resolveWithin", () => {
  const root = mkdtempSync(join(tmpdir(), "capibara-sec-"));

  it("resolves inside the root", () => {
    assert.equal(resolveWithin(root, "a/b.ts"), join(root, "a/b.ts"));
  });

  it("refuses to escape the root", () => {
    assert.throws(() => resolveWithin(root, "../outside.ts"), SecurityError);
  });

  it("refuses a path that normalises out of the root", () => {
    assert.throws(() => resolveWithin(root, "a/../../b.ts"), SecurityError);
  });

  it("isWithin rejects sibling directories with a shared prefix", () => {
    assert.equal(isWithin("/var/lib/capibara", "/var/lib/capibara-evil/file"), false);
    assert.equal(isWithin("/var/lib/capibara", "/var/lib/capibara/file"), true);
    assert.equal(isWithin("/var/lib/capibara", "/var/lib/capibara"), true);
  });
});

describe("isForbiddenPath", () => {
  const forbidden = [
    ".env",
    ".env.local",
    "config/.env.production",
    ".git/config",
    ".ssh/id_rsa",
    "deploy/key.pem",
    "secrets.json",
    "app/credentials.yaml",
    "node_modules/left-pad/index.js",
    ".npmrc"
  ];
  for (const path of forbidden) {
    it(`forbids ${path}`, () => assert.equal(isForbiddenPath(path), true));
  }

  const allowed = ["src/index.ts", "docs/environment.md", "package.json", "src/environment.ts"];
  for (const path of allowed) {
    it(`allows ${path}`, () => assert.equal(isForbiddenPath(path), false));
  }
});

describe("process and git argument validation", () => {
  it("accepts legitimate arguments, including ones containing shell metacharacters", () => {
    // Safe because Capibara always spawns with shell: false — these are inert bytes.
    assert.equal(assertSafeProcessArg("--ignore-scripts"), "--ignore-scripts");
    assert.equal(assertSafeProcessArg("console.log(40 + 2)"), "console.log(40 + 2)");
    assert.equal(assertSafeProcessArg("a; rm -rf /"), "a; rm -rf /");
  });

  it("rejects arguments that can corrupt the exec boundary or the logs", () => {
    for (const arg of ["a\u0000b", "a\nb", "a\u001bb", "", "x".repeat(9000)]) {
      assert.throws(() => assertSafeProcessArg(arg), SecurityError, `expected rejection for ${JSON.stringify(arg)}`);
    }
  });

  it("is strict about the executable name", () => {
    assert.equal(assertSafeCommandName("npm"), "npm");
    assert.equal(assertSafeCommandName("/usr/bin/node"), "/usr/bin/node");
    for (const command of ["npm; rm -rf /", "$(whoami)", "../../bin/sh", "npm run", "-rf", ""]) {
      assert.throws(() => assertSafeCommandName(command), SecurityError, `expected rejection for ${command}`);
    }
  });

  it("blocks option injection where a value is expected", () => {
    assert.equal(assertNotOption("main"), "main");
    assert.throws(() => assertNotOption("--upload-pack=evil"), SecurityError);
  });

  it("accepts valid branch names", () => {
    assert.equal(assertSafeBranchName("capibara/migrate-abc123"), "capibara/migrate-abc123");
  });

  it("rejects dangerous branch names", () => {
    for (const branch of ["--upload-pack=evil", "a..b", "a b", "a~1", "refs/heads/x.lock", "a//b", "x@{1}"]) {
      assert.throws(() => assertSafeBranchName(branch), SecurityError, `expected rejection for ${branch}`);
    }
  });

  it("validates GitHub owner and repo slugs", () => {
    assert.equal(assertGitHubSlug("acme-corp", "owner"), "acme-corp");
    assert.equal(assertGitHubSlug("capibara.js", "repo"), "capibara.js");
    assert.throws(() => assertGitHubSlug("../../etc", "owner"), SecurityError);
    assert.throws(() => assertGitHubSlug("a/b", "repo"), SecurityError);
  });
});

describe("safeEqual", () => {
  it("compares equal strings", () => {
    assert.equal(safeEqual("abc", "abc"), true);
  });
  it("rejects different strings of equal length", () => {
    assert.equal(safeEqual("abc", "abd"), false);
  });
  it("rejects different lengths without throwing", () => {
    assert.equal(safeEqual("abc", "abcd"), false);
    assert.equal(safeEqual("", "a"), false);
  });
});
