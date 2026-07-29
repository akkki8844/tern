
import { describe, it } from "node:test";
import assert from "node:assert";
import { FireworksAdapter } from "./fireworks-adapter";

describe("FireworksAdapter", () => {
  it("trims messages", async () => {
    const adapter = new FireworksAdapter();
    const result = (adapter as any).truncateContent("a\n".repeat(10000), 100);
    assert.ok(result.endsWith("[truncated]"));
  });
});
