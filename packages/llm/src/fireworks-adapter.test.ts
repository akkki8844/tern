
import { describe, it } from "node:test";
import assert from "node:assert";
import { FireworksAdapter } from "./fireworks-adapter.js";

describe("FireworksAdapter", () => {
  it("trims messages", () => {
    const adapter = new FireworksAdapter();
    const result = (adapter as any).truncateContent("a\n".repeat(10000), 100);
    assert.ok(result.endsWith("[truncated]"));
  });

  it("parses and validates structured diffs", () => {
    const adapter = new FireworksAdapter();
    const parsed = (adapter as any).parseStructuredDiff(`{"thinking":"x","changes":[{"filePath":"x.ts","search":"a","replace":"b","reason":"r"}]}`);
    assert.strictEqual(parsed.changes.length, 1);
    assert.doesNotThrow(() => (adapter as any).validateStructuredDiff(parsed));
  });

  it("rejects structured diffs with no changes", () => {
    const adapter = new FireworksAdapter();
    const parsed = (adapter as any).parseStructuredDiff(`{"thinking":"x","changes":[{"filePath":"x.ts","search":"a","replace":"a","reason":"r"}]}`);
    assert.throws(() => (adapter as any).validateStructuredDiff(parsed));
  });
});
