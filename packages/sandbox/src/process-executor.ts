import { spawn } from "node:child_process";
import { SandboxError, assertSafeCommandName, assertSafeProcessArg, getLogger, redactSecrets } from "@capibara/shared";

const logger = getLogger("sandbox-executor");

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecOptions {
  timeoutMs: number;
  /** Complete environment for the child. It is used verbatim — nothing is inherited. */
  env: Record<string, string>;
  maxOutputBytes: number;
  /** Grace period between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  signal?: AbortSignal;
}

/**
 * Run a child process safely.
 *
 * - `shell: false` always: the command and every argument are passed as an argv
 *   array, so repository content can never be interpreted by a shell
 * - every argument is validated against a conservative allowlist
 * - the environment is replaced, not extended: the parent's secrets are not visible
 * - output is bounded, so a runaway build cannot exhaust memory
 * - output is redacted before it leaves this function
 * - timeouts escalate SIGTERM -> SIGKILL and kill the whole process group
 */
export async function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  options: ExecOptions
): Promise<ExecResult> {
  assertSafeCommandName(command);
  for (const arg of args) assertSafeProcessArg(arg, "argument");

  const start = Date.now();
  const killGraceMs = options.killGraceMs ?? 5_000;

  return await new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      env: options.env,
      // New process group so a timeout can kill the whole tree, not just the leader.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const killTree = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      logger.warn("sandbox command timed out", { command, timeoutMs: options.timeoutMs });
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), killGraceMs);
    }, options.timeoutMs);

    const onAbort = () => {
      timedOut = true;
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), killGraceMs);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length >= options.maxOutputBytes) {
        stdoutTruncated = true;
        return;
      }
      stdout += chunk;
      if (stdout.length > options.maxOutputBytes) {
        stdout = stdout.slice(0, options.maxOutputBytes);
        stdoutTruncated = true;
      }
    });

    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length >= options.maxOutputBytes) {
        stderrTruncated = true;
        return;
      }
      stderr += chunk;
      if (stderr.length > options.maxOutputBytes) {
        stderr = stderr.slice(0, options.maxOutputBytes);
        stderrTruncated = true;
      }
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new SandboxError(`Failed to start "${command}"`, {
          code: "SANDBOX_SPAWN_FAILED",
          cause: error,
          details: { command }
        })
      );
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode: code ?? (timedOut ? 124 : 1),
        stdout: redactSecrets(stdout) + (stdoutTruncated ? "\n… [output truncated by Capibara]" : ""),
        stderr: redactSecrets(stderr) + (stderrTruncated ? "\n… [output truncated by Capibara]" : ""),
        timedOut: timedOut || signal === "SIGKILL",
        durationMs: Date.now() - start
      });
    });
  });
}

/**
 * Minimal environment for sandboxed commands.
 *
 * Built from an allowlist rather than by filtering `process.env`: a deny-list would
 * leak every credential whose name we failed to predict.
 */
export function buildSandboxEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const allowed = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "SHELL"];
  const env: Record<string, string> = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  env.CI = "true";
  env.NODE_ENV = "test";
  // npm must never execute lifecycle scripts from an untrusted repository.
  env.npm_config_ignore_scripts = "true";
  env.npm_config_audit = "false";
  env.npm_config_fund = "false";
  env.npm_config_update_notifier = "false";
  return { ...env, ...overrides };
}
