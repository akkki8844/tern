/**
 * Module resolution over the discovered repository.
 *
 * Resolves import specifiers to files inside the repository without executing
 * any repository code: only the discovered file set and plain filesystem
 * existence checks inside the root are used. Resolution supports:
 *
 * - relative specifiers (`./client`, `../api/client.js`);
 * - extension probing in TypeScript-aware order (.ts, .tsx, .js, .jsx,
 *   .mts, .cts, .mjs, .cjs, .d.ts) and `index` module resolution;
 * - `paths` / `baseUrl` aliases from tsconfig/jsconfig (parsed, not executed);
 * - explicit external packages (`axios`, `@scope/pkg`) — recorded as external,
 *   never guessed at;
 * - explicit unresolved outcomes with reasons (`UNRESOLVED_IMPORT`), because
 *   pretending resolution succeeded is how false positives are born.
 */
import { statSync } from "node:fs";
import path from "node:path";
import { isWithin } from "../discovery/discover.js";
import type { ResolvedImport } from "../model/types.js";
import type { TsConfigPaths } from "./tsconfig.js";

const PROBE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const DECLARATION_SUFFIXES = [".d.ts"];

export interface ModuleResolverOptions {
  readonly rootAbs: string;
  readonly tsconfig?: TsConfigPaths;
  readonly maxResolutions: number;
}

export class ModuleResolver {
  private readonly cache = new Map<string, ResolvedImport>();
  private resolutionCount = 0;
  private budgetExhausted = false;

  constructor(private readonly options: ModuleResolverOptions) {}

  /** Resolve `specifier` as imported from file `fromFile` (repo-relative). */
  resolve(specifier: string, fromFile: string): ResolvedImport {
    if (this.budgetExhausted) {
      return { kind: "unresolved", reason: "resolution-budget-exhausted" };
    }
    const cacheKey = `${fromFile}->${specifier}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    this.resolutionCount += 1;
    if (this.resolutionCount > this.options.maxResolutions) {
      this.budgetExhausted = true;
      return { kind: "unresolved", reason: "resolution-budget-exhausted" };
    }

    const result = this.resolveUncached(specifier, fromFile);
    this.cache.set(cacheKey, result);
    return result;
  }

  get appliedPathAliases(): boolean {
    return this.options.tsconfig?.applied ?? false;
  }

  private resolveUncached(specifier: string, fromFile: string): ResolvedImport {
    if (specifier.startsWith(".")) {
      const baseDir = path.posix.dirname(fromFile);
      const joined = path.posix.normalize(path.posix.join(baseDir, specifier));
      const absolute = path.resolve(this.options.rootAbs, joined);
      if (!isWithin(this.options.rootAbs, absolute)) {
        return { kind: "unresolved", reason: "path-not-found" };
      }
      const rel = path.relative(this.options.rootAbs, absolute).split(path.sep).join("/");
      const found = this.probe(rel);
      if (found) return { kind: "internal", moduleId: found };
      return { kind: "unresolved", reason: "path-not-found" };
    }

    // tsconfig paths / baseUrl aliases.
    const aliased = this.resolveViaTsconfig(specifier);
    if (aliased) return aliased;

    // Bare specifiers starting with `#` are package imports — external.
    if (specifier.startsWith("#")) {
      return { kind: "external", packageName: specifier };
    }

    // Scoped or plain npm package: record as external, never probe node_modules.
    return { kind: "external", packageName: specifier };
  }

  private resolveViaTsconfig(specifier: string): ResolvedImport | null {
    const config = this.options.tsconfig;
    if (!config || (!config.applied)) return null;
    // baseUrl: non-relative specifiers resolve against baseUrl if the file exists.
    if (config.baseUrl) {
      const baseAbs = path.resolve(config.baseUrl, specifier);
      if (isWithin(this.options.rootAbs, baseAbs)) {
        const rel = path.relative(this.options.rootAbs, baseAbs).split(path.sep).join("/");
        const found = this.probe(rel);
        if (found) return { kind: "internal", moduleId: found };
      }
    }
    for (const { pattern, targets } of config.paths) {
      const matched = matchPattern(pattern, specifier);
      if (matched === null) continue;
      for (const target of targets) {
        const expanded = matched === "" ? target : target.replace(/\*/g, matched);
        const baseAbs = path.resolve(config.baseUrl ?? this.options.rootAbs, expanded);
        if (!isWithin(this.options.rootAbs, baseAbs)) continue;
        const rel = path.relative(this.options.rootAbs, baseAbs).split(path.sep).join("/");
        const found = this.probe(rel);
        if (found) return { kind: "internal", moduleId: found };
      }
    }
    return null;
  }

  /** Extension + index probing against the filesystem, confined to the root. */
  private probe(rel: string): string | null {
    // Exact file (specifier already carried an extension).
    if (this.existsFile(rel)) return rel;
    // Strip a known JS extension and probe TS siblings first (TS-first repos).
    const withoutExt = rel.replace(/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/, "");
    for (const ext of PROBE_EXTENSIONS) {
      if (this.existsFile(withoutExt + ext)) return withoutExt + ext;
    }
    for (const suffix of DECLARATION_SUFFIXES) {
      if (this.existsFile(withoutExt + suffix)) return withoutExt + suffix;
    }
    // Index modules: ./client -> ./client/index.ts
    for (const ext of PROBE_EXTENSIONS) {
      if (this.existsFile(`${rel}/index${ext}`)) return `${rel}/index${ext}`;
    }
    for (const suffix of DECLARATION_SUFFIXES) {
      if (this.existsFile(`${rel}/index${suffix}`)) return `${rel}/index${suffix}`;
    }
    return null;
  }

  private existsFile(rel: string): boolean {
    const abs = path.resolve(this.options.rootAbs, rel);
    if (!isWithin(this.options.rootAbs, abs)) return false;
    // Synchronous existence check keeps the resolver deterministic and simple;
    // results are cached per specifier.
    try {
      return statSync(abs).isFile();
    } catch {
      return false;
    }
  }
}

function matchPattern(pattern: string, specifier: string): string | null {
  if (!pattern.includes("*")) return pattern === specifier ? "" : null;
  const [prefix, suffix] = pattern.split("*");
  if (!specifier.startsWith(prefix)) return null;
  if (!specifier.endsWith(suffix)) return null;
  if (specifier.length < prefix.length + suffix.length) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}
