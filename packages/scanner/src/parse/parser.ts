/**
 * Tree-sitter parsing with per-extension grammar selection and explicit
 * error representation.
 *
 * Grammar choice:
 * - `.ts`, `.mts`, `.cts`, `.d.ts` → the TypeScript grammar;
 * - `.tsx`, `.jsx` → the TSX grammar (JSX requires it);
 * - `.js`, `.mjs`, `.cjs` → the TSX grammar as well: it is a strict superset
 *   that also accepts JSX inside `.js` (common in real apps) and plain JS.
 *
 * A syntax error in one file never fails the scan: the tree is still returned
 * (tree-sitter is error-recovering) and every error node is reported in the
 * scan result. Node counts are bounded so pathological inputs cannot make the
 * analysis unbounded.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import type Parser from "tree-sitter";
import type { ParseDiagnostic } from "../model/types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ParserClass: any = null;
type Grammar = Parameters<Parser["setLanguage"]>[0];
let typescriptGrammar: Grammar | null = null;
let tsxGrammar: Grammar | null = null;
let loadAttempted = false;

/**
 * The native grammar modules are CommonJS; loading them through createRequire
 * is synchronous and works from both ESM and CJS entry points. Native modules
 * are loaded once, at first use, never from repository-controlled paths.
 */
function ensureLoaded(): boolean {
  if (loadAttempted) return ParserClass !== null && typescriptGrammar !== null;
  loadAttempted = true;
  try {
    const require = createRequire(import.meta.url);
    const parserMod = require("tree-sitter");
    const tsMod = require("tree-sitter-typescript");
    ParserClass = parserMod.default ?? parserMod;
    const grammars = tsMod.default ?? tsMod;
    typescriptGrammar = grammars.typescript;
    tsxGrammar = grammars.tsx;
    return ParserClass !== null && typescriptGrammar !== null && tsxGrammar !== null;
  } catch {
    return false;
  }
}

/** Availability check used by the pipeline to pick an engine. */
export function treeSitterLoadable(): boolean {
  return ensureLoaded();
}

export type SourceGrammar = "typescript" | "tsx";

export function grammarForFile(filePath: string): SourceGrammar {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return "typescript";
  return "tsx";
}

export interface ParsedFile {
  readonly tree: Parser.Tree;
  readonly grammar: SourceGrammar;
  readonly errors: ReadonlyArray<ParseDiagnostic>;
  readonly nodeCount: number;
  readonly truncated: boolean;
}

const parserInstance: { parser: Parser | null } = { parser: null };

function getParser(): Parser | null {
  if (!ensureLoaded()) return null;
  if (!parserInstance.parser) {
    try {
      parserInstance.parser = new ParserClass();
    } catch {
      return null;
    }
  }
  return parserInstance.parser;
}

export interface ParseRequest {
  readonly filePath: string;
  readonly content: string;
  readonly maxNodes: number;
}

/**
 * Parse one file. Never throws on bad syntax: errors are collected from the
 * tree and reported. Returns null only when tree-sitter itself is unavailable
 * (caller must then use the literal fallback engine).
 */
export function parseFile(request: ParseRequest): ParsedFile | null {
  const parser = getParser();
  if (parser === null || typescriptGrammar === null || tsxGrammar === null) return null;
  const grammar = grammarForFile(request.filePath);
  parser.setLanguage(grammar === "typescript" ? typescriptGrammar : tsxGrammar);
  // Long inputs must be fed through the chunked input callback: the node
  // binding rejects single strings above 32 KiB ("Invalid argument").
  const content = request.content;
  const tree = parser.parse((offset: number) => content.slice(offset, offset + 4096));
  const errors: ParseDiagnostic[] = [];
  let nodeCount = 0;
  let truncated = false;
  const cursor = tree.walk();
  const visit = (depth: number): void => {
    nodeCount += 1;
    if (nodeCount > request.maxNodes) {
      truncated = true;
      return;
    }
    const node = cursor.currentNode;
    if (node.type === "ERROR") {
      errors.push({
        message: "syntax error",
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1
      });
    } else if (node.hasError && node.childCount === 0) {
      errors.push({
        message: "incomplete syntax",
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1
      });
    }
    if (depth > 400) return; // deep-nesting guard; tree-sitter trees are shallow in practice
    if (errors.length < 50 && cursor.gotoFirstChild()) {
      do {
        visit(depth + 1);
        if (truncated) break;
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  };
  visit(0);
  return { tree, grammar, errors, nodeCount, truncated };
}

/** Cache key for a parse: path plus content hash keeps invalidation deterministic. */
export function parseCacheKey(filePath: string, content: string): string {
  return `${filePath}#${createHash("sha256").update(content).digest("hex").slice(0, 32)}`;
}

export class ParseCache {
  private readonly cache = new Map<string, ParsedFile>();

  get(key: string): ParsedFile | undefined {
    return this.cache.get(key);
  }

  set(key: string, value: ParsedFile): void {
    this.cache.set(key, value);
  }

  get size(): number {
    return this.cache.size;
  }
}
