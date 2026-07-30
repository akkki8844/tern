
import { describe, it } from "node:test";
import assert from "node:assert";
import { GitHubAppLifecycle } from "./lifecycle.js";

describe("GitHubAppLifecycle", () => {
  const lifecycle = new GitHubAppLifecycle();
  it("handles installation created", () => {
    const result = lifecycle.handleInstallation({ event: "installation", action: "created", installation: { id: 123, account: { id: 1, login: "acme" } }, repositories: [{ id: 1, full_name: "acme/api" }] });
    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.installationId, 123);
    assert.strictEqual(result.accountLogin, "acme");
    assert.strictEqual(result.repositories?.[0].name, "api");
  });
});
