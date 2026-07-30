
import { mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { getConfig, getLogger, SandboxResult } from "@tern/shared";
import { SandboxRunner, SandboxOptions } from "./interfaces.js";
import { runProcess, copyDirectory, cleanupDirectory } from "./process-executor.js";
const logger = getLogger("sandbox");

const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_MEMORY_MB = 8192;
const MAX_CPU_LIMIT = 16;
const MAX_OUTPUT_BYTES = 50000;

export class DefaultSandboxRunner implements SandboxRunner {
  private config = getConfig();

  async run(repoPath: string, command: string, options?: Partial<SandboxOptions>): Promise<SandboxResult> {
    const opts = this.resolveOptions(options);
    const start = Date.now();
    let workspace = "";
    try {
      workspace = await this.prepareWorkspace(repoPath, opts);
      const install = await runProcess("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], workspace, { timeoutMs: opts.timeoutMs, env: opts.env, maxOutputBytes: MAX_OUTPUT_BYTES });
      if (install.exitCode !== 0) {
        return this.buildResult("failed", install, Date.now() - start);
      }
      const [cmd, ...cmdArgs] = command.split(/\s+/);
      const run = await runProcess(cmd, cmdArgs, workspace, { timeoutMs: opts.timeoutMs, env: opts.env, maxOutputBytes: MAX_OUTPUT_BYTES });
      return this.buildResult(run.timedOut ? "timed-out" : (run.exitCode === 0 ? "passed" : "failed"), run, Date.now() - start);
    } catch (err) {
      logger.error("sandbox error", { err });
      return { status: "errored", stdout: "", stderr: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start, logs: [] };
    } finally {
      if (opts.cleanup) {
        await cleanupDirectory(opts.workingDir);
      }
    }
  }

  private resolveOptions(options?: Partial<SandboxOptions>): SandboxOptions {
    const timeoutMs = clamp(options?.timeoutMs ?? this.config.SANDBOX_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    const memoryMb = clamp(options?.memoryMb ?? this.config.SANDBOX_MEMORY_MB, 64, MAX_MEMORY_MB);
    const cpuLimit = clamp(options?.cpuLimit ?? this.config.SANDBOX_CPU_LIMIT, 1, MAX_CPU_LIMIT);
    const workingDir = options?.workingDir ?? join(tmpdir(), `tern-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`);
    return {
      timeoutMs,
      memoryMb,
      cpuLimit,
      workingDir,
      cleanup: options?.cleanup ?? true,
      env: this.sanitizeEnv({ ...process.env, ...(options?.env ?? {}) }),
      network: options?.network ?? false,
      allowScripts: options?.allowScripts ?? false
    };
  }

  private sanitizeEnv(env: Record<string, string | undefined>): Record<string, string> {
    const dangerous = new Set(["GITHUB_TOKEN", "GH_TOKEN", "FIREWORKS_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "DATABASE_URL", "REDIS_URL", "ENCRYPTION_KEY", "NEXTAUTH_SECRET", "PRIVATE_KEY", "API_KEY"]);
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) continue;
      sanitized[key] = dangerous.has(key.toUpperCase()) || /token|secret|key|password|credential/i.test(key) ? "[REDACTED]" : value;
    }
    return sanitized;
  }

  private async prepareWorkspace(repoPath: string, opts: SandboxOptions): Promise<string> {
    await mkdtemp(opts.workingDir);
    const target = join(opts.workingDir, "repo");
    await copyDirectory(repoPath, target);
    if (!opts.allowScripts) {
      await writeFile(join(target, ".npmrc"), "ignore-scripts=true\nscript-shell=sh\n", { flag: "a" });
    }
    return target;
  }

  private buildResult(status: SandboxResult["status"], run: { exitCode: number; stdout: string; stderr: string }, durationMs: number): SandboxResult {
    const logs: string[] = [];
    return {
      status,
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
      durationMs,
      testSummary: extractTestSummary(run.stdout),
      logs
    };
  }
}

export class DockerSandboxRunner implements SandboxRunner {
  async run(repoPath: string, command: string, options?: Partial<SandboxOptions>): Promise<SandboxResult> {
    const opts = this.resolveOptions(options);
    const start = Date.now();
    let workspace = "";
    try {
      workspace = await this.prepareWorkspace(repoPath, opts);
      const args = [
        "run", "--rm",
        "--network", opts.network ? "host" : "none",
        "-v", `${workspace}:/workspace:ro`,
        "-w", "/workspace/repo",
        "node:20-alpine",
        "sh", "-c", command
      ];
      const run = await runProcess("docker", args, repoPath, { timeoutMs: opts.timeoutMs, env: opts.env, maxOutputBytes: MAX_OUTPUT_BYTES });
      return this.buildResult(run.timedOut ? "timed-out" : (run.exitCode === 0 ? "passed" : "failed"), run, Date.now() - start);
    } catch (err) {
      return { status: "errored", stdout: "", stderr: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start, logs: [] };
    } finally {
      if (opts.cleanup && workspace) await cleanupDirectory(opts.workingDir);
    }
  }

  private resolveOptions(options?: Partial<SandboxOptions>): SandboxOptions {
    return {
      timeoutMs: clamp(options?.timeoutMs ?? 300000, 1000, MAX_TIMEOUT_MS),
      memoryMb: clamp(options?.memoryMb ?? 2048, 64, MAX_MEMORY_MB),
      cpuLimit: clamp(options?.cpuLimit ?? 2, 1, MAX_CPU_LIMIT),
      workingDir: options?.workingDir ?? join(tmpdir(), `tern-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`),
      cleanup: options?.cleanup ?? true,
      env: options?.env ?? {},
      network: options?.network ?? false,
      allowScripts: options?.allowScripts ?? false
    };
  }

  private async prepareWorkspace(repoPath: string, opts: SandboxOptions): Promise<string> {
    await mkdtemp(opts.workingDir);
    const target = join(opts.workingDir, "repo");
    await copyDirectory(repoPath, target);
    return target;
  }

  private buildResult(status: SandboxResult["status"], run: { exitCode: number; stdout: string; stderr: string }, durationMs: number): SandboxResult {
    return { status, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr, durationMs, testSummary: extractTestSummary(run.stdout), logs: [] };
  }
}

function clamp(n: number, min: number, max: number): number { return Math.min(max, Math.max(min, n)); }
function extractTestSummary(stdout: string): string | undefined { return stdout.split("\n").find(l => /passing|failing|tests?/i.test(l)); }
