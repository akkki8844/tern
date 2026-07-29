
import { describe, it } from "node:test";
import assert from "node:assert";
import { MockLlmAdapter } from "./mock-adapter";

describe("MockLlmAdapter", () => {
  it("returns deterministic guidance", async () => {
    const adapter = new MockLlmAdapter();
    const response = await adapter.complete([{ role: "user", content: "Rename source to payment_method" }]);
    assert.ok(response.content.includes("payment_method"));
  });
});
