import { createHash } from "node:crypto";
import type { HttpMethod } from "../interfaces.js";
import type { Direction } from "../model/canonical.js";
import { canonicalJson } from "../model/build.js";

export type { Direction };

/**
 * How a change affects existing clients.
 *
 * `CONDITIONAL` exists deliberately. A large class of API changes break *some*
 * clients and not others — removing a request property is harmless for a client that
 * never sent it, and adding a response enum value only breaks a client that handles
 * the enum exhaustively. Forcing those into a boolean would mean either a stream of
 * false positives or a set of silent false negatives, both of which are expensive.
 * `CONDITIONAL` says: "this depends on how the repository uses the API", which is
 * precisely the question the repository scanner answers later.
 */
export const SEVERITIES = ["BREAKING", "CONDITIONAL", "NON_BREAKING", "UNKNOWN"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * How confidently the engine established the classification.
 *
 * These are not probabilities. They describe the *evidence*, not a likelihood:
 *
 *  - `HIGH`    — determined by an unambiguous local rule over fully analysed data.
 *  - `MEDIUM`  — the rule is sound, but the effect depends on client behaviour Tern
 *                cannot observe from the specification alone.
 *  - `LOW`     — the change was detected structurally, but its semantic effect
 *                depends on composition Tern models only partially.
 *  - `UNKNOWN` — an unsupported construct is involved; no compatibility claim is made.
 */
export const CONFIDENCES = ["HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const CHANGE_KINDS = [
  "path",
  "operation",
  "parameter",
  "requestBody",
  "response",
  "schema",
  "component",
  "document"
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/**
 * Where a change happened.
 *
 * `displayPath` is the human-facing address used in reports and CLI output.
 * The structured fields are what the repository scanner will match against.
 */
export interface ChangeLocation {
  /** Dotted, human-readable address, e.g. `paths./users/{id}.get.parameters.path.id.required`. */
  readonly displayPath: string;
  /** RFC 6901 pointer into the document the value came from, when one applies. */
  readonly jsonPointer?: string;
  readonly path?: string;
  readonly method?: HttpMethod;
  readonly operationId?: string;
  readonly parameterName?: string;
  readonly parameterIn?: "query" | "path" | "header" | "cookie";
  readonly statusCode?: string;
  readonly mediaType?: string;
  /** Name of the `components/schemas` entry the change originates from, if any. */
  readonly componentSchema?: string;
  /** Property names from the root of the schema down to the change. */
  readonly propertyPath?: readonly string[];
  readonly propertyName?: string;
}

export interface ApiChange {
  /** Deterministic identity: a hash of rule, location and values. Never random. */
  readonly id: string;
  readonly rule: RuleId;
  readonly kind: ChangeKind;
  readonly location: ChangeLocation;
  readonly direction: Direction;
  readonly severity: Severity;
  /** Convenience: `severity === "BREAKING"`. Conditional changes are not breaking. */
  readonly breaking: boolean;
  readonly confidence: Confidence;
  /** One sentence explaining why this classification applies, in client terms. */
  readonly reason: string;
  readonly oldValue?: unknown;
  readonly newValue?: unknown;
  /** Rule-specific extra detail (enum deltas, type sets, and so on). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * A hypothesis that two members are the same thing under a new name.
 *
 * This is deliberately **not** a breaking-change classification. Renames are inferred
 * from structural evidence and can be wrong, and Tern's rules must never depend on a
 * guess. The authoritative classification for a rename is always the pair
 * `PROPERTY_REMOVED` + `PROPERTY_ADDED`; this record is an additional hint for the
 * later migration stage, carrying the evidence that produced it.
 */
export interface RenameCandidate {
  readonly kind: "property" | "parameter" | "operationId" | "path";
  readonly from: string;
  readonly to: string;
  readonly location: ChangeLocation;
  readonly direction: Direction;
  readonly confidence: Confidence;
  /** The structural facts that support the hypothesis. Never textual similarity alone. */
  readonly evidence: readonly string[];
}

export interface UnsupportedNote {
  readonly displayPath: string;
  readonly feature: string;
  readonly detail: string;
}

export interface ChangeSummary {
  readonly total: number;
  readonly breaking: number;
  readonly conditional: number;
  readonly nonBreaking: number;
  readonly unknown: number;
  readonly byDirection: Readonly<Record<Direction, number>>;
}

/**
 * The complete, machine-readable result of comparing two specifications.
 *
 * This is the contract the scanner, the migration planner and the CLI consume.
 */
export interface SpecChangeReport {
  readonly oldVersion: string;
  readonly newVersion: string;
  readonly oldOpenApiVersion: string;
  readonly newOpenApiVersion: string;
  /** Sorted deterministically by location then rule. */
  readonly changes: readonly ApiChange[];
  readonly renameCandidates: readonly RenameCandidate[];
  /** Constructs that could not be analysed, so callers can see the blind spots. */
  readonly unsupported: readonly UnsupportedNote[];
  readonly summary: ChangeSummary;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Deterministic change id.
 *
 * The same pair of documents must always produce the same ids, on any machine, in
 * any process. That is what makes diffs comparable across runs and makes precision
 * and recall measurable over a benchmark corpus.
 */
export function computeChangeId(
  rule: string,
  displayPath: string,
  direction: Direction,
  oldValue: unknown,
  newValue: unknown
): string {
  const material = [rule, displayPath, direction, canonicalJson(oldValue ?? null), canonicalJson(newValue ?? null)].join(
    "\u0000"
  );
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** Total ordering used to make report output stable. */
export function compareChanges(a: ApiChange, b: ApiChange): number {
  if (a.location.displayPath !== b.location.displayPath) {
    return a.location.displayPath < b.location.displayPath ? -1 : 1;
  }
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  if (a.direction !== b.direction) return a.direction < b.direction ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function summarize(changes: readonly ApiChange[]): ChangeSummary {
  const byDirection: Record<Direction, number> = { request: 0, response: 0, both: 0, unknown: 0 };
  let breaking = 0;
  let conditional = 0;
  let nonBreaking = 0;
  let unknown = 0;
  for (const change of changes) {
    byDirection[change.direction] += 1;
    if (change.severity === "BREAKING") breaking += 1;
    else if (change.severity === "CONDITIONAL") conditional += 1;
    else if (change.severity === "NON_BREAKING") nonBreaking += 1;
    else unknown += 1;
  }
  return { total: changes.length, breaking, conditional, nonBreaking, unknown, byDirection };
}

// Imported here to avoid a circular import at module init: rules.ts imports the types
// above, and this file only needs the RuleId union.
import type { RuleId } from "./rules.js";
export type { RuleId };
