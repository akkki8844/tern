import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SandboxError, clamp, getLogger, internalMessageOf, isWithin, type SandboxConfig, type SandboxResult } from "@tern/shared";
import { buildSandboxEnv, runProcess } from "./process-executor.js";
import type { SandboxCommand, SandboxRunOptions, SandboxRunner, VerificationReport, VerificationStep } from "./interfaces.js";

const logger = getLogger("sandbox");

const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 50_000;

/**
 * Process-level sandbox.
 *
 * What it does guarantee:
 *  - commands run inside a caller-owned workspace directory and nowhere else
 *  - no shell, argv only, arguments validated
 *  - a minimal allowlisted environment: no Tern credentials are visible to the repo
 *  - npm lifecycle scripts are disabled, so `npm install` cannot execute repo code
 *  - hard timeouts with SIGTERM -> SIGKILL on the whole process group
 *  - bounded, redacted output
 *
 * What it does NOT guarantee: kernel-level isolation. Commands still run as the
 * worker user. Running fully untrusted repositories requires a container or VM
 * boundary; that is deliberately out of scope for Turn 1 and documented in
 * docs/security.md.
 */
export class ProcessSandboxRunner implements SandboxRunner {
  constructor(private readonly config: SandboxConfig) {}

  async run(workingDir: string, command: SandboxCommand, options: SandboxRunOptions = {}): Promise<SandboxResult> {
    const timeoutMs = clamp(options.timeoutMs ?? this.config.timeoutMs, 1_000, MAX_TIMEOUT_MS);
    const env = buildSandboxEnv(options.env);
    const start = Date.now();

    try {
      const result = await runProcess(command.command, command.args, workingDir, {
        timeoutMs,
        env,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        signal: options.signal
      });

      const status: SandboxResult["status"] = result.timedOut ? "timed-out" : result.exitCode === 0 ? "passed" : "failed";
      logger.info("sandbox command finished", {
        label: command.label,
        status,
        exitCode: result.exitCode,
        durationMs: result.durationMs
      });

      return {
        status,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        testSummary: extractTestSummary(result.stdout),
        logs: []
      };
    } catch (error) {
      logger.warn("sandbox command could not be executed", {
        label: command.label,
        reason: internalMessageOf(error)
      });
      return {
        status: "errored",
        stdout: "",
        stderr: internalMessageOf(error),
        durationMs: Date.now() - start,
        logs: []
      };
    }
  }
}

export interface VerifyOptions {
  /** Root of the checkout to verify. Must be inside the workspace that owns it. */
  workspaceRoot: string;
  repoPath: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Install dependencies, then build, then test.
 *
 * Steps stop at the first failure, and the report only says `passed: true` when
 * every executed step actually exited zero. A missing script is skipped explicitly
 * rather than being treated as success.
 */
export async function verifyRepository(runner: SandboxRunner, options: VerifyOptions): Promise<VerificationReport> {
  if (!isWithin(options.workspaceRoot, options.repoPath)) {
    throw new SandboxError("Refusing to verify a path outside its workspace", {
      code: "SANDBOX_PATH_ESCAPE",
      details: { repoPath: options.repoPath }
    });
  }

  if (!(await exists(join(options.repoPath, "package.json")))) {
    throw new SandboxError("Checkout has no package.json; there is nothing to verify", {
      code: "SANDBOX_NO_MANIFEST",
      details: { repoPath: options.repoPath },
      publicMessage: "The repository does not look like a Node.js project."
    });
  }

  const scripts = await readPackageScripts(options.repoPath);
  const steps: VerificationStep[] = [];
  const start = Date.now();

  const install: SandboxCommand = (await exists(join(options.repoPath, "package-lock.json")))
    ? { label: "install", command: "npm", args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"] }
    : { label: "install", command: "npm", args: ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"] };

  const plan: SandboxCommand[] = [install];
  if (scripts.has("build")) plan.push({ label: "build", command: "npm", args: ["run", "build", "--if-present"] });
  if (scripts.has("test")) plan.push({ label: "test", command: "npm", args: ["run", "test", "--if-present"] });

  let passed = true;
  for (const command of plan) {
    const result = await runner.run(options.repoPath, command, {
      timeoutMs: options.timeoutMs,
      signal: options.signal
    });
    steps.push({ label: command.label, result });
    if (result.status !== "passed") {
      passed = false;
      break;
    }
  }

  if (!scripts.has("test")) {
    logger.warn("repository has no test script; verification cannot prove behaviour is preserved", {
      repoPath: options.repoPath
    });
  }

  return { passed: passed && steps.length > 0, steps, totalDurationMs: Date.now() - start };
}

async function readPackageScripts(repoPath: string): Promise<Set<string>> {
  try {
    const raw = await readFile(join(repoPath, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return new Set(Object.keys(parsed.scripts ?? {}));
  } catch {
    return new Set();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Write an .npmrc that disables lifecycle scripts for anything run in this checkout. */
export async function hardenCheckout(repoPath: string): Promise<void> {
  await writeFile(join(repoPath, ".npmrc"), "ignore-scripts=true\naudit=false\nfund=false\n", { encoding: "utf8" });
}

function extractTestSummary(stdout: string): string | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/\b(\d+)\s+(passing|passed|failing|failed|tests?)\b/i.test(lines[i])) return lines[i].trim().slice(0, 500);
  }
  return undefined;
}
