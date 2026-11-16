import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHmac } from "node:crypto";
import { ConfigurationError, GitHubError, SecurityError, loadConfig, secret } from "@tern/shared";
import { GitHubAppProvider } from "./github-app-provider.js";
import { DemoGitHubProvider, DEMO_OWNER, DEMO_REPO } from "./demo-github-provider.js";
import { createGitHubProvider } from "./factory.js";

const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",
  "KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQJAIJLixBy2qpFoS4DSmoEm",
  "o3qGy0t6z09AIJtH+5OeRV1be+N4cDYJKffGzDa88vQENZiRm0GRq6a+HPGQMd2k",
  "TQIhAKMSvzIBnni7ot/OSie2TmJLY4SwTQAevXysE2RbFDYdAiEBCUEaRQnMnbp7",
  "9mxDXDf6AU0cN/RPBjb9qSHDcWZHGzUCIG2Es59z8ugGrDY+pxLQnwfotadxd+Uy",
  "v/Ow5T0q5gIJAiEAyS4RaI9YG8EWx/2w0T67ZUVAw8eOMB6BIUg0Xcu+3okCIBOs",
  "/5OiPgoTdSy7bcF9IGpSE8ZgGKzgYQVZeN97YE00",
  "-----END RSA PRIVATE KEY-----"
].join("\n");

const REAL_ENV = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/tern",
  GITHUB_APP_ID: "123456",
  GITHUB_PRIVATE_KEY: PEM,
  GITHUB_WEBHOOK_SECRET: "0123456789abcdefgh"
};

describe("createGitHubProvider", () => {
  it("returns the demo provider in demo mode", () => {
    const provider = createGitHubProvider(loadConfig({ env: { DATABASE_URL: REAL_ENV.DATABASE_URL, TERN_MODE: "demo" } }));
    assert.equal(provider.isReal, false);
    assert.equal(provider.name, "github-demo");
  });

  it("returns the App provider when credentials are present", () => {
    const provider = createGitHubProvider(loadConfig({ env: REAL_ENV }));
    assert.equal(provider.isReal, true);
    assert.equal(provider.name, "github-app");
  });

  it("refuses to silently fall back to demo when credentials are missing", () => {
    assert.throws(
      () => createGitHubProvider(loadConfig({ env: { DATABASE_URL: REAL_ENV.DATABASE_URL } })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /GitHub App credentials are required outside demo mode/);
        return true;
      }
    );
  });
});

describe("GitHubAppProvider", () => {
  it("cannot be constructed without a configured App", () => {
    const config = loadConfig({ env: { DATABASE_URL: REAL_ENV.DATABASE_URL } });
    assert.throws(() => new GitHubAppProvider(config.githubApp), ConfigurationError);
  });

  it("verifies webhook signatures with the configured secret", () => {
    const config = loadConfig({ env: REAL_ENV });
    const provider = new GitHubAppProvider(config.githubApp);
    const body = '{"zen":"Keep it logically awesome."}';
    const good = `sha256=${require$hmac(body, REAL_ENV.GITHUB_WEBHOOK_SECRET)}`;
    assert.equal(provider.verifyWebhookSignature(body, good), true);
    assert.equal(provider.verifyWebhookSignature(body, "sha256=deadbeef"), false);
  });

  it("rejects unsafe owner, repo and branch names before any network call", async () => {
    const provider = new GitHubAppProvider(loadConfig({ env: REAL_ENV }).githubApp);
    await assert.rejects(() => provider.getRepository(1, "../evil", "repo"), SecurityError);
    await assert.rejects(() => provider.getRepository(1, "owner", "re/po"), SecurityError);
    await assert.rejects(() => provider.createBranch(1, "o", "r", "--upload-pack=x", "abc1234"), SecurityError);
    await assert.rejects(() => provider.getBranchHead(1, "o", "r", "a b"), SecurityError);
  });

  it("rejects an invalid base sha before any network call", async () => {
    const provider = new GitHubAppProvider(loadConfig({ env: REAL_ENV }).githubApp);
    await assert.rejects(() => provider.createBranch(1, "o", "r", "tern/x", "not-a-sha"), GitHubError);
  });

  it("refuses to create an empty commit", async () => {
    const provider = new GitHubAppProvider(loadConfig({ env: REAL_ENV }).githubApp);
    await assert.rejects(() => provider.commitFiles(1, "o", "r", "tern/x", "msg", []), /empty commit/);
  });

  it("rejects an invalid installation id before any network call", async () => {
    const provider = new GitHubAppProvider(loadConfig({ env: REAL_ENV }).githubApp);
    await assert.rejects(() => provider.listInstallationRepositories(0), /GitHub listInstallationRepositories failed/);
  });

  it("exposes no merge or approve operation", () => {
    const provider = new GitHubAppProvider(loadConfig({ env: REAL_ENV }).githubApp);
    const surface = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(provider)),
      ...Object.keys(provider)
    ].join(" ");
    assert.ok(!/merge/i.test(surface), "the GitHub provider must not expose a merge operation");
    assert.ok(!/approve/i.test(surface));
  });
});

describe("DemoGitHubProvider", () => {
  it("is marked as not real", () => {
    assert.equal(new DemoGitHubProvider().isReal, false);
  });

  it("supports the full branch -> commit -> pull request flow in memory", async () => {
    const provider = new DemoGitHubProvider();
    const repo = await provider.getRepository(1, DEMO_OWNER, DEMO_REPO);
    const head = await provider.getBranchHead(1, DEMO_OWNER, DEMO_REPO, repo.defaultBranch);

    await provider.createBranch(1, DEMO_OWNER, DEMO_REPO, "tern/migrate-1", head.sha);
    const commit = await provider.commitFiles(1, DEMO_OWNER, DEMO_REPO, "tern/migrate-1", "fix: migrate", [
      { path: "src/client.ts", content: "export const x = 2;" }
    ]);
    assert.match(commit.sha, /^[0-9a-f]{40}$/);

    const pr = await provider.createPullRequest({
      installationId: 1,
      owner: DEMO_OWNER,
      repo: DEMO_REPO,
      title: "fix: migrate",
      body: "body",
      head: "tern/migrate-1",
      base: "main"
    });
    assert.equal(pr.number, 1);
    assert.equal(pr.draft, true, "demo PRs are drafts, like real ones");
    assert.equal(provider.listPullRequests().length, 1);
  });

  it("uses non-routable URLs so a demo PR can never be mistaken for a real one", async () => {
    const provider = new DemoGitHubProvider();
    const repo = await provider.getRepository(1, DEMO_OWNER, DEMO_REPO);
    assert.match(repo.url, /github\.invalid/);
  });

  it("rejects webhook signatures when no secret is configured", () => {
    assert.equal(new DemoGitHubProvider().verifyWebhookSignature("{}", "sha256=" + "a".repeat(64)), false);
  });

  it("verifies signatures when a secret is configured", () => {
    const key = "demo-webhook-secret-value";
    const provider = new DemoGitHubProvider(secret(key, "GITHUB_WEBHOOK_SECRET"));
    const body = '{"zen":"x"}';
    assert.equal(provider.verifyWebhookSignature(body, `sha256=${require$hmac(body, key)}`), true);
  });

  it("fails loudly for unknown repositories rather than inventing data", async () => {
    await assert.rejects(() => new DemoGitHubProvider().getRepository(1, "someone", "else"), GitHubError);
  });
});

function require$hmac(body: string, key: string): string {
  return createHmac("sha256", key).update(body, "utf8").digest("hex");
}
