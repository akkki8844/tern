
import { describe, it } from "node:test";
import assert from "node:assert";
import { MockGitHubService } from "./mock-github-service.js";
import { createHmac } from "crypto";

describe("MockGitHubService", () => {
  const svc = new MockGitHubService();
  const secret = "test-secret";

  it("verifies webhook signature", async () => {
    const payload = JSON.stringify({ action: "created" });
    const signature = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    assert.ok(svc.verifyWebhook(payload, signature, secret));
    assert.ok(!svc.verifyWebhook(payload, "sha256=bad", secret));
  });

  it("lists demo repositories", async () => {
    const repos = await svc.listRepositories(123);
    assert.strictEqual(repos.length, 1);
    assert.strictEqual(repos[0].owner, "tern-demo");
  });

  it("creates branch and commit", async () => {
    await svc.createBranch(123, "tern-demo", "acmepay-demo", "fix/api", "abc123");
    const commit = await svc.createCommit(123, "tern-demo", "acmepay-demo", "fix/api", "fix", { "src/index.ts": "// fixed" });
    assert.ok(commit.sha.startsWith("mock-"));
  });

  it("creates pull request", async () => {
    const pr = await svc.createPullRequest({ installationId: 123, owner: "tern-demo", repo: "acmepay-demo", title: "fix", body: "body", head: "fix/api", base: "main" });
    assert.strictEqual(pr.status, "open");
    assert.strictEqual(pr.number, 1);
  });
});
