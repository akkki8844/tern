
import { describe, it } from "node:test";
import assert from "node:assert";
import { DefaultSandboxRunner } from "./sandbox";

describe("DefaultSandboxRunner", () => {
  it("returns result for missing repo", async () => {
    const runner = new DefaultSandboxRunner();
    const result = await runner.run("/nonexistent", "npm test", { cleanup: true, timeoutMs: 1000 });
    assert.ok(["failed", "errored"].includes(result.status));
  });
});
