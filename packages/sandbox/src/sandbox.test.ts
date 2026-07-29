
import { describe, it } from "node:test";
import assert from "node:assert";
import { DefaultSandboxRunner } from "./sandbox";

describe("DefaultSandboxRunner", () => {
  it("returns result for missing repo", async () => {
    const runner = new DefaultSandboxRunner();
    const result = await runner.run("/nonexistent", "npm test", { cleanup: true, timeoutMs: 1000 });
    assert.ok(["failed", "errored"].includes(result.status));
    assert.strictEqual(result.stdout.indexOf("secret"), -1);
  });

  it("sanitizes environment secrets", async () => {
    process.env.FIREWORKS_API_KEY = "super-secret";
    const runner = new DefaultSandboxRunner();
    const opts = (runner as any).sanitizeOptions({ env: { FIREWORKS_API_KEY: "super-secret" } });
    assert.strictEqual(opts.env.FIREWORKS_API_KEY, "[REDACTED]");
    delete process.env.FIREWORKS_API_KEY;
  });
});
