
import { describe, it } from "node:test";
import assert from "node:assert";
import { redactSecrets, sanitizePath, isExecutableContent, constantTimeCompare } from "./security";

describe("security helpers", () => {
  it("redacts api keys", () => {
    const out = redactSecrets("key = sk-123456789012345678901234");
    assert.ok(!out.includes("sk-123456789012345678901234"));
    assert.ok(out.includes("REDACTED"));
  });

  it("redacts github tokens", () => {
    const out = redactSecrets("token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.ok(!out.includes("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  });

  it("rejects path traversal", () => {
    assert.throws(() => sanitizePath("../../../etc/passwd"));
  });

  it("detects executable content", () => {
    assert.strictEqual(isExecutableContent("eval(x)"), true);
    assert.strictEqual(isExecutableContent("const x = 1"), false);
  });

  it("compares strings in constant time", () => {
    assert.strictEqual(constantTimeCompare("abc", "abc"), true);
    assert.strictEqual(constantTimeCompare("abc", "abx"), false);
    assert.strictEqual(constantTimeCompare("abc", "abcd"), false);
  });
});
