import { readFile, readdir, stat } from "fs/promises";
import path from "path";
import { BreakingChange, AffectedUsage } from "@tern/shared";
import { CodeScanner, ScanOptions, ScanBenchmark } from "./interfaces.js";
import { extractImportBindings } from "./import-resolver.js";
import { extractCallSites } from "./call-site-extractor.js";
import { matchCallSites } from "./matcher.js";

const DEFAULT_INCLUDE = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"];
const DEFAULT_EXCLUDE = ["node_modules", "dist", ".git", "coverage", "*.d.ts", "*.test.*", "*.spec.*"];
const MAX_FILE_SIZE = 2 * 1024 * 1024;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ParserClass: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let TsLanguage: any = null;
let treeSitterAvailable = true;

try {
  const parserMod = await import("tree-sitter");
  const tsMod = await import("tree-sitter-typescript");
  ParserClass = parserMod.default ?? parserMod;
  TsLanguage = (tsMod as any).default ?? tsMod;
} catch {
  treeSitterAvailable = false;
}

export class TreeSitterScanner implements CodeScanner {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parser: any = null;
  private benchmark: ScanBenchmark = { filesScanned: 0, totalLines: 0, callSitesFound: 0, matchesFound: 0, durationMs: 0 };

  constructor() {
    if (treeSitterAvailable && ParserClass && TsLanguage) {
      try {
        this.parser = new ParserClass();
        this.parser.setLanguage(TsLanguage);
      } catch {
        this.parser = null;
      }
    }
  }

  async scan(repoPath: string, changes: BreakingChange[], options?: ScanOptions): Promise<AffectedUsage[]> {
    const start = performance.now();
    this.benchmark = { filesScanned: 0, totalLines: 0, callSitesFound: 0, matchesFound: 0, durationMs: 0 };
    const resolved = path.resolve(repoPath);
    const files = await collectFiles(resolved, options);
    const allSites = [];

    for (const file of files) {
      const content = await readFile(file, "utf8").catch(() => null);
      if (content === null) continue;
      this.benchmark.filesScanned += 1;
      this.benchmark.totalLines += content.split("\n").length;

      if (this.parser) {
        const tree = this.parser.parse(content);
        const bindings = extractImportBindings(tree);
        const sites = extractCallSites(tree, file, content, bindings);
        allSites.push(...sites);
        this.benchmark.callSitesFound += sites.length;
      }
    }

    const usages = matchCallSites(allSites, changes, resolved);
    this.benchmark.matchesFound = usages.length;
    this.benchmark.durationMs = Math.round(performance.now() - start);
    return usages;
  }

  getBenchmark(): ScanBenchmark { return { ...this.benchmark }; }

  isAvailable(): boolean { return treeSitterAvailable && this.parser !== null; }
}

export class SimpleRegexScanner implements CodeScanner {
  private benchmark: ScanBenchmark = { filesScanned: 0, totalLines: 0, callSitesFound: 0, matchesFound: 0, durationMs: 0 };

  async scan(repoPath: string, changes: BreakingChange[], options?: ScanOptions): Promise<AffectedUsage[]> {
    const start = performance.now();
    this.benchmark = { filesScanned: 0, totalLines: 0, callSitesFound: 0, matchesFound: 0, durationMs: 0 };
    const resolved = path.resolve(repoPath);
    const files = await collectFiles(resolved, options);
    const allUsages: AffectedUsage[] = [];

    for (const file of files) {
      const content = await readFile(file, "utf8").catch(() => null);
      if (content === null) continue;
      this.benchmark.filesScanned += 1;
      this.benchmark.totalLines += content.split("\n").length;

      const usages = this.scanFileWithRegex(file, content, changes);
      allUsages.push(...usages);
      this.benchmark.callSitesFound += usages.length;
    }

    this.benchmark.matchesFound = allUsages.length;
    this.benchmark.durationMs = Math.round(performance.now() - start);
    return allUsages;
  }

  private scanFileWithRegex(file: string, content: string, changes: BreakingChange[]): AffectedUsage[] {
    const usages: AffectedUsage[] = [];
    const lines = content.split("\n");

    for (const change of changes) {
      const patterns = this.buildPatterns(change);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;

        for (const pattern of patterns) {
          if (pattern.test(line)) {
            const usage: AffectedUsage = {
              id: crypto.randomUUID(),
              file: path.relative(process.cwd(), file),
              line: lineNum,
              column: 1,
              functionName: this.extractFunctionName(line),
              snippet: line.trim(),
              contextBefore: lines.slice(Math.max(0, i - 2), i).join("\n"),
              contextAfter: lines.slice(i + 1, i + 3).join("\n"),
              confidence: "low",
              breakingChangeId: change.id,
              operationId: change.operationId,
              httpMethod: change.method,
              pathPattern: change.path
            };
            usages.push(usage);
            break; // Only match once per line per change
          }
        }
      }
    }

    return usages;
  }

  private buildPatterns(change: BreakingChange): RegExp[] {
    const patterns: RegExp[] = [];

    // Build patterns based on change type
    if (change.operationId) {
      patterns.push(new RegExp(`\\b${this.escapeRegex(change.operationId)}\\b`, "i"));
    }

    if (change.path) {
      patterns.push(new RegExp(`['"\`]${this.escapeRegex(change.path)}['"\`]`, "i"));
    }

    // Add patterns from description
    const descWords = change.description.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || [];
    for (const word of descWords.filter(w => w.length > 3)) {
      patterns.push(new RegExp(`\\b${this.escapeRegex(word)}\\b`, "i"));
    }

    return patterns;
  }

  private extractFunctionName(line: string): string {
    // Try to extract function name from various patterns
    const funcMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(\w+)\s*\(/);
    if (funcMatch) return funcMatch[2];

    const callMatch = line.match(/(\w+)\s*\(/);
    if (callMatch) return callMatch[1];

    return "unknown";
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  getBenchmark(): ScanBenchmark { return { ...this.benchmark }; }
}

async function collectFiles(root: string, options?: ScanOptions): Promise<string[]> {
  const include = options?.include ?? DEFAULT_INCLUDE;
  const exclude = options?.exclude ?? DEFAULT_EXCLUDE;
  const maxFiles = options?.maxFiles ?? 10000;
  const files: string[] = [];
  await walk(root, root, files, include, exclude, maxFiles);
  return files;
}

async function walk(root: string, dir: string, files: string[], include: string[], exclude: string[], maxFiles: number): Promise<void> {
  if (files.length >= maxFiles) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(root, fullPath);
    if (exclude.some(p => matchesPattern(relPath, p))) continue;
    if (entry.isDirectory()) {
      await walk(root, fullPath, files, include, exclude, maxFiles);
    } else if (entry.isFile() && include.some(p => matchesPattern(relPath, p))) {
      const s = await stat(fullPath).catch(() => ({ size: 0 }));
      if (s.size > 0 && s.size <= MAX_FILE_SIZE) files.push(fullPath);
    }
  }
}

function matchesPattern(filePath: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    const regex = new RegExp("^" + pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$");
    return regex.test(filePath);
  }
  return filePath === pattern || filePath.startsWith(pattern + "/");
}
