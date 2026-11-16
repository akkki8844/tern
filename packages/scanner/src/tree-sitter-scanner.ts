/**
 * Scanner facades.
 *
 * `TreeSitterScanner` is the primary engine: it runs the full AST pipeline
 * (discovery → parsing → symbol resolution → adapters → matching) and projects
 * the semantic result onto the legacy `AffectedUsage` surface.
 *
 * `SimpleRegexScanner` is the *literal fallback* used only when tree-sitter
 * cannot load (unsupported platform). It matches string literals against
 * OpenAPI path templates only — high precision, low recall, honest confidence.
 * The old behaviour of matching every word of a change description against
 * every line was a false-positive machine and has been removed deliberately.
 *
 * Neither implementation executes repository code, and neither modifies files.
 */
import { readFile } from "fs/promises";
import path from "node:path";
import type { BreakingChange, AffectedUsage } from "@tern/shared";
import type { SpecChangeAnalysis } from "@tern/openapi";
import { CodeScanner, ScanOptions, ScanBenchmark } from "./interfaces.js";
import { RepositoryScanner } from "./scan/scanner.js";
import {
  benchmarkFromScan,
  emptyBenchmark,
  legacyChangesToAnalysis,
  projectToLegacyUsages
} from "./scan/legacy.js";
import { treeSitterLoadable, parseFile } from "./parse/parser.js";
import { discoverRepository } from "./discovery/discover.js";
import { DEFAULT_SCANNER_LIMITS } from "./limits.js";
import { matchLiteralCallSites } from "./matcher.js";

const MAX_FILE_SIZE = 2 * 1024 * 1024;

export class TreeSitterScanner implements CodeScanner {
  private benchmark: ScanBenchmark = emptyBenchmark();
  private lastScan: ReturnType<RepositoryScanner["scan"]> extends Promise<infer T> ? T | undefined : undefined;

  isAvailable(): boolean {
    return treeSitterLoadable();
  }

  async scan(repoPath: string, changes: BreakingChange[], options?: ScanOptions): Promise<AffectedUsage[]>;
  async scan(repoPath: string, analysis: SpecChangeAnalysis, options?: ScanOptions): Promise<AffectedUsage[]>;
  async scan(
    repoPath: string,
    input: BreakingChange[] | SpecChangeAnalysis,
    options?: ScanOptions
  ): Promise<AffectedUsage[]> {
    const start = performance.now();
    this.benchmark = emptyBenchmark();
    const analysis: SpecChangeAnalysis = isAnalysis(input) ? input : legacyChangesToAnalysis(input);
    const scanner = new RepositoryScanner({
      limits: {
        maxFiles: options?.maxFiles ?? DEFAULT_SCANNER_LIMITS.maxFiles,
        maxFileBytes: options?.maxFileSizeBytes ?? DEFAULT_SCANNER_LIMITS.maxFileBytes
      },
      ...(options?.include !== undefined ? { include: options.include } : {}),
      ...(options?.exclude !== undefined ? { exclude: options.exclude } : {})
    });
    const scan = await scanner.scan(repoPath, analysis);
    this.benchmark = benchmarkFromScan(scan);
    this.benchmark.durationMs = Math.round(performance.now() - start);
    this.lastScan = scan;
    return projectToLegacyUsages(scan, path.resolve(repoPath));
  }

  /** The full semantic scan behind the last legacy `scan()` call, when available. */
  getScan(): Awaited<ReturnType<RepositoryScanner["scan"]>> | undefined {
    return this.lastScan;
  }

  getBenchmark(): ScanBenchmark {
    return { ...this.benchmark };
  }
}

function isAnalysis(input: BreakingChange[] | SpecChangeAnalysis): input is SpecChangeAnalysis {
  return !Array.isArray(input) && "changes" in input && "summary" in input;
}

// ---------------------------------------------------------------------------
// Literal fallback scanner (no AST available)
// ---------------------------------------------------------------------------

export interface LiteralSite {
  file: string;
  line: number;
  pathLiteral: string;
  method?: string;
}

export class SimpleRegexScanner implements CodeScanner {
  private benchmark: ScanBenchmark = emptyBenchmark();

  async scan(repoPath: string, changes: BreakingChange[], _options?: ScanOptions): Promise<AffectedUsage[]> {
    const start = performance.now();
    this.benchmark = emptyBenchmark();
    const root = path.resolve(repoPath);
    const analysis = legacyChangesToAnalysis(changes);

    const discovery = await discoverRepository(root, { limits: { maxFileBytes: MAX_FILE_SIZE } });
    const sites: LiteralSite[] = [];
    for (const file of discovery.files) {
      const content = await readFile(path.join(root, file.id), "utf8").catch(() => null);
      if (content === null) continue;
      this.benchmark.filesScanned += 1;
      const lines = content.split("\n");
      this.benchmark.totalLines += lines.length;
      for (let i = 0; i < lines.length; i++) {
        const site = extractLiteralSite(lines[i], i, file.id);
        if (site !== null) {
          sites.push(site);
          this.benchmark.callSitesFound += 1;
        }
      }
    }

    const usages = matchLiteralCallSites(sites, analysis, root);
    this.benchmark.matchesFound = usages.length;
    this.benchmark.durationMs = Math.round(performance.now() - start);
    return usages;
  }

  getBenchmark(): ScanBenchmark {
    return { ...this.benchmark };
  }
}

/**
 * Extract a path literal plus optional method literal from one source line,
 * without an AST: quoted strings that look like paths, and `method:` config
 * literals. This is deliberately narrow — a line must carry both shape and
 * (when possible) method evidence before it can ever match.
 */
export function extractLiteralSite(line: string, index: number, file: string): LiteralSite | null {
  const pathMatch = /['"`](\/[A-Za-z0-9_\-/{}.$]*)['"`]/.exec(line);
  if (!pathMatch) return null;
  const literal = pathMatch[1];
  if (!literal.startsWith("/")) return null;
  const methodMatch = /method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)['"`]/i.exec(line);
  const callMatch = /\.(get|post|put|patch|delete|head|options)\s*\(/i.exec(line);
  const method = methodMatch?.[1]?.toUpperCase() ?? callMatch?.[1]?.toUpperCase();
  return { file, line: index + 1, pathLiteral: literal, ...(method !== undefined ? { method } : {}) };
}

export { parseFile };
