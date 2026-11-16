/**
 * Matching detected HTTP calls to OpenAPI operations, with refinement of
 * CONDITIONAL changes by usage evidence.
 *
 * Key principle (Step 16 of the scanner contract): a CONDITIONAL change is
 * attached to a usage only when the usage's own evidence supports it.
 *
 * - A request-property removal affects `client.post("/users", { name, email })`
 *   but NOT `client.post("/users", { name })` — the latter is *refined out*.
 * - A response-property removal affects only code that actually consumes the
 *   property (see response-flow analysis).
 * - A `...spread` body is an explicit `UNKNOWN`: the scanner does not pretend
 *   to know which properties a spread contributes.
 *
 * Candidate operations come from two independent evidence channels and are
 * intersected when both apply:
 *   1. path evidence  — reconstructed path + method vs the operation template;
 *   2. name evidence  — resolved generated-client symbol == operationId, or a
 *      resource chain (`client.users.getUser`) whose segments agree with the
 *      operation.
 */
import type { ApiChange } from "@capibara/openapi";
import type { Evidence, ObjectLiteralRecord } from "../model/types.js";
import { evidence } from "./adapter.js";
import type { HttpCallDetection } from "./adapter.js";
import type { OperationEntry, OperationIndex } from "../operations/index.js";
import { matchUsageToOperation } from "../operations/index.js";
import type { DetectedUsage } from "../model/usage.js";

export interface OperationCandidate {
  readonly entry: OperationEntry;
  readonly pathEvidence: ReadonlyArray<Evidence>;
  readonly nameEvidence: ReadonlyArray<Evidence>;
  readonly ambiguous: boolean;
}

export interface BodyFacts {
  /** All property paths named in the request body object (nested included). */
  readonly propertyPaths: ReadonlyArray<ReadonlyArray<string>>;
  readonly hasSpread: boolean;
  /** Spread sources, when the body contains spreads. */
  readonly spreadSources: ReadonlyArray<string>;
  /** True when no body argument was present at all. */
  readonly hasBody: boolean;
}

export function collectBodyFacts(bodyObject: ObjectLiteralRecord | undefined): BodyFacts {
  if (!bodyObject) {
    return { propertyPaths: [], hasSpread: false, spreadSources: [], hasBody: false };
  }
  const propertyPaths: string[][] = [];
  const spreadSources: string[] = [];
  let hasSpread = false;
  for (const property of bodyObject.properties) {
    if (property.valueKind === "spread") {
      hasSpread = true;
      if (property.spreadSource) spreadSources.push(property.spreadSource);
      continue;
    }
    if (property.path.length > 0 && property.valueKind !== "object") {
      propertyPaths.push([...property.path]);
    } else if (property.valueKind === "object" && property.path.length > 0) {
      // An object-valued property is itself a (sub)path the payload names.
      propertyPaths.push([...property.path]);
    }
  }
  return { propertyPaths, hasSpread, spreadSources, hasBody: true };
}

export interface CandidateSelection {
  readonly candidates: ReadonlyArray<OperationCandidate>;
  readonly outcome: "matched" | "ambiguous" | "method-mismatch" | "none";
}

/** Find operation candidates for one detection. */
export function findCandidates(
  detection: HttpCallDetection,
  index: OperationIndex
): CandidateSelection {
  const pathCandidates = new Map<string, OperationCandidate>();
  const methodEvidence: Evidence[] = [];

  if (detection.path !== undefined) {
    for (const entry of index.all()) {
      if (detection.method !== undefined && detection.method !== entry.method) {
        methodEvidence.push(
          evidence(
            "method-mismatch",
            `call method ${detection.method} does not match operation ${entry.method} ${entry.path}`,
            "LOW"
          )
        );
        continue;
      }
      const match = matchUsageToOperation(detection.path, entry);
      if (match === null) continue;
      const conf = match.confidence;
      pathCandidates.set(entry.key, {
        entry,
        pathEvidence: [
          ...detection.pathEvidence,
          evidence(
            `path-${match.kind}`,
            match.kind === "exact"
              ? `reconstructed path ${detection.path.display} equals ${entry.method} ${entry.path}`
              : match.kind === "base-absorbed"
                ? `reconstructed path ${detection.path.display} matches ${entry.method} ${entry.path} after discarding ${match.discardedSegments} leading segment(s) (base-path prefix)`
                : `reconstructed path ${detection.path.display} matches ${entry.method} ${entry.path} with an unresolved leading segment`,
            conf
          )
        ],
        nameEvidence: [],
        ambiguous: false
      });
      void conf;
    }
  }

  if (detection.kind === "generated-client-call") {
    const symbol = detection.symbol;
    for (const entry of index.all()) {
      const isCurrent = entry.operationId === symbol;
      const previous = entry.previousOperationIds.includes(symbol);
      if (!isCurrent && !previous) continue;
      const idEvidence = isCurrent
        ? evidence("operation-id-match", `resolved symbol equals operationId ${symbol}`, "HIGH")
        : evidence(
            "operation-id-renamed",
            `resolved symbol equals the operation's previous operationId ${symbol}` +
              (entry.operationId !== undefined ? ` (renamed to ${entry.operationId})` : " (removed)"),
            "HIGH"
          );
      const existing = pathCandidates.get(entry.key);
      if (existing) {
        pathCandidates.set(entry.key, {
          ...existing,
          nameEvidence: [...detection.clientEvidence, idEvidence]
        });
      } else if (detection.path === undefined || detection.pathEvidence.every((e) => e.confidence === "UNKNOWN")) {
        pathCandidates.set(entry.key, {
          entry,
          pathEvidence: [],
          nameEvidence: [...detection.clientEvidence, idEvidence],
          ambiguous: false
        });
      }
    }
  }

  if (detection.kind === "sdk-client-call") {
    const segments = detection.symbol.split(".");
    const methodSegment = segments[segments.length - 1];
    const resourceSegments = segments.slice(1, -1);
    for (const entry of index.all()) {
      const isCurrentId = entry.operationId === methodSegment;
      const previousId = entry.previousOperationIds.includes(methodSegment);
      if (!isCurrentId && !previousId) continue;
      // Resource agreement: every resource segment must appear in the path.
      const templateLiterals = entry.path.split("/").filter((s) => s.length > 0 && !s.startsWith("{"));
      const agrees = resourceSegments.every((r) => templateLiterals.includes(r));
      if (!agrees) continue;
      const existing = pathCandidates.get(entry.key);
      const nameEvidence = [
        ...detection.clientEvidence,
        evidence(
          "resource-chain-match",
          `resource chain ${segments.slice(1).join(".")} matches ${isCurrentId ? "operationId" : "previous operationId of"} ${entry.operationId}` +
            (previousId && entry.operationId !== undefined ? ` (renamed to ${entry.operationId})` : "") +
            (resourceSegments.length > 0 ? ` with path segment(s) ${resourceSegments.join(", ")}` : ""),
          resourceSegments.length > 0 ? "HIGH" : "MEDIUM"
        )
      ];
      if (existing) {
        pathCandidates.set(entry.key, { ...existing, nameEvidence });
      } else if (detection.path === undefined) {
        pathCandidates.set(entry.key, { entry, pathEvidence: [], nameEvidence, ambiguous: false });
      }
    }
  }

  const candidates = [...pathCandidates.values()].sort((a, b) => (a.entry.key < b.entry.key ? -1 : a.entry.key > b.entry.key ? 1 : 0));
  if (candidates.length === 0) {
    return { candidates: [], outcome: detection.path !== undefined && methodEvidence.length > 0 ? "method-mismatch" : "none" };
  }
  if (candidates.length > 1) {
    return {
      candidates: candidates.map((c) => ({ ...c, ambiguous: true })),
      outcome: "ambiguous"
    };
  }
  return { candidates, outcome: "matched" };
}

// ---------------------------------------------------------------------------
// Change applicability (conditional-change refinement)
// ---------------------------------------------------------------------------

export interface Applicability {
  readonly applicable: boolean;
  readonly evidence: ReadonlyArray<Evidence>;
}

const REQUEST_DIRECTIONS = new Set(["request", "both", "unknown"]);
const RESPONSE_DIRECTIONS = new Set(["response", "both", "unknown"]);

function isPropertyLevel(change: ApiChange): boolean {
  return change.location.propertyPath !== undefined || change.location.propertyName !== undefined;
}

function changePropertyPath(change: ApiChange): ReadonlyArray<string> {
  if (change.location.propertyPath !== undefined && change.location.propertyPath.length > 0) {
    return change.location.propertyPath;
  }
  return change.location.propertyName !== undefined ? [change.location.propertyName] : [];
}

/**
 * Does this change apply to a usage with the given request-body facts?
 * Implements the Step-16 refinement rules.
 */
export function changeAppliesToRequest(
  change: ApiChange,
  body: BodyFacts
): Applicability {
  const direction = change.direction;
  if (!REQUEST_DIRECTIONS.has(direction)) return { applicable: false, evidence: [] };

  if (!isPropertyLevel(change)) {
    return {
      applicable: true,
      evidence: [evidence("operation-change", `change ${change.rule} applies to the whole operation`, "HIGH")]
    };
  }
  const propertyPath = changePropertyPath(change);

  if (!body.hasBody) {
    return {
      applicable: true,
      evidence: [
        evidence("body-unknown", "no statically visible request body at the call site; the change may apply", "UNKNOWN")
      ]
    };
  }
  if (body.hasSpread) {
    return {
      applicable: true,
      evidence: [
        evidence(
          "dynamic-object-spread",
          `request body contains spread(s) (${body.spreadSources.join(", ")}); it may contribute '${propertyPath.join(".")}'`,
          "UNKNOWN"
        )
      ]
    };
  }
  const contains = body.propertyPaths.some(
    (p) => p.length >= propertyPath.length && propertyPath.every((seg, i) => p[i] === seg)
  );
  if (contains) {
    return {
      applicable: true,
      evidence: [
        evidence(
          "property-present",
          `request body literal names the property '${propertyPath.join(".")}'`,
          "HIGH"
        )
      ]
    };
  }
  return {
    applicable: false,
    evidence: [
      evidence(
        "property-absent",
        `request body literal does not name '${propertyPath.join(".")}' (names: ${body.propertyPaths.map((p) => p.join(".")).join(", ") || "none"})`,
        "HIGH"
      )
    ]
  };
}

/**
 * Does this response-property change apply given the consumed response paths?
 * `consumedPaths === null` means consumption could not be tracked.
 */
export function changeAppliesToResponse(
  change: ApiChange,
  consumedPaths: ReadonlyArray<ReadonlyArray<string>> | null
): Applicability {
  const direction = change.direction;
  if (!RESPONSE_DIRECTIONS.has(direction)) return { applicable: false, evidence: [] };

  if (!isPropertyLevel(change)) {
    return {
      applicable: true,
      evidence: [evidence("operation-change", `change ${change.rule} applies to the whole operation`, "HIGH")]
    };
  }
  const propertyPath = changePropertyPath(change);
  if (consumedPaths === null) {
    return {
      applicable: true,
      evidence: [
        evidence("response-untracked", "response consumption could not be tracked statically; the change may apply", "UNKNOWN")
      ]
    };
  }
  const consumed = consumedPaths.some(
    (p) => p.length >= propertyPath.length && propertyPath.every((seg, i) => p[i] === seg)
  );
  if (consumed) {
    return {
      applicable: true,
      evidence: [
        evidence("response-property-consumed", `this code reads the response property '${propertyPath.join(".")}'`, "HIGH")
      ]
    };
  }
  return {
    applicable: false,
    evidence: [
      evidence(
        "response-property-not-consumed",
        `tracked response accesses do not read '${propertyPath.join(".")}' (reads: ${consumedPaths.map((p) => p.join(".")).join(", ") || "none"})`,
        "HIGH"
      )
    ]
  };
}

/** Compose usage-level confidence from evidence, deterministically. */
export function usageConfidence(evidenceItems: ReadonlyArray<Evidence>): DetectedUsage["confidence"] {
  let worst: DetectedUsage["confidence"] = "HIGH";
  let sawAny = false;
  for (const item of evidenceItems) {
    sawAny = true;
    if (item.confidence === "UNKNOWN") return "UNKNOWN";
    if (item.confidence === "LOW") worst = "LOW";
    else if (item.confidence === "MEDIUM" && worst === "HIGH") worst = "MEDIUM";
  }
  return sawAny ? worst : "UNKNOWN";
}
