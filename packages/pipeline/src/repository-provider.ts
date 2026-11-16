import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import {
  GitHubError,
  assertGitHubSlug,
  getLogger,
  internalMessageOf,
  isWithin,
  type RepositoryCheckout,
  type RepositoryProvider
} from "@capibara/shared";
import { buildSandboxEnv, runProcess } from "@capibara/sandbox";
import type { GitHubAppProvider } from "@capibara/github";

const logger = getLogger("repository-provider");

const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 20_000;

/**
 * Materialise a repository with git.
 *
 * Credential handling: the installation token is written to a 0600 credential file
 * inside the workspace and referenced through `credential.helper`. It is never put
 * in the clone URL, never in argv (visible in /proc), and never in the environment;
 * the file is deleted as soon as the clone finishes, in a finally block.
 */
export class GitRepositoryProvider implements RepositoryProvider {
  readonly name = "git";
  readonly isReal = true;

  private readonly host: string;
  private readonly buildUrl: (owner: string, repo: string) => string;

  constructor(
    private readonly tokenSource: Pick<GitHubAppProvider, "mintInstallationToken">,
    options: { host?: string; buildUrl?: (owner: string, repo: string) => string } = {}
  ) {
    this.host = options.host ?? "github.com";
    // Overridable so the clone path can be exercised against a local origin in tests.
    this.buildUrl = options.buildUrl ?? ((owner, repo) => `https://${this.host}/${owner}/${repo}.git`);
  }

  async checkout(
    params: { installationId: number; owner: string; repo: string; ref: string },
    destination: string
  ): Promise<RepositoryCheckout> {
    assertGitHubSlug(params.owner, "owner");
    assertGitHubSlug(params.repo, "repo");
    assertRef(params.ref);

    await mkdir(destination, { recursive: true, mode: 0o700 });
    // The credential file lives *beside* the checkout: git refuses to clone into a
    // non-empty directory, and nothing inside the checkout should ever see it.
    const credentialsPath = join(dirname(destination), `.capibara-credentials-${basename(destination)}`);

    try {
      const token = await this.tokenSource.mintInstallationToken(params.installationId);
      await writeFile(credentialsPath, `https://x-access-token:${token}@${this.host}\n`, { mode: 0o600 });

      const url = this.buildUrl(params.owner, params.repo);
      await this.git(
        ["-c", `credential.helper=store --file=${credentialsPath}`, "clone", "--no-tags", "--depth", "1", url, "."],
        destination,
        "clone"
      );
      await this.git(["fetch", "--depth", "1", "origin", params.ref], destination, "fetch");
      await this.git(["checkout", "--force", "FETCH_HEAD"], destination, "checkout");

      const head = await this.git(["rev-parse", "HEAD"], destination, "rev-parse");
      const commitSha = head.stdout.trim();

      logger.info("repository checked out", {
        owner: params.owner,
        repo: params.repo,
        ref: params.ref,
        commitSha
      });
      return { path: destination, commitSha };
    } finally {
      // The credential file must not survive the clone, even on failure.
      await rm(credentialsPath, { force: true });
      // .git holds the remote config; drop it so nothing downstream can push.
      await rm(join(destination, ".git"), { recursive: true, force: true });
    }
  }

  private async git(args: string[], cwd: string, operation = args[0]) {
    const result = await runProcess("git", args, cwd, {
      timeoutMs: CLONE_TIMEOUT_MS,
      env: buildSandboxEnv({ GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" }),
      maxOutputBytes: MAX_OUTPUT_BYTES
    });
    if (result.exitCode !== 0) {
      throw new GitHubError("git operation failed", {
        code: "GIT_COMMAND_FAILED",
        retryable: !result.timedOut,
        details: { operation, stderr: result.stderr.slice(0, 500) }
      });
    }
    return result;
  }
}

/**
 * Materialise a repository from a local directory.
 *
 * Used by demo mode and by tests. It is a real implementation (it really copies a
 * real tree), it just does not reach the network.
 */
export class LocalRepositoryProvider implements RepositoryProvider {
  readonly name = "local";
  readonly isReal = false;

  constructor(private readonly sourceRoot: string) {}

  async checkout(
    params: { installationId: number; owner: string; repo: string; ref: string },
    destination: string
  ): Promise<RepositoryCheckout> {
    const source = join(this.sourceRoot);
    if (!isWithin(this.sourceRoot, source)) {
      throw new GitHubError("Local repository source escapes its root", { code: "LOCAL_REPO_PATH_INVALID" });
    }
    await mkdir(destination, { recursive: true, mode: 0o700 });
    try {
      const excluded = new Set([".git", "node_modules", ".next", "dist", "coverage"]);
      await cp(source, destination, {
        recursive: true,
        // Skip VCS metadata and build output: they must never enter a workspace.
        filter: (path) => !relative(source, path).split("/").some((segment) => excluded.has(segment))
      });
    } catch (error) {
      throw new GitHubError("Failed to copy the local repository", {
        code: "LOCAL_REPO_COPY_FAILED",
        cause: error,
        details: { reason: internalMessageOf(error) }
      });
    }
    return { path: destination, commitSha: params.ref };
  }
}

function assertRef(ref: string): void {
  if (!/^[A-Za-z0-9._\-/]{1,255}$/.test(ref) || ref.includes("..") || ref.startsWith("-")) {
    throw new GitHubError("Invalid git ref", { code: "GIT_REF_INVALID" });
  }
}
