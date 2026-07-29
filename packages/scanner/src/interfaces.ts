
import { BreakingChange, AffectedUsage } from "@tern/shared";

export interface CodeScanner {
  scan(repoPath: string, changes: BreakingChange[], options?: ScanOptions): Promise<AffectedUsage[]>;
}

export interface ScanOptions {
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  maxFileSizeBytes?: number;
}

export interface ImportBinding {
  name: string;
  source: string;
  isDefault: boolean;
  isNamespace: boolean;
  isRenamed: boolean;
  localName: string;
  aliasMap?: Map<string, string>;
}

export interface ScanBenchmark {
  filesScanned: number;
  totalLines: number;
  callSitesFound: number;
  matchesFound: number;
  durationMs: number;
}
