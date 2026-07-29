
import { BreakingChange, AffectedUsage } from "@tern/shared";

export interface CodeScanner {
  scan(repoPath: string, changes: BreakingChange[]): Promise<AffectedUsage[]>;
}

export interface SourceFile {
  path: string;
  content: string;
  lines: string[];
}

export interface CallSite {
  file: string;
  line: number;
  column: number;
  functionName: string;
  importPath?: string;
  snippet: string;
  contextBefore: string;
  contextAfter: string;
  pattern: "fetch" | "axios" | "sdk" | "method";
  operationId?: string;
  httpMethod?: string;
  pathPattern?: string;
}
