
import { spawn, execFile, ChildProcess } from "child_process";
import { getLogger, redactSecrets, sleep } from "@tern/shared";
const logger = getLogger("sandbox:executor");

export interface ExecResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean; }

export async function runProcess(command: string, args: string[], cwd: string, options: { timeoutMs: number; env: Record<string, string>; maxOutputBytes: number; signal?: AbortSignal }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: { ...process.env, ...options.env } as NodeJS.ProcessEnv,
      signal: options.signal
    }) as ChildProcess;
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      logger.warn("sandbox timeout reached", { command, timeoutMs: options.timeoutMs });
      killed = true;
      child.kill("SIGTERM");
      sleep(5000).then(() => { if (!child.killed) child.kill("SIGKILL"); }).catch(() => {});
    }, options.timeoutMs);
    const out = child.stdout as NodeJS.ReadableStream | null;
    const err = child.stderr as NodeJS.ReadableStream | null;
    out?.setEncoding("utf8");
    err?.setEncoding("utf8");
    out?.on("data", (data: string) => {
      stdout += data;
      if (stdout.length > options.maxOutputBytes) stdout = stdout.slice(0, options.maxOutputBytes) + "\n... [truncated]";
    });
    err?.on("data", (data: string) => {
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
    logger.error("cleanup failed", { path, err });
  });
}
