/**
 * Safe repository discovery.
 *
 * Finds candidate source files without blindly parsing everything and without
 * ever leaving the repository root:
 *
 * - respects `.gitignore` files (layered, git semantics) and hard default
 *   ignores (node_modules, .git, dist, build, coverage, .next, .turbo,
 *   .cache, vendor, out, …);
 * - supports the realistic TypeScript/JavaScript extensions (.ts, .tsx, .js,
 *   .jsx, .mts, .cts, .mjs, .cjs) plus `.d.ts` declarations and tsconfig/
 *   jsconfig files needed for path aliases;
 * - refuses symlink escapes: a symlink is followed only if its real path stays
 *   inside the root (checked with realpath, hop-limited); directory symlinks
 *   pointing inside the root are followed once and de-duplicated by real path;
 * - refuses absurd files: oversized, binary (NUL sniff), lockfiles, minified;
 * - records every exclusion with a reason so results are auditable;
 * - deterministic: entries are read with withFileTypes (no OS ordering
 *   assumptions in results — output is sorted before use).
 */
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { DEFAULT_SCANNER_LIMITS, type ScannerLimits } from "../limits.js";
import type { ExcludedFile, ExclusionReason, SourceFile } from "../model/types.js";
import { IgnoreStack, parseIgnoreFile } from "./gitignore.js";

export const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"
]);

const DECLARATION_EXTENSION = ".d.ts";

/** Config files parsed (never executed) for module path aliases. */
export const CONFIG_FILENAMES = new Set(["tsconfig.json", "jsconfig.json"]);

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "coverage",
  ".next", ".turbo", ".cache", ".parcel-cache", ".nuxt", ".output", ".svelte-kit",
  "vendor", "bower_components", "__pycache__", "target", "postgres_data",
  ".venv", "venv", ".idea", ".vscode"
]);

const DEFAULT_IGNORED_SUFFIXES = [
  ".min.js", ".min.js.map", ".min.css", ".map", ".lock", ".snap",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
  ".pdf", ".wasm", ".node", ".so", ".dylib", ".dll", ".exe",
  ".mp3", ".mp4", ".mov", ".avi", ".webm", ".wav", ".ogg",
  ".sqlite", ".db", ".dump", ".pem", ".key", ".crt", ".p12",
  ".env", ".env.local", ".env.production", ".env.development",
  ".log", ".csv", ".tsbuildinfo"
];

const DEFAULT_IGNORED_FILENAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json",
  ".DS_Store", "tsconfig.tsbuildinfo"
]);

export interface DiscoveryOptions {
  readonly include?: ReadonlyArray<string>;
  readonly exclude?: ReadonlyArray<string>;
  readonly limits?: Partial<ScannerLimits>;
  /** Honor `.gitignore` files (default true; defaults are always honored). */
  readonly respectGitignore?: boolean;
}

export interface DiscoveryResult {
  readonly files: ReadonlyArray<SourceFile>;
  readonly excluded: ReadonlyArray<ExcludedFile>;
  readonly fileLimitReached: boolean;
}

const INCLUDE_ALL = "**";

export async function discoverRepository(
  rootAbs: string,
  options: DiscoveryOptions = {}
): Promise<DiscoveryResult> {
  const limits: ScannerLimits = { ...DEFAULT_SCANNER_LIMITS, ...options.limits };
  const excluded: ExcludedFile[] = [];
  const files: SourceFile[] = [];
  const seenRealPaths = new Set<string>([rootAbs]);
  const ignoreStack = new IgnoreStack();
  let fileLimitReached = false;

  const rootReal = await realpath(rootAbs).catch(() => rootAbs);
  const root = rootReal;

  const isSourceCandidate = (name: string): boolean => {
    if (SOURCE_EXTENSIONS.has(path.extname(name))) return true;
    if (name.endsWith(DECLARATION_EXTENSION)) return true;
    if (CONFIG_FILENAMES.has(name)) return true;
    return false;
  };

  const matchesUserInclude = (rel: string, name: string): boolean => {
    const include = options.include;
    if (!include || include.length === 0) return true;
    return include.some((pattern) =>
      pattern === INCLUDE_ALL ? true : globMatch(pattern, rel) || (!pattern.includes("/") && pattern === name)
    );
  };

  const matchesUserExclude = (rel: string, name: string): boolean => {
    const exclude = options.exclude;
    if (!exclude || exclude.length === 0) return false;
    return exclude.some((pattern) =>
      globMatch(pattern, rel) || (!pattern.includes("/") && (pattern === name || rel.startsWith(`${pattern}/`)))
    );
  };

  const walk = async (
    dirAbs: string,
    relDir: string,
    depth: number
  ): Promise<void> => {
    if (files.length >= limits.maxFiles) {
      fileLimitReached = true;
      return;
    }
    if (depth > limits.maxDirectoryDepth) {
      excluded.push({ path: relDir || ".", reason: "depth-limit" });
      return;
    }
    const entries = await readdir(dirAbs, { withFileTypes: true }).catch(() => null);
    if (entries === null) {
      excluded.push({ path: relDir || ".", reason: "unreadable" });
      return;
    }

    // Load this directory's .gitignore before evaluating children (git order).
    if (options.respectGitignore !== false) {
      const giPath = path.join(dirAbs, ".gitignore");
      const giContent = await readFile(giPath, "utf8").catch(() => null);
      if (giContent !== null) {
        ignoreStack.push(depth, parseIgnoreFile(giContent, depth));
      }
    }

    for (const entry of entries) {
      const name = entry.name;
      const childRel = relDir ? `${relDir}/${name}` : name;

      if (DEFAULT_IGNORED_FILENAMES.has(name)) continue;

      if (entry.isSymbolicLink()) {
        await handleSymlink(dirAbs, childRel, name, depth);
        continue;
      }

      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRECTORIES.has(name)) continue;
        if (matchesUserExclude(childRel, name)) continue;
        if (options.respectGitignore !== false && ignoreStack.ignores(childRel, true)) continue;
        await walk(path.join(dirAbs, name), childRel, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!isSourceCandidate(name)) continue;
      if (DEFAULT_IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue;
      if (matchesUserExclude(childRel, name)) continue;
      if (options.respectGitignore !== false && ignoreStack.ignores(childRel, false)) continue;
      if (!matchesUserInclude(childRel, name)) continue;

      if (files.length >= limits.maxFiles) {
        fileLimitReached = true;
        excluded.push({ path: childRel, reason: "file-limit" });
        continue;
      }

      const abs = path.join(dirAbs, name);
      const fileStat = await stat(abs).catch(() => null);
      if (fileStat === null) {
        excluded.push({ path: childRel, reason: "unreadable" });
        continue;
      }
      if (fileStat.size > limits.maxFileBytes) {
        excluded.push({ path: childRel, reason: "oversized" });
        continue;
      }
      const bytes = await readFile(abs).catch(() => null);
      if (bytes === null) {
        excluded.push({ path: childRel, reason: "unreadable" });
        continue;
      }
      if (isBinary(bytes)) {
        excluded.push({ path: childRel, reason: "binary" });
        continue;
      }

      files.push({
        id: childRel,
        sizeBytes: fileStat.size,
        hash: sha256Hex(bytes),
        generated: hasGeneratedMarker(bytes),
        declarationOnly: name.endsWith(DECLARATION_EXTENSION),
        parse: { ok: true, nodeCount: 0 }
      });
    }
  };

  const handleSymlink = async (
    parentAbs: string,
    childRel: string,
    name: string,
    depth: number
  ): Promise<void> => {
    const linkAbs = path.join(parentAbs, name);
    // Resolve the link chain with a hop bound; refuse chains that are too long.
    let current = linkAbs;
    let hops = 0;
    for (;;) {
      const st = await lstat(current).catch(() => null);
      if (st === null) {
        excluded.push({ path: childRel, reason: "unreadable" });
        return;
      }
      if (!st.isSymbolicLink()) break;
      const target = await realpath(current).catch(() => null);
      if (target === null) {
        excluded.push({ path: childRel, reason: "unreadable" });
        return;
      }
      current = target;
      hops += 1;
      if (hops > limits.maxSymlinkHops) {
        excluded.push({ path: childRel, reason: "symlink-loop" });
        return;
      }
    }
    let resolved: string;
    try {
      resolved = await realpath(current);
    } catch {
      excluded.push({ path: childRel, reason: "unreadable" });
      return;
    }
    if (!isWithin(root, resolved)) {
      // Never follow a symlink outside the workspace root.
      excluded.push({ path: childRel, reason: "symlink-escape" });
      return;
    }
    if (seenRealPaths.has(resolved)) return; // de-duplicate cycles by real path
    const targetStat = await stat(resolved).catch(() => null);
    if (targetStat === null) {
      excluded.push({ path: childRel, reason: "unreadable" });
      return;
    }
    if (targetStat.isDirectory()) {
      seenRealPaths.add(resolved);
      const relInside = path.relative(root, resolved).split(path.sep).join("/");
      await walk(resolved, childRel, depth + 1);
      void relInside;
    } else if (targetStat.isFile() && isSourceCandidate(name)) {
      seenRealPaths.add(resolved);
      if (matchesUserExclude(childRel, name)) return;
      if (targetStat.size > limits.maxFileBytes) {
        excluded.push({ path: childRel, reason: "oversized" });
        return;
      }
      const bytes = await readFile(resolved).catch(() => null);
      if (bytes === null || isBinary(bytes)) {
        excluded.push({ path: childRel, reason: "binary" });
        return;
      }
      if (files.length < limits.maxFiles) {
        files.push({
          id: childRel,
          sizeBytes: targetStat.size,
          hash: sha256Hex(bytes),
          generated: hasGeneratedMarker(bytes),
          declarationOnly: name.endsWith(DECLARATION_EXTENSION),
          parse: { ok: true, nodeCount: 0 }
        });
      } else {
        fileLimitReached = true;
      }
    }
  };

  await walk(root, "", 0);

  files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  excluded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const summary = new Map<ExclusionReason, number>();
  for (const item of excluded) summary.set(item.reason, (summary.get(item.reason) ?? 0) + 1);

  return {
    files,
    excluded,
    fileLimitReached
  };
}

/** NUL-byte sniff over the first 8 KiB: cheap and reliably catches binaries. */
export function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8192);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

const GENERATED_MARKER = /(?:^|\n)\s*(?:\/\/|#|\*|\/\*)\s*@?generated\s*(?:by|from|code|file)?/i;

/** Conventional `@generated` marker in the first lines of the file. */
export function hasGeneratedMarker(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.slice(0, 4096)).toString("utf8");
  return GENERATED_MARKER.test(head.split(/\r?\n/, 10).join("\n"));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Minimal glob for user include/exclude options (`*`, `**`, `?`). */
export function globMatch(pattern: string, relPath: string): boolean {
  const source = pattern
    .split("/")
    .map((segment) => {
      if (segment === "**") return "(?:[^/]+/)*[^/]+";
      let out = "";
      for (const ch of segment) {
        if (ch === "*") out += "[^/]*";
        else if (ch === "?") out += "[^/]";
        else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      return out;
    })
    .join("/");
  return new RegExp(`^${source}$`).test(relPath);
}

export function exclusionCounts(excluded: ReadonlyArray<ExcludedFile>): ReadonlyArray<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of excluded) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
}
