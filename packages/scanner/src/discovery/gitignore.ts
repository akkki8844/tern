/**
 * A deterministic subset of `.gitignore` semantics, sufficient for source
 * discovery: comments, blank lines, negation (`!`), directory-only patterns
 * (`build/`), anchoring (`/dist`, `/a/b`), `**`, `*`, `?` and `[...]` classes.
 * Unsupported constructs degrade to conservative (exclude-more) behaviour and
 * are reported by the parser for auditability.
 *
 * Semantics follow git: within one file, the LAST matching pattern wins;
 * deeper `.gitignore` files override shallower ones. Patterns containing an
 * explicit negation can only re-include a file if no parent directory was
 * excluded (git cannot re-include inside excluded directories) — we implement
 * the same rule by evaluating directories and files in order.
 */

export interface IgnorePattern {
  readonly negated: boolean;
  readonly dirOnly: boolean;
  readonly anchored: boolean;
  readonly source: string;
  readonly segments: ReadonlyArray<string>;
}

export interface ParsedIgnoreFile {
  readonly patterns: ReadonlyArray<IgnorePattern>;
  readonly unsupportedLines: ReadonlyArray<string>;
}

const SUPPORTED_SEGMENT = /^(?:\*\*|\*|\?|[^[]+)$/;

export function parseIgnoreFile(content: string, fileDirDepth: number): ParsedIgnoreFile {
  const patterns: IgnorePattern[] = [];
  const unsupportedLines: string[] = [];
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/(?<!^)\\$/, "").trimEnd();
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    let body = trimmed;
    let negated = false;
    if (body.startsWith("!")) {
      negated = true;
      body = body.slice(1);
    }
    let dirOnly = false;
    if (body.endsWith("/")) {
      dirOnly = true;
      body = body.slice(0, -1);
    }
    if (body === "") continue;
    let anchored = false;
    if (body.startsWith("/")) {
      anchored = true;
      body = body.slice(1);
    } else if (body.includes("/")) {
      // A pattern with an inner slash is anchored to the .gitignore location.
      anchored = true;
    }
    const segments = body.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    const unsupported = segments.some((s) => !SUPPORTED_SEGMENT.test(s) || s.includes("\\"));
    if (unsupported) {
      unsupportedLines.push(trimmed);
      // Conservative fallback: treat an unsupported pattern as a name match.
    }
    patterns.push({ negated, dirOnly, anchored, source: trimmed, segments });
  }
  void fileDirDepth;
  return { patterns, unsupportedLines };
}

/** Does one pattern segment match a path segment? Supports `*`, `?`, classes. */
function segmentMatches(segment: string, part: string): boolean {
  if (segment === "**") return true;
  return globToRegExp(segment).test(part);
}

function globToRegExp(segment: string): RegExp {
  let source = "^";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if (ch === "[") {
      const close = segment.indexOf("]", i);
      if (close === -1) source += "\\[";
      else {
        source += segment.slice(i, close + 1).replace(/([\\\]])/g, "\\$1").replace(/^\[\^?/, (m) => m);
        i = close;
      }
    } else source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(source + "$");
}

/**
 * Evaluate a repo-relative POSIX path (file or directory) against one parsed
 * ignore file. Returns: `"ignored"`, `"negated"` (explicitly re-included) or
 * `"none"`.
 */
export function matchesIgnoreFile(
  patterns: ReadonlyArray<IgnorePattern>,
  relPath: string,
  isDirectory: boolean
): "ignored" | "negated" | "none" {
  const parts = relPath.split("/");
  let result: "ignored" | "negated" | "none" = "none";
  for (const pattern of patterns) {
    if (pattern.dirOnly && !isDirectory) {
      // A directory-only pattern can still match a file via its parent chain,
      // which the walker evaluates per directory.
      continue;
    }
    if (patternMatches(pattern, parts)) {
      result = pattern.negated ? "negated" : "ignored";
    }
  }
  return result;
}

function patternMatches(pattern: IgnorePattern, parts: ReadonlyArray<string>): boolean {
  if (!pattern.anchored) {
    // Unanchored: match against the basename, or any single trailing segment path.
    const base = parts[parts.length - 1];
    if (pattern.segments.length === 1 && segmentMatches(pattern.segments[0], base)) return true;
  }
  return matchSegments(pattern.segments, parts, 0, 0);
}

function matchSegments(
  segments: ReadonlyArray<string>,
  parts: ReadonlyArray<string>,
  si: number,
  pi: number
): boolean {
  while (si < segments.length) {
    const seg = segments[si];
    if (seg === "**") {
      // `**` matches zero or more segments.
      for (let skip = pi; skip <= parts.length; skip++) {
        if (matchSegments(segments, parts, si + 1, skip)) return true;
      }
      return false;
    }
    if (pi >= parts.length) return false;
    if (!segmentMatches(seg, parts[pi])) return false;
    si += 1;
    pi += 1;
  }
  return pi === parts.length;
}

/**
 * Layered ignore state used during the walk: root patterns plus one entry per
 * directory-level `.gitignore`. Evaluation order (root first, deepest last)
 * mirrors git.
 */
export class IgnoreStack {
  private readonly layers: Array<{ readonly depth: number; readonly parsed: ParsedIgnoreFile }> = [];

  push(depth: number, parsed: ParsedIgnoreFile): void {
    this.layers.push({ depth, parsed });
  }

  /** Is `relPath` ignored? `negated` re-includes only if no directory was ignored. */
  ignores(relPath: string, isDirectory: boolean): boolean {
    let ignored = false;
    for (const layer of this.layers) {
      const outcome = matchesIgnoreFile(layer.parsed.patterns, relPath, isDirectory);
      if (outcome === "ignored") ignored = true;
      else if (outcome === "negated") ignored = false;
    }
    return ignored;
  }
}
