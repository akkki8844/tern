
import { SandboxResult } from "@tern/shared";

export interface SandboxRunner {
  run(repoPath: string, command: string, options?: Partial<SandboxOptions>): Promise<SandboxResult>;
}

export interface SandboxOptions {
  timeoutMs: number;
  memoryMb: number;
  cpuLimit: number;
  workingDir: string;
  cleanup: boolean;
}
