
import { spawn } from "child_process";
import { mkdtemp, rm, cp, readFile, writeFile, stat } from "fs/promises";
import path from "path";
import { tmpdir, platform } from "os";
import { getConfig, getLogger, SandboxResult, redactSecrets } from "@tern/shared";
import { SandboxRunner, SandboxOptions } from "./interfaces";
const logger = getLogger("sandbox");

const MAX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_MEMORY_MB = 8192;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export class DefaultSandboxRunner implements SandboxRunner {
  private config = getConfig();

  async run(repoPath: string, command: string, options?: Partial<SandboxOptions>): Promise<SandboxResult> {
    const opts = this.sanitizeOptions(options);
    const start = Date.now();
    const logs: string[] = [];
    let workingDir = "";
    try {
      workingDir = await this.createWorkspace(repoPath, opts);
      logger.info({ workingDir, command, timeoutMs: opts.timeoutMs }, "sandbox prepared");
      const install = await this.exec("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], opts.workingDir, opts.timeoutMs, opts);
      logs.push(`install:exit=${install.exitCode}`);
      if (install.exitCode !== 0) {
        return this.makeResult("failed", install.exitCode, install.stdout, install.stderr, Date.now() - start, opts, logs, workingDir);
      }
      const run = await this.exec(command, [], opts.workingDir, opts.timeoutMs, opts);
      const status = run.exitCode === 0 ? "passed" : "failed";
      return this.makeResult(status, run.exitCode, run.stdout, run.stderr, Date.now() - start, opts, logs, workingDir);
    } catch (err) {
      logger.error({ err }, "sandbox error");
      return this.makeResult("errored", undefined, "", err instanceof Error ? err.message : String(err), Date.now() - start, opts, logs, workingDir);
    } finally {
      if (opts.cleanup && workingDir) {
        await this.safeCleanup(workingDir);
      }
    }
  }

  private sanitizeOptions(options?: Partial<SandboxOptions>): SandboxOptions {
    const timeoutMs = Math.min(options?.timeoutMs ?? this.config.SANDBOX_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const memoryMb = Math.min(options?.memoryMb ?? this.config.SANDBOX_MEMORY_MB, MAX_MEMORY_MB);
    const cpuLimit = Math.min(options?.cpuLimit ?? this.config.SANDBOX_CPU_LIMIT, 16);
    const workingDir = options?.workingDir ?? path.join(tmpdir(), `tern-sandbox-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const env = options?.env ?? {};
    return {
      timeoutMs,
      memoryMb,
      cpuLimit,
      workingDir,
      cleanup: options?.cleanup ?? true,
      env: this.sanitizeEnv({ ...process.env, ...env, NODE_ENV: "test", PATH: process.env.PATH || "" }),
      network: options?.network ?? false,
      allowScripts: options?.allowScripts ?? false
    };
  }

  private sanitizeEnv(env: Record<string, string | undefined>): Record<string, string> {
    const dangerous = ["GITHUB_TOKEN", "GH_TOKEN", "FIREWORKS_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "DATABASE_URL", "REDIS_URL", "ENCRYPTION_KEY", "NEXTAUTH_SECRET"];
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) continue;
      if (dangerous.includes(key.toUpperCase())) {
        sanitized[key] = "[REDACTED]";
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  private async createWorkspace(repoPath: string, opts: SandboxOptions): Promise<string> {
    const resolvedRepo = path.resolve(repoPath);
    await mkdtemp(opts.workingDir);
    const target = path.join(opts.workingDir, "repo");
    await this.copyDirectory(resolvedRepo, target);
    if (!opts.allowScripts) {
      await this.writeNpmRc(target, "ignore-scripts=true\nscript-shell=sh\n");
    }
    return target;
  }

  private async copyDirectory(src: string, dest: string): Promise<void> {
    const entries = await readFile(src).catch(() => null);
    // Use cp -r for simplicity; could be replaced with native fs.cp
    const { execFile } = await import("child_process");
    await new Promise<void>((resolve, reject) => {
      execFile("cp", ["-r", `${src}/.`, dest], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async writeNpmRc(target: string, content: string): Promise<void> {
    try {
      await writeFile(path.join(target, ".npmrc"), content, { flag: "a" });
    } catch (err) {
      logger.warn({ err }, "failed to write .npmrc");
    }
  }

  private async exec(command: string, args: string[], cwd: string, timeoutMs: number, opts: SandboxOptions): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        shell: false,
        env: opts.env,
        timeout: timeoutMs,
        killSignal: "SIGTERM"
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        logger.warn({ command, timeoutMs }, "sandbox timeout reached");
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000);
      }, timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (data: string) => { stdout += data; });
      child.stderr?.on("data", (data: string) => { stderr += data; });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (signal === "SIGTERM" && code === null) {
          resolve({ exitCode: 124, stdout: this.sanitizeOutput(stdout), stderr: this.sanitizeOutput(stderr) });
        } else {
          resolve({ exitCode: code ?? 1, stdout: this.sanitizeOutput(stdout), stderr: this.sanitizeOutput(stderr) });
        }
      });
    });
  }

  private sanitizeOutput(output: string): string {
    return redactSecrets(output).slice(0, 50000);
  }

  private async safeCleanup(workingDir: string): Promise<void> {
    try {
      await rm(workingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (err) {
      logger.error({ workingDir, err }, "cleanup failed");
    }
  }

  private makeResult(status: SandboxResult["status"], exitCode: number | undefined, stdout: string, stderr: string, durationMs: number, opts: SandboxOptions, logs: string[], workingDir: string): SandboxResult {
    return {
      status,
      exitCode,
      stdout: this.sanitizeOutput(stdout),
      stderr: this.sanitizeOutput(stderr),
      durationMs,
      testSummary: this.extractTestSummary(stdout),
      logs
    };
  }

  private extractTestSummary(stdout: string): string | undefined {
    const lines = stdout.split("\n");
    const summary = lines.find(l => /passing|failing|tests?|suites?/i.test(l));
    return summary;
  }
}

export class DockerSandboxRunner implements SandboxRunner {
  async run(repoPath: string, command: string, options?: Partial<SandboxOptions>): Promise<SandboxResult> {
    const opts: SandboxOptions = {
      timeoutMs: Math.min(options?.timeoutMs ?? 300000, MAX_TIMEOUT_MS),
      memoryMb: Math.min(options?.memoryMb ?? 2048, MAX_MEMORY_MB),
      cpuLimit: Math.min(options?.cpuLimit ?? 2, 16),
      workingDir: options?.workingDir ?? path.join(tmpdir(), `tern-sandbox-${Date.now()}-${Math.random().toString(36).slice(2)}`),
      cleanup: options?.cleanup ?? true,
      env: options?.env ?? {},
      network: options?.network ?? false,
      allowScripts: options?.allowScripts ?? false
    };
    const start = Date.now();
    const logs: string[] = [];
    let workingDir = "";
    try {
      workingDir = await this.createWorkspace(repoPath, opts);
      const { spawn } = await import("child_process");
      const args = [
        "run", "--rm",
        "--network", opts.network ? "host" : "none",
        "-v", `${workingDir}:/workspace:ro`,
        "-w", "/workspace/repo",
        "node:20-alpine",
        "sh", "-c", command
      ];
      const child = spawn("docker", args, { cwd: repoPath });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000); }, opts.timeoutMs);
      child.stdout?.on("data", d => stdout += d);
      child.stderr?.on("data", d => stderr += d);
      const code = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", c => { clearTimeout(timer); resolve(c ?? 1); });
      });
      return { status: code === 0 ? "passed" : "failed", exitCode: code, stdout: this.sanitizeOutput(stdout), stderr: this.sanitizeOutput(stderr), durationMs: Date.now() - start, testSummary: this.extractTestSummary(stdout), logs };
    } catch (err) {
      return { status: "errored", stdout: "", stderr: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start, logs };
    } finally {
      if (opts.cleanup && workingDir) {
        try { await rm(workingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
      }
    }
  }

  private async createWorkspace(repoPath: string, opts: SandboxOptions): Promise<string> {
    await mkdtemp(opts.workingDir);
    const target = path.join(opts.workingDir, "repo");
    const { execFile } = await import("child_process");
    await new Promise<void>((resolve, reject) => {
      execFile("cp", ["-r", `${path.resolve(repoPath)}/.`, target], (err) => err ? reject(err) : resolve());
    });
    return target;
  }

  private sanitizeOutput(output: string): string { return redactSecrets(output).slice(0, 50000); }
  private extractTestSummary(stdout: string): string | undefined {
    const lines = stdout.split("\n");
    return lines.find(l => /passing|failing|tests?/i.test(l));
  }
}
