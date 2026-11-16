/**
 * Structural call-site ↔ OpenAPI matching.
 *
 * `matchLiteralCallSites` implements the fallback path matching with real
 * template semantics: segment-wise comparison against compiled OpenAPI
 * templates, `{$...}` holes matching `{param}` segments, no substring logic.
 *
 * `matchCallSites` is the legacy entry point over `ParsedCallSite`s produced by
 * the tree-sitter extractor; it applies the same structural rules plus
 * operationId equality. Confidence reflects evidence quality only —
 * description-text similarity is never consulted (removed deliberately).
 */
import path from "node:path";
import { createHash } from "node:crypto";
import type { AffectedUsage } from "@capibara/shared";
import type { SpecChangeAnalysis } from "@capibara/openapi";
import type { ParsedCallSite } from "./call-site-extractor.js";
import { compileTemplate, matchUsageToOperation } from "./operations/index.js";
import type { LiteralSite } from "./tree-sitter-scanner.js";
import type { PathPattern } from "./values/eval.js";

function patternFromLiteral(literal: string): PathPattern {
  // `${...}` holes inside the literal string become explicit holes.
  const segments: Array<{ kind: "literal"; text: string } | { kind: "hole"; source?: string }> = [];
  const parts = literal.split(/(\$\{[^}]*\})/g).filter((p) => p !== "");
  for (const part of parts) {
    if (part.startsWith("${") && part.endsWith("}")) {
      segments.push({ kind: "hole", source: part.slice(2, -1) });
    } else {
      segments.push({ kind: "literal", text: part });
    }
  }
  const display = segments.map((s) => (s.kind === "literal" ? s.text : "${?}")).join("");
  return {
    display,
    segments,
    leadingHole: segments[0]?.kind === "hole",
    complete: segments.every((s) => s.kind === "literal"),
    queryStripped: false
  };
}

interface OperationView {
  key: string;
  path: string;
  method: string;
  operationId?: string;
}

function operationsOf(analysis: SpecChangeAnalysis): OperationView[] {
  const map = new Map<string, OperationView>();
  for (const change of analysis.changes) {
    if (change.severity === "NON_BREAKING") continue;
    const { path: p, method } = change.location;
    if (p === undefined || method === undefined) continue;
    const key = `${method.toUpperCase()} ${p}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        path: p,
        method: method.toUpperCase(),
        ...(change.location.operationId !== undefined ? { operationId: change.location.operationId } : {})
      });
    }
  }
  return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function matchLiteralCallSites(
  sites: LiteralSite[],
  analysis: SpecChangeAnalysis,
  repoPath: string
): AffectedUsage[] {
  const operations = operationsOf(analysis);
  const usages: AffectedUsage[] = [];
  const seen = new Set<string>();
  for (const site of sites) {
    const pattern = patternFromLiteral(site.pathLiteral);
    for (const operation of operations) {
      if (site.method !== undefined && operation.method !== site.method) continue;
      const match = matchUsageToOperation(pattern, { key: operation.key, path: operation.path, method: operation.method, previousOperationIds: [], changes: [] });
      if (match === null) continue;
      const changes = analysis.changes.filter(
        (c) => c.severity !== "NON_BREAKING" && c.location.path === operation.path && c.location.method?.toUpperCase() === operation.method
      );
      if (changes.length === 0) continue;
      const change = changes[0];
      const id = `usage_${createHash("sha256").update(`${site.file}|${site.line}|${operation.key}|${change.id}`).digest("hex").slice(0, 16)}`;
      const key = `${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      usages.push({
        id,
        file: toPosix(path.relative(repoPath, site.file)),
        line: site.line,
        column: 1,
        functionName: "(literal match)",
        snippet: site.pathLiteral,
        contextBefore: "",
        contextAfter: "",
        confidence: match.confidence === "HIGH" ? "high" : "low",
        breakingChangeId: change.id,
        operationId: operation.operationId,
        httpMethod: operation.method,
        pathPattern: operation.path
      });
    }
  }
  usages.sort((a, b) => (a.file + a.line < b.file + b.line ? -1 : 1));
  return usages;
}

// ---------------------------------------------------------------------------
// Legacy ParsedCallSite matching (tree-sitter extractor surface)
// ---------------------------------------------------------------------------

export function matchCallSites(
  sites: ParsedCallSite[],
  changes: SpecChangeAnalysis | SpecChangeChangeList,
  repoPath: string
): AffectedUsage[] {
  const analysis = toAnalysis(changes);
  const operations = operationsOf(analysis);
  const usages: AffectedUsage[] = [];
  const seen = new Set<string>();
  for (const site of sites) {
    for (const operation of operations) {
      let confidence: "high" | "medium" | null = null;
      const evidence: string[] = [];

      // Path evidence (structural template matching). Falls back to the first
      // path-shaped string literal in the call arguments when the extractor
      // did not classify the site.
      const pathSource = site.pathPattern ?? firstPathLiteral(site.argumentText) ?? firstPathLiteral(site.snippet);
      if (pathSource !== undefined) {
        const pattern = patternFromLiteral(pathSource);
        const match = matchUsageToOperation(pattern, { key: operation.key, path: operation.path, method: operation.method, previousOperationIds: [], changes: [] });
        if (match !== null) {
          if (site.httpMethod !== undefined && operation.method !== site.httpMethod.toUpperCase()) {
            continue; // method contradiction: not a match
          }
          confidence = match.confidence === "HIGH" ? "high" : "medium";
          evidence.push(
            match.kind === "exact"
              ? `path literal ${pathSource} equals ${operation.method} ${operation.path}`
              : `path literal ${pathSource} matches ${operation.method} ${operation.path} with base-path adjustment`
          );
        }
      }

      // operationId evidence (name of the called function).
      if (operation.operationId !== undefined && site.functionName === operation.operationId) {
        if (confidence === null || confidence === "medium") {
          confidence = "high";
          evidence.push(`called function name equals operationId ${operation.operationId}`);
        }
      }

      if (confidence === null) continue;
      const change = analysis.changes.find(
        (c) => c.severity !== "NON_BREAKING" && c.location.path === operation.path && c.location.method?.toUpperCase() === operation.method
      );
      if (change === undefined) continue;
      const id = `usage_${createHash("sha256").update(`${site.file}|${site.line}|${operation.key}|${change.id}`).digest("hex").slice(0, 16)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      usages.push({
        id,
        file: toPosix(path.relative(repoPath, site.file)),
        line: site.line,
        column: site.column,
        functionName: site.functionName,
        importPath: site.importPath,
        snippet: site.snippet,
        contextBefore: site.contextBefore,
        contextAfter: site.contextAfter,
        confidence,
        breakingChangeId: change.id,
        operationId: operation.operationId,
        httpMethod: site.httpMethod ?? operation.method,
        pathPattern: pathSource ?? operation.path
      });
    }
  }
  usages.sort((a, b) => (a.file + a.line < b.file + b.line ? -1 : 1));
  return usages;
}

function firstPathLiteral(text: string): string | undefined {
  const match = /['"`](\/[A-Za-z0-9_\-/{}.$]*)['"`]/.exec(text);
  return match?.[1];
}

// Re-exported for the matcher tests that exercise template semantics directly.
export { compileTemplate };

import { legacyChangesToAnalysis } from "./scan/legacy.js";
import type { BreakingChange } from "@capibara/shared";

/** Legacy call sites may pass plain breaking changes; convert once. */
type SpecChangeChangeList = ReadonlyArray<BreakingChange>;
function toAnalysis(changes: SpecChangeAnalysis | SpecChangeChangeList): SpecChangeAnalysis {
  if (!Array.isArray(changes) && !("changes" in changes)) {
    throw new Error("invalid matcher input");
  }
  if (Array.isArray(changes)) {
    return legacyChangesToAnalysis(changes as unknown as BreakingChange[]);
  }
  return changes;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
