/**
 * Operation index and path-template matching.
 *
 * The index is built from the Turn 2 semantic analysis (`SpecChangeAnalysis`):
 * every NON_NON_BREAKING change is attached to the operation named by its
 * location. Usages are then matched against this index structurally:
 *
 * - OpenAPI templates (`/users/{id}`) are compiled to segment lists;
 * - reconstructed usage paths (same segment shape, `${...}` holes) are matched
 *   segment-by-segment — `/user`, `/users` and `/users/{id}` stay distinct;
 * - a usage path may carry a leading unresolved prefix (base URL) or literal
 *   base path; both are handled with explicit evidence and downgraded
 *   confidence, never silently;
 * - method must agree when both sides know it.
 *
 * No substring matching anywhere: `/charges` never matches `/charges/{id}`.
 */
import type { ApiChange, SpecChangeAnalysis } from "@capibara/openapi";
import type { PathPattern, PathSegment } from "../values/eval.js";

export interface OperationEntry {
  readonly key: string;
  readonly path: string;
  readonly method: string;
  readonly operationId?: string;
  /**
   * Earlier operationIds this operation was known under (rename/removal rules
   * carry them in `oldValue`). Generated clients call methods by these names,
   * so a symbol matching a *previous* id is still strong evidence — with the
   * rename stated explicitly.
   */
  readonly previousOperationIds: ReadonlyArray<string>;
  readonly changes: ReadonlyArray<ApiChange>;
}

export type PathMatchKind = "exact" | "base-absorbed" | "leading-hole";

export interface PathMatch {
  readonly kind: PathMatchKind;
  /** How many leading usage segments were discarded as a base-path prefix. */
  readonly discardedSegments: number;
  readonly confidence: "HIGH" | "MEDIUM" | "LOW";
}

/**
 * The operationId an operation carried *before* the change, when the rule is
 * about renaming/removing ids. Only these rules may contribute previous ids —
 * the diff engine states the rename explicitly, so using the old name as
 * evidence is traceable, not a guess.
 */
function previousOperationIdOf(change: ApiChange): string | undefined {
  if (
    (change.rule === "OPERATION_ID_CHANGED" || change.rule === "OPERATION_ID_REMOVED") &&
    typeof change.oldValue === "string" &&
    change.oldValue.length > 0
  ) {
    return change.oldValue;
  }
  return undefined;
}

export class OperationIndex {
  private readonly entries = new Map<string, OperationEntry>();

  static fromAnalysis(analysis: SpecChangeAnalysis): OperationIndex {
    const index = new OperationIndex();
    for (const change of analysis.changes) {
      if (change.severity === "NON_BREAKING") continue;
      const { path, method } = change.location;
      if (path === undefined || method === undefined) continue;
      index.add(change, path, method);
    }
    return index;
  }

  private add(change: ApiChange, path: string, method: string): void {
    const key = `${method.toUpperCase()} ${path}`;
    const previous = previousOperationIdOf(change);
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.set(key, {
        ...existing,
        changes: [...existing.changes, change],
        previousOperationIds: previous
          ? [...new Set([...existing.previousOperationIds, previous])].sort()
          : existing.previousOperationIds
      });
    } else {
      this.entries.set(key, {
        key,
        path,
        method: method.toUpperCase(),
        operationId: change.location.operationId,
        previousOperationIds: previous ? [previous] : [],
        changes: [change]
      });
    }
  }

  all(): OperationEntry[] {
    return [...this.entries.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  byKey(key: string): OperationEntry | undefined {
    return this.entries.get(key);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Operations referenced by a specific change id. */
  operationsForChange(changeId: string): OperationEntry[] {
    return this.all().filter((entry) => entry.changes.some((c) => c.id === changeId));
  }
}

// ---------------------------------------------------------------------------
// Template compilation and matching
// ---------------------------------------------------------------------------

export interface TemplateSegment {
  readonly kind: "literal" | "param";
  readonly text: string;
}

export function compileTemplate(template: string): TemplateSegment[] {
  const trimmed = template.replace(/\/+$/, "");
  return trimmed
    .split("/")
    .filter((s) => s.length > 0)
    .map((segment) => {
      const match = /^\{([^/}]+)\}$/.exec(segment);
      return match ? { kind: "param" as const, text: match[1] } : { kind: "literal" as const, text: segment };
    });
}

/**
 * Split a reconstructed usage path into comparable segments: literal segments
 * are split on `/`, holes each occupy exactly one segment.
 */
export function usageSegments(pattern: PathPattern): PathSegment[] {
  const out: PathSegment[] = [];
  for (const segment of pattern.segments) {
    if (segment.kind === "hole") {
      out.push(segment);
      continue;
    }
    for (const piece of segment.text.split("/")) {
      if (piece !== "") out.push({ kind: "literal", text: piece });
    }
  }
  return out;
}

/**
 * Match usage segments against template segments. Returns the alignment result
 * or null when they cannot be the same resource.
 */
export function matchUsageToOperation(
  usage: PathPattern,
  entry: OperationEntry
): PathMatch | null {
  const template = compileTemplate(entry.path);
  const segments = usageSegments(usage);

  // 1. Direct match: same length.
  const direct = alignSegments(segments, template);
  if (direct !== null) {
    return { kind: "exact", discardedSegments: 0, ...confidenceFor(direct) };
  }

  // 2. Usage has a leading hole (`${base}/users/${id}`): align template to the
  //    usage tail. The template must consume the usage path to its very end —
  //    a trailing remainder would be a different resource.
  if (segments.length > 0 && segments[0].kind === "hole" && segments.length - 1 >= template.length) {
    const skip = segments.length - template.length;
    const tail = segments.slice(skip);
    const alignment = alignSegments(tail, template);
    if (alignment !== null) {
      return { kind: "leading-hole", discardedSegments: skip, ...confidenceFor(alignment) };
    }
  }

  // 3. Literal base-path prefix (`/api/v1` + `/charges`, or an axios instance
  //    baseURL): discard a leading usage prefix and require the remainder to
  //    match the template exactly. Both halves are strict: the discarded
  //    prefix must be all literals (a hole there means the base itself is
  //    dynamic — rule 2 territory), and the remainder must agree structurally
  //    with no hole silently absorbing a literal. Otherwise `/hooks/${id}`
  //    would "match" `/pay` by throwing away `hooks` — a different resource.
  if (segments.length > template.length) {
    for (let discard = 1; discard <= segments.length - template.length; discard++) {
      const discarded = segments.slice(0, discard);
      if (discarded.some((seg) => seg.kind !== "literal")) continue;
      const tail = segments.slice(discard);
      const alignment = alignSegments(tail, template);
      if (alignment !== null && alignment.holesForLiterals === 0) {
        return { kind: "base-absorbed", discardedSegments: discard, ...confidenceFor(alignment) };
      }
    }
  }

  return null;
}

interface Alignment {
  /** Literal usage segments that were checked against literal template segments. */
  readonly literalAgreements: number;
  /** Usage holes that were forced to stand in for a literal template segment. */
  readonly holesForLiterals: number;
}

function alignSegments(usage: ReadonlyArray<PathSegment>, template: ReadonlyArray<TemplateSegment>): Alignment | null {
  if (usage.length !== template.length) return null;
  let literalAgreements = 0;
  let holesForLiterals = 0;
  for (let i = 0; i < usage.length; i++) {
    const u = usage[i];
    const t = template[i];
    if (t.kind === "param") continue; // any single segment satisfies a param
    if (u.kind === "literal") {
      if (u.text !== t.text) return null;
      literalAgreements += 1;
    } else {
      // A hole in place of a literal: unknown, not contradictory — but it
      // weakens the match and must never look like certainty.
      holesForLiterals += 1;
    }
  }
  return { literalAgreements, holesForLiterals };
}

function confidenceFor(alignment: Alignment): { confidence: "HIGH" | "MEDIUM" | "LOW" } {
  if (alignment.holesForLiterals > 0) return { confidence: "MEDIUM" };
  if (alignment.literalAgreements === 0) return { confidence: "LOW" };
  return { confidence: "HIGH" };
}
