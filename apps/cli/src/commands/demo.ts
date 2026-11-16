
import { copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { configureLogging, getLogger, initConfig, type Logger } from "@capibara/shared";
import { DemoGitHubProvider, DEMO_OWNER, DEMO_REPO } from "@capibara/github";
import { DemoAIProvider } from "@capibara/llm";
import { FilesystemWorkspaceProvider, withWorkspace } from "@capibara/workspace";
import { ProcessSandboxRunner } from "@capibara/sandbox";
import { LocalRepositoryProvider, runAnalysisPipeline, type StageContext } from "@capibara/pipeline";
import { banner, symbols } from "../ui.js";
import { footerHint, renderStageTable, renderUsageReport } from "../renders.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Deterministic rename table the demo AI fallback applies (mirrors demo/migration-map.json). */
const DEMO_RENAMES = new Map<string, string>([
  ["createCharge", "createPayment"],
  ["retrieveCharge", "retrievePayment"],
  ["source:", "payment_method:"],
  ["/charges", "/payments"]
]);

/**
 * A logger that routes into the spinner instead of printing pino lines over
 * the CLI visuals. stage detail still lands in the final report.
 */
function quietLogger(component: string): Logger {
  const base = getLogger(component);
  return {
    ...base,
    info: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    failure: () => undefined
  } as Logger;
}

/**
 * `capibara demo` — the full eight-stage pipeline on the bundled AcmePay
 * example: real diffing, real scanning, real migration, real sandboxed
 * verification; in-memory providers, no network, no database.
 */
export async function runDemo(version: string): Promise<number> {
  const interactive = process.stdout.isTTY === true;
  const spinner = interactive ? clack.spinner() : null;
  if (interactive) clack.intro(banner(version));

  const config = initConfig({
    overrides: { CAPIBARA_MODE: "demo", DATABASE_URL: "postgresql://demo:demo@localhost:5432/capibara_demo" },
    defaultWorkspaceRoot: join(tmpdir(), "capibara-demo-workspaces"),
    defaultDemoRepoPath: join(REPO_ROOT, "demo", "broken-app")
  });
  configureLogging({ ...config.logging, pretty: false, level: "silent" });
  if (!config.demoMode) throw new Error("demo command must run in demo mode");

  const github = new DemoGitHubProvider();
  github.setFile(DEMO_OWNER, DEMO_REPO, "openapi.yaml", await readFile(join(REPO_ROOT, "demo", "specs", "acmepay-v1.yaml"), "utf8"));
  const workspaces = new FilesystemWorkspaceProvider(config.workspace.root);
  const repository = new LocalRepositoryProvider(config.demoRepoPath);

  try {
    const result = await withWorkspace(workspaces, "demo", async (workspace) => {
      const context: StageContext = {
        analysisRunId: "demo-run",
        jobId: "demo-job",
        correlationId: "demo",
        logger: quietLogger("capibara-demo"),
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
          spinner?.message(`${record.stage.toLowerCase()} — ${record.status.toLowerCase()}`);
        }
      };

      const checkout = workspace.resolve("repo");
      await repository.checkout({ installationId: 1, owner: DEMO_OWNER, repo: DEMO_REPO, ref: "demo" }, checkout);
      await copyFile(join(REPO_ROOT, "demo", "specs", "acmepay-v2.yaml"), join(checkout, "openapi.yaml"));

      spinner?.start("running pipeline");
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

    spinner?.stop(`pipeline ${result.status.toLowerCase()} in ${(result.totalDurationMs / 1000).toFixed(1)}s`);

    const report = [
      renderStageTable(result.stages.map((stage) => ({ stage: stage.stage, status: stage.status, durationMs: stage.durationMs }))),
      ...(result.scan ? [renderUsageReport(result.scan, false)] : []),
      "",
      pc.dim(`workspace: ${config.workspace.root}`),
      pc.dim("publish: " + (result.publish?.skippedReason ?? result.publish?.pullRequest?.number ?? "n/a"))
    ].join("\n");

    if (interactive) {
      clack.note(report, "Demo result");
      clack.outro(footerHint());
    } else {
      process.stdout.write(`${report}\n`);
    }
    return result.status === "SUCCEEDED" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner?.stop(symbols.fail("demo failed"));
    if (interactive) clack.log.error(message);
    else process.stderr.write(`${symbols.fail(message)}\n`);
    return 1;
  }
}

