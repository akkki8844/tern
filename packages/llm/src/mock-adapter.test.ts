
import { describe, it } from "node:test";
import assert from "node:assert";
import { MockLlmAdapter } from "./mock-adapter.js";

describe("MockLlmAdapter", () => {
  it("returns structured diff for rename", async () => {
    const adapter = new MockLlmAdapter();
    const response = await adapter.completeStructuredDiff([{ role: "user", content: "Rename source to payment_method" }]);
    assert.ok(response.changes.length > 0);
    assert.strictEqual(response.changes[0].replace, "payment_method");
  });

  it("returns empty changes for unknown migration", async () => {
    const adapter = new MockLlmAdapter();
    const response = await adapter.completeStructuredDiff([{ role: "user", content: "Completely unknown transformation" }]);
    assert.strictEqual(response.changes.length, 0);
  });
});
