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
  async scan(repoPath: string, changes: BreakingChange[], options?: ScanOptions): Promise<AffectedUsage[]> {
    const scanner = new TreeSitterScanner();
    return scanner.scan(repoPath, changes, options);
  }
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
