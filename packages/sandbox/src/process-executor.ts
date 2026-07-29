
import { spawn, execFile } from "child_process";
import { getLogger, redactSecrets, sleep } from "@tern/shared";
const logger = getLogger("sandbox:executor");

export interface ExecResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean; }

export async function runProcess(command: string, args: string[], cwd: string, options: { timeoutMs: number; env: Record<string, string>; maxOutputBytes: number; signal?: AbortSignal }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: options.env,
      signal: options.signal
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      logger.warn({ command, timeoutMs: options.timeoutMs }, "sandbox timeout reached");
      killed = true;
      child.kill("SIGTERM");
      sleep(5000).then(() => { if (!child.killed) child.kill("SIGKILL"); }).catch(() => {});
    }, options.timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => {
      stdout += data;
      if (stdout.length > options.maxOutputBytes) stdout = stdout.slice(0, options.maxOutputBytes) + "\n... [truncated]";
    });
    child.stderr?.on("data", (data: string) => {
      stderr += data;
      if (stderr.length > options.maxOutputBytes) stderr = stderr.slice(0, options.maxOutputBytes) + "\n... [truncated]";
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const timedOut = killed || signal === "SIGTERM";
      resolve({ exitCode: code ?? (timedOut ? 124 : 1), stdout: redactSecrets(stdout), stderr: redactSecrets(stderr), timedOut });
    });
  });
}

export async function copyDirectory(src: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("cp", ["-r", `${src}/.`, dest], { timeout: 60000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export async function cleanupDirectory(path: string): Promise<void> {
  const { rm } = await import("fs/promises");
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(err => {
    logger.error({ path, err }, "cleanup failed");
  });
}
