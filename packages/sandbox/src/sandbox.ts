
import { spawn } from "child_process";
import { mkdtemp, rm, cp } from "fs/promises";
import path from "path";
import { os, tmpdir } from "os";
import { getConfig, getLogger, SandboxResult } from "@tern/shared";
import { SandboxRunner, SandboxOptions } from "./interfaces";
const logger = getLogger("sandbox");

export class DefaultSandboxRunner implements SandboxRunner {
  private config = getConfig();

  async run(repoPath: string, command: string, options?: Partial<SandboxOptions>): Promise<SandboxResult> {
    const opts: SandboxOptions = {
      timeoutMs: options?.timeoutMs ?? this.config.SANDBOX_TIMEOUT_MS,
      memoryMb: options?.memoryMb ?? this.config.SANDBOX_MEMORY_MB,
      cpuLimit: options?.cpuLimit ?? this.config.SANDBOX_CPU_LIMIT,
      workingDir: options?.workingDir ?? path.join(tmpdir(), `tern-sandbox-${Date.now()}`),
      cleanup: options?.cleanup ?? true
    };
    const start = Date.now();
    const logs: string[] = [];
    try {
      await this.prepareWorkspace(repoPath, opts.workingDir);
      logger.info({ workingDir: opts.workingDir, command }, "sandbox prepared");
      const install = await this.exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], opts.workingDir, opts.timeoutMs);
      logs.push("install:" + install.exitCode);
      if (install.exitCode !== 0) {
        return this.makeResult("failed", install.exitCode, install.stdout, install.stderr, Date.now() - start, opts, logs);
      }
      const run = await this.exec(command, [], opts.workingDir, opts.timeoutMs);
      const status = run.exitCode === 0 ? "passed" : "failed";
      return this.makeResult(status, run.exitCode, run.stdout, run.stderr, Date.now() - start, opts, logs);
    } catch (err) {
      logger.error({ err }, "sandbox error");
      return this.makeResult("errored", undefined, "", err instanceof Error ? err.message : String(err), Date.now() - start, opts, logs);
    } finally {
      if (opts.cleanup) {
        try { await rm(opts.workingDir, { recursive: true, force: true }); } catch {}
      }
    }
  }

  private async prepareWorkspace(repoPath: string, workingDir: string): Promise<void> {
    await mkdtemp(workingDir);
    const cpArgs = ["-r", `${repoPath}/.`, workingDir];
    await this.exec("cp", cpArgs, process.cwd(), 30000);
  }

  private exec(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, shell: false, env: { ...process.env, NODE_ENV: "test" } });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => { child.kill("SIGTERM"); }, timeoutMs);
      child.stdout?.on("data", (data) => { stdout += data.toString(); });
      child.stderr?.on("data", (data) => { stderr += data.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  }

  private makeResult(status: SandboxResult["status"], exitCode: number | undefined, stdout: string, stderr: string, durationMs: number, opts: SandboxOptions, logs: string[]): SandboxResult {
    return {
      status,
      exitCode,
      stdout: stdout.slice(0, 50000),
      stderr: stderr.slice(0, 50000),
      durationMs,
      testSummary: this.extractTestSummary(stdout),
      logs
    };
  }

  private extractTestSummary(stdout: string): string | undefined {
    const lines = stdout.split("\n");
    const summary = lines.find(l => /passing|failing|tests?/i.test(l));
    return summary;
  }
}

export class DockerSandboxRunner implements SandboxRunner {
  async run(repoPath: string, command: string, options?: Partial<SandboxOptions>): Promise<SandboxResult> {
    const opts: SandboxOptions = {
      timeoutMs: options?.timeoutMs ?? 300000,
      memoryMb: options?.memoryMb ?? 2048,
      cpuLimit: options?.cpuLimit ?? 2,
      workingDir: options?.workingDir ?? path.join(tmpdir(), `tern-sandbox-${Date.now()}`),
      cleanup: options?.cleanup ?? true
    };
    const start = Date.now();
    const logs: string[] = [];
    try {
      const { spawn } = await import("child_process");
      const args = [
        "run", "--rm",
        "-v", `${opts.workingDir}:/workspace`,
        "-w", "/workspace",
        "node:20-alpine",
        "sh", "-c", command
      ];
      const child = spawn("docker", args, { cwd: repoPath });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
      child.stdout?.on("data", d => stdout += d);
      child.stderr?.on("data", d => stderr += d);
      const code = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", c => { clearTimeout(timer); resolve(c ?? 1); });
      });
      return { status: code === 0 ? "passed" : "failed", exitCode: code, stdout, stderr, durationMs: Date.now() - start, testSummary: stdout.split("\n").find(l => /passing|failing/i.test(l)), logs };
    } catch (err) {
      return { status: "errored", stdout: "", stderr: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start, logs };
    } finally {
      if (opts.cleanup) try { await rm(opts.workingDir, { recursive: true, force: true }); } catch {}
    }
  }
}
