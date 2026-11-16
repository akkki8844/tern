/**
 * tsconfig / jsconfig reading for path aliases.
 *
 * The files are parsed as JSON with comments (JSONC) — never executed, never
 * evaluated, never required. Only `compilerOptions.paths` and
 * `compilerOptions.baseUrl` are read. `extends` chains are followed when the
 * target is inside the repository root (bounded), because path aliases may be
 * defined in a shared base config.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isWithin } from "../discovery/discover.js";

export interface TsConfigPaths {
  /** Alias pattern -> target patterns, e.g. `@lib/*` -> ["packages/lib/src/*"]. */
  readonly paths: ReadonlyArray<{ readonly pattern: string; readonly targets: ReadonlyArray<string> }>;
  readonly baseUrl: string | undefined;
  readonly applied: boolean;
}

interface RawTsConfig {
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
  extends?: string | string[];
}

/** Strip comments and trailing commas so `JSON.parse` accepts tsconfig JSONC. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }
  // Trailing commas.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export async function readTsConfigPaths(
  configPath: string,
  rootAbs: string,
  depth = 0
): Promise<TsConfigPaths> {
  const raw = await readFile(configPath, "utf8").catch(() => null);
  if (raw === null) return { paths: [], baseUrl: undefined, applied: false };
  let parsed: RawTsConfig;
  try {
    parsed = JSON.parse(stripJsonComments(raw)) as RawTsConfig;
  } catch {
    return { paths: [], baseUrl: undefined, applied: false };
  }
  let inherited: TsConfigPaths = { paths: [], baseUrl: undefined, applied: false };
  if (parsed.extends && depth < 4) {
    const bases = Array.isArray(parsed.extends) ? parsed.extends : [parsed.extends];
    for (const base of bases) {
      const baseResolved = base.startsWith(".")
        ? path.resolve(path.dirname(configPath), base)
        : path.join(rootAbs, "node_modules", base); // package-shared configs are read from disk, not executed
      if (!isWithin(rootAbs, baseResolved)) continue;
      inherited = await readTsConfigPaths(baseResolved, rootAbs, depth + 1);
    }
  }
  const options = parsed.compilerOptions;
  if (!options) return inherited;
  const baseUrl = options.baseUrl
    ? path.resolve(path.dirname(configPath), options.baseUrl)
    : inherited.baseUrl;
  const paths = options.paths
    ? Object.entries(options.paths).map(([pattern, targets]) => ({ pattern, targets }))
    : [];
  return {
    paths: paths.length > 0 ? paths : inherited.paths,
    baseUrl,
    applied: paths.length > 0 || baseUrl !== undefined || inherited.applied
  };
}
