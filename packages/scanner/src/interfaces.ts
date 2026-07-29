
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

export interface SourceFile {
  path: string;
  content: string;
  lines: string[];
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

export interface CallSite {
  file: string;
  line: number;
  column: number;
  functionName: string;
  resolvedName: string;
  importPath?: string;
  importBinding?: ImportBinding;
  snippet: string;
  contextBefore: string;
  contextAfter: string;
  pattern: "fetch" | "axios" | "axios-instance" | "sdk" | "sdk-method" | "http-helper";
  operationId?: string;
  httpMethod?: string;
  pathPattern?: string;
  argumentNodes: ParserNode[];
  surroundingIdentifiers: string[];
  objectSpreads: string[];
  destructuredFields: string[];
  optionalChains: string[];
  genericWrappers: string[];
}

export interface ParserNode {
  type: string;
  text: string;
  startLine: number;
  endLine: number;
}

export interface ScanBenchmark {
  filesScanned: number;
  totalLines: number;
  callSitesFound: number;
  matchesFound: number;
  durationMs: number;
}
