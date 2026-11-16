import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubError, SecurityError } from "@tern/shared";
import { buildSandboxEnv, runProcess } from "@tern/sandbox";
import { GitRepositoryProvider, LocalRepositoryProvider } from "./repository-provider.js";

/**
 * These tests exercise the real git-based provider against a real local git
 * repository served over file://, so cloning, ref checkout, credential-file cleanup
 * and .git removal are all verified for real rather than mocked.
 */
describe("GitRepositoryProvider", () => {
  let root: string;
  let origin: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "tern-git-"));
    origin = join(root, "origin");
    await mkdir(origin, { recursive: true });

    const env = buildSandboxEnv({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" });
    const git = async (...args: string[]) => {
      const result = await runProcess("git", args, origin, { timeoutMs: 30_000, env, maxOutputBytes: 20_000 });
      assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
    };
    await git("init", "--initial-branch=main");
    await writeFile(join(origin, "openapi.yaml"), "openapi: 3.0.0\n");
    await git("add", ".");
    await git("-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-m", "initial");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("clones a ref into the destination, removes .git and reports the commit sha", async () => {
    const destination = join(root, "checkout-git");
    const provider = new GitRepositoryProvider(
      { mintInstallationToken: async () => "ghs_tokenvalue0000000000" },
      { buildUrl: () => origin }
    );

    const result = await provider.checkout({ installationId: 1, owner: "o", repo: "r", ref: "main" }, destination);

    assert.equal(result.path, destination);
    assert.match(result.commitSha, /^[0-9a-f]{40}$/);
    assert.equal(await readFile(join(destination, "openapi.yaml"), "utf8"), "openapi: 3.0.0\n");
    assert.equal(existsSync(join(destination, ".git")), false, ".git must be removed so nothing downstream can push");
    assert.equal(
      existsSync(join(root, ".tern-credentials-checkout-git")),
      false,
      "the credential file must never survive the checkout"
    );
  });

  it("copies a local repository without its .git directory", async () => {
    const destination = join(root, "checkout-local");
    const local = new LocalRepositoryProvider(origin);
    const result = await local.checkout({ installationId: 1, owner: "o", repo: "r", ref: "abc1234" }, destination);
    assert.equal(result.path, destination);
    assert.equal(await readFile(join(destination, "openapi.yaml"), "utf8"), "openapi: 3.0.0\n");
    assert.equal(existsSync(join(destination, ".git")), false);
  });

  it("rejects unsafe owners, repositories and refs before touching the filesystem", async () => {
    const provider = new GitRepositoryProvider({ mintInstallationToken: async () => "token" });
    const destination = join(root, "never-created");

    await assert.rejects(
      provider.checkout({ installationId: 1, owner: "../etc", repo: "r", ref: "main" }, destination),
      SecurityError
    );
    await assert.rejects(
      provider.checkout({ installationId: 1, owner: "o", repo: "r", ref: "--upload-pack=evil" }, destination),
      GitHubError
    );
    await assert.rejects(
      provider.checkout({ installationId: 1, owner: "o", repo: "r", ref: "a/../../b" }, destination),
      GitHubError
    );
    assert.equal(existsSync(destination), false);
  });

  it("never leaves the credential file behind, even when the clone fails", async () => {
    const destination = join(root, "failed-clone");
    const provider = new GitRepositoryProvider(
      { mintInstallationToken: async () => "ghs_tokenvalue0000000000" },
      { host: "127.0.0.1:1" }
    );

    await assert.rejects(
      provider.checkout({ installationId: 1, owner: "o", repo: "r", ref: "main" }, destination),
      GitHubError
    );
    assert.equal(existsSync(join(root, ".tern-credentials-failed-clone")), false);
  });
});

describe("LocalRepositoryProvider", () => {
  it("is marked as not real so publishing cannot be mistaken for production", () => {
    assert.equal(new LocalRepositoryProvider("/tmp").isReal, false);
  });
});
