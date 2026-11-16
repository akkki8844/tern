import type { SandboxResult } from "@tern/shared";

/** A command is always an explicit argv pair — never a string to be split or shelled. */
export interface SandboxCommand {
  command: string;
  args: string[];
  /** Label used in logs and persisted results. */
  label: string;
}

export interface SandboxRunOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface SandboxRunner {
  /** Run one command inside an already-prepared directory. */
  run(workingDir: string, command: SandboxCommand, options?: SandboxRunOptions): Promise<SandboxResult>;
}

export interface VerificationStep {
  label: string;
  result: SandboxResult;
}

export interface VerificationReport {
  /** True only when every executed step exited zero. Never inferred, always measured. */
  passed: boolean;
  steps: VerificationStep[];
  totalDurationMs: number;
}
