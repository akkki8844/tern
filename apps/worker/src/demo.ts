import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { copyFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { configureLogging, getLogger, initConfig } from "@capibara/shared";
import { DemoGitHubProvider, DEMO_OWNER, DEMO_REPO } from "@capibara/github";
import { DemoAIProvider } from "@capibara/llm";
import { FilesystemWorkspaceProvider, withWorkspace } from "@capibara/workspace";
import { ProcessSandboxRunner } from "@capibara/sandbox";
import { LocalRepositoryProvider, runAnalysisPipeline, type StageContext } from "@capibara/pipeline";
import { analyzeSpecChange, formatChangeReport, loadFromString } from "@capibara/openapi";

/**
 * Demo mode.
 *
 * Runs the real pipeline — real diffing, real scanning, real deterministic
 * migration, real patch validation, real sandboxed install/build/test — against the
 * bundled AcmePay example, using in-memory providers for GitHub and the AI fallback.
 *
 * It touches no network, no database and no real repository. It is kept in its own
 * entrypoint so demo wiring can never leak into the production runtime.
 */
/**
 * Deterministic rename table used by the demo AI provider. It mirrors
 * demo/migration-map.json, so the demo exercises the AI fallback path with a
 * predictable, offline "model".
 */
const DEMO_RENAMES = new Map<string, string>([
  ["createCharge", "createPayment"],
  ["retrieveCharge", "retrievePayment"],
  ["source:", "payment_method:"],
  ["/charges", "/payments"]
]);

/** Repository root, derived from this file so the demo does not depend on the cwd. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function main(): Promise<void> {
  const config = initConfig({
    // Demo mode is forced here, not read from the environment, so this entrypoint
    // can never accidentally talk to real providers.
    overrides: { CAPIBARA_MODE: "demo", DATABASE_URL: "postgresql://demo:demo@localhost:5432/capibara_demo" },
    defaultWorkspaceRoot: join(tmpdir(), "capibara-demo-workspaces"),
    defaultDemoRepoPath: join(REPO_ROOT, "demo", "broken-app")
  });
  configureLogging({ ...config.logging, pretty: true });
  const logger = getLogger("demo");

  if (!config.demoMode) throw new Error("demo entrypoint must run in demo mode");

  const github = new DemoGitHubProvider();
  // The "previous" specification is served by the in-memory GitHub provider, exactly
  // as a real base-commit lookup would be.
  github.setFile(
    DEMO_OWNER,
    DEMO_REPO,
    "openapi.yaml",
    await readFile(join(REPO_ROOT, "demo", "specs", "acmepay-v1.yaml"), "utf8")
  );
  const workspaces = new FilesystemWorkspaceProvider(config.workspace.root);
  const repository = new LocalRepositoryProvider(config.demoRepoPath);

  logger.info("starting demo run", { repoPath: config.demoRepoPath, workspaceRoot: config.workspace.root });

  const result = await withWorkspace(workspaces, "demo", async (workspace) => {
    // The demo repository has no OpenAPI document of its own; supply the bundled pair.
    const context: StageContext = {
      analysisRunId: "demo-run",
      jobId: "demo-job",
      correlationId: "demo",
      logger,
      config,
      workspace,
      providers: {
        github,
        ai: new DemoAIProvider(DEMO_RENAMES),
        repository,
        workspaces,
        sandbox: new ProcessSandboxRunner(config.sandbox)
      },
      signal: new AbortController().signal,
      heartbeat: async () => undefined,
      recordStage: async (record) => {
        logger.info("stage recorded", { stage: record.stage, status: record.status });
      }
    };

    const checkout = workspace.resolve("repo");
    await repository.checkout({ installationId: 1, owner: DEMO_OWNER, repo: DEMO_REPO, ref: "demo" }, checkout);
    await copyFile(join(REPO_ROOT, "demo", "specs", "acmepay-v2.yaml"), join(checkout, "openapi.yaml"));

    return runAnalysisPipeline(
      {
        repository: {
          id: "demo-repo",
          githubId: 1,
          owner: DEMO_OWNER,
          name: DEMO_REPO,
          defaultBranch: "main",
          installationId: 1
        },
        baseRef: "demo-base",
        headRef: "demo-head",
        specPath: "openapi.yaml"
      },
      context,
      { publish: false }
    );
  });

  // Print the full semantic change report so the demo shows exactly what Capibara
  // detected, not just a count.
  const baseSpec = loadFromString(await readFile(join(REPO_ROOT, "demo", "specs", "acmepay-v1.yaml"), "utf8"));
  const headSpec = loadFromString(await readFile(join(REPO_ROOT, "demo", "specs", "acmepay-v2.yaml"), "utf8"));
  process.stdout.write(`\n${formatChangeReport(analyzeSpecChange(baseSpec, headSpec))}\n\n`);

  logger.info("demo run finished", {
    status: result.status,
    durationMs: result.totalDurationMs,
    stages: result.stages.map((stage) => `${stage.stage}:${stage.status}`),
    publish: result.publish?.skippedReason ?? result.publish?.pullRequest?.number
  });

  // The repository-intelligence report: every affected usage the scanner
  // found in the demo repository, with its evidence and confidence. This is
  // real scanner output — nothing here is scripted.
  if (result.scan !== undefined) {
    const { formatUsageReport } = await import("@capibara/scanner");
    process.stdout.write(`\n${formatUsageReport(result.scan, { maxPerFile: 10, includeMetrics: true })}\n\n`);
  }

  if (result.status !== "SUCCEEDED") process.exitCode = 1;
}

main().catch((error) => {
  getLogger("demo").failure("demo run failed", error);
  process.exitCode = 1;
});
