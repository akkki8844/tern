import type { BreakingChange, BreakingChangeType } from "@tern/shared";
import type { MigrationInstruction } from "../interfaces.js";
import type { ApiChange, Confidence, RenameCandidate } from "./changes.js";
import type { SpecChangeAnalysis } from "./engine.js";
import type { RuleId } from "./rules.js";

/**
 * Bridge from the semantic change model to the legacy `BreakingChange` shape.
 *
 * The scanner and migration engine still consume the older, flatter representation.
 * Rather than freezing the new model to fit it, the richer report is the source of
 * truth and this adapter projects it down. Two deliberate decisions:
 *
 *  1. `NON_BREAKING` changes are dropped. The old engine emitted them (every added
 *     endpoint, every added enum value) and the scanner then hunted for usages that
 *     could not possibly need migrating. Filtering them out is a precision win.
 *  2. A property removal plus addition that the report identifies as a rename
 *     candidate is projected as a single `*-field-renamed` change carrying explicit
 *     mappings, because that is the actionable migration. The authoritative
 *     classification — a removal and an addition — remains in the full report.
 */

const CONFIDENCE_SCORE: Record<Confidence, number> = {
  HIGH: 0.95,
  MEDIUM: 0.7,
  LOW: 0.4,
  UNKNOWN: 0.1
};

const RULE_TO_LEGACY_TYPE: Partial<Record<RuleId, BreakingChangeType>> = {
  PATH_REMOVED: "endpoint-removed",
  OPERATION_REMOVED: "endpoint-removed",
  OPERATION_ID_CHANGED: "operation-id-removed",
  OPERATION_ID_REMOVED: "operation-id-removed",
  OPERATION_ID_ADDED: "operation-id-removed",
  PARAMETER_REMOVED: "required-parameter-removed",
  PARAMETER_MADE_OPTIONAL: "required-parameter-removed",
  REQUIRED_PARAMETER_ADDED: "required-parameter-added",
  PARAMETER_MADE_REQUIRED: "required-parameter-added",
  PARAMETER_LOCATION_CHANGED: "path-parameter-renamed",
  REQUIRED_REQUEST_BODY_ADDED: "required-parameter-added",
  REQUEST_BODY_MADE_REQUIRED: "required-parameter-added",
  REQUIRED_PROPERTY_ADDED: "required-parameter-added",
  PROPERTY_MADE_REQUIRED: "required-parameter-added",
  ENUM_VALUE_REMOVED: "enum-value-removed",
  ENUM_VALUE_ADDED: "enum-value-added",
  ENUM_CONSTRAINT_ADDED: "enum-value-removed",
  TYPE_CHANGED: "type-changed",
  TYPE_NARROWED: "type-changed",
  TYPE_WIDENED: "type-changed",
  FORMAT_CHANGED: "type-changed",
  FORMAT_ADDED: "type-changed",
  NULLABLE_ADDED: "type-changed",
  NULLABLE_REMOVED: "type-changed",
  SERVER_URL_CHANGED: "general",
  SERVER_REMOVED: "general"
};

export interface LegacyProjection {
  changes: BreakingChange[];
  instructions: MigrationInstruction[];
}

export function toLegacyChanges(analysis: SpecChangeAnalysis): LegacyProjection {
  const changes: BreakingChange[] = [];
  const instructions: MigrationInstruction[] = [];

  const renamesByLocation = indexRenames(analysis.renameCandidates);
  const consumed = new Set<string>();

  // Renames first, so the removals and additions they explain can be skipped.
  for (const rename of analysis.renameCandidates) {
    // An operationId change on a surviving operation is already reported by
    // OPERATION_ID_CHANGED, which carries the mapping. Only project the hypothesis
    // raised when the whole operation moved.
    if (rename.kind === "operationId" && renameAlreadyReported(analysis, rename)) continue;
    const type: BreakingChangeType =
      rename.kind === "operationId"
        ? "sdk-method-renamed"
        : rename.kind === "path"
          ? "endpoint-removed"
          : rename.kind === "parameter"
            ? "path-parameter-renamed"
            : rename.direction === "response"
              ? "response-field-renamed"
              : "request-field-renamed";

    const description = `${capitalize(rename.direction)} ${rename.kind} ${rename.from} renamed to ${rename.to} in ${describeOperation(rename.location)}`;
    push(
      changes,
      instructions,
      {
        id: `rename-${rename.from}-${rename.to}-${hash(rename.location.displayPath)}`,
        type,
        path: rename.location.path ?? rename.location.displayPath,
        method: rename.location.method,
        operationId: rename.location.operationId,
        description,
        severity: "risky",
        migrationHint: `Rename ${rename.from} to ${rename.to}.`
      },
      {
        changeType: type,
        path: rename.location.path ?? rename.location.displayPath,
        method: rename.location.method,
        operationId: rename.location.operationId,
        severity: "risky",
        description,
        action: `Rename ${rename.from} to ${rename.to}.`,
        mappings: [{ old: rename.from, new: rename.to, kind: renameMappingKind(rename.kind) }],
        confidence: CONFIDENCE_SCORE[rename.confidence],
        reasoning: rename.evidence.join("; ")
      }
    );

    consumed.add(renameKey(rename.location.displayPath, rename.from));
    consumed.add(renameKey(rename.location.displayPath, rename.to));
  }

  for (const change of analysis.changes) {
    if (change.severity === "NON_BREAKING") continue;

    const propertyName = change.location.propertyName;
    if (propertyName && consumed.has(renameKey(parentPath(change.location.displayPath), propertyName))) {
      continue;
    }

    const type = legacyTypeFor(change);
    const description = describeChange(change);
    const severity: "breaking" | "risky" = change.severity === "BREAKING" ? "breaking" : "risky";

    push(
      changes,
      instructions,
      {
        id: change.id,
        type,
        path: change.location.path ?? change.location.displayPath,
        method: change.location.method,
        operationId: change.location.operationId,
        description,
        severity,
        oldValue: change.oldValue,
        newValue: change.newValue,
        migrationHint: change.reason
      },
      {
        changeType: type,
        path: change.location.path ?? change.location.displayPath,
        method: change.location.method,
        operationId: change.location.operationId,
        severity,
        description,
        action: change.reason,
        mappings: mappingsFor(change, renamesByLocation),
        confidence: CONFIDENCE_SCORE[change.confidence],
        reasoning: `${change.rule}: ${change.reason}`
      }
    );
  }

  return { changes, instructions };
}

/** True when an OPERATION_ID_CHANGED change already carries this mapping. */
function renameAlreadyReported(analysis: SpecChangeAnalysis, rename: RenameCandidate): boolean {
  return analysis.changes.some(
    (change) =>
      change.rule === "OPERATION_ID_CHANGED" &&
      change.oldValue === rename.from &&
      change.newValue === rename.to
  );
}

function renameMappingKind(kind: RenameCandidate["kind"]): string {
  switch (kind) {
    case "parameter":
      return "pathParameter";
    case "path":
      return "endpoint";
    case "operationId":
      return "operationId";
    default:
      return "field";
  }
}

function legacyTypeFor(change: ApiChange): BreakingChangeType {
  const mapped = RULE_TO_LEGACY_TYPE[change.rule];
  if (mapped) return mapped;
  if (change.rule === "PROPERTY_REMOVED" || change.rule === "PROPERTY_REMOVED_FROM_CLOSED_OBJECT") {
    return change.direction === "response" ? "response-field-removed" : "request-field-removed";
  }
  return "general";
}

function mappingsFor(
  change: ApiChange,
  renamesByLocation: Map<string, RenameCandidate[]>
): Array<{ old: string; new: string; kind: string }> {
  switch (change.rule) {
    case "OPERATION_ID_CHANGED": {
      const renames = renamesByLocation.get(change.location.displayPath) ?? [];
      const rename = renames.find((r) => r.kind === "operationId");
      return rename ? [{ old: rename.from, new: rename.to, kind: "operationId" }] : [];
    }
    case "SERVER_URL_CHANGED":
      return [{ old: String(change.oldValue ?? ""), new: String(change.newValue ?? ""), kind: "server" }];
    case "PROPERTY_REMOVED":
    case "PROPERTY_REMOVED_FROM_CLOSED_OBJECT":
      return change.location.propertyName
        ? [{ old: change.location.propertyName, new: "", kind: "field" }]
        : [];
    case "REQUIRED_PROPERTY_ADDED":
    case "PROPERTY_MADE_REQUIRED":
      return change.location.propertyName ? [{ old: "", new: change.location.propertyName, kind: "field" }] : [];
    case "REQUIRED_PARAMETER_ADDED":
    case "PARAMETER_MADE_REQUIRED":
      return change.location.parameterName
        ? [{ old: "", new: change.location.parameterName, kind: "parameter" }]
        : [];
    case "PARAMETER_REMOVED":
      return change.location.parameterName
        ? [{ old: change.location.parameterName, new: "", kind: "parameter" }]
        : [];
    case "ENUM_VALUE_REMOVED":
      return [{ old: String(change.oldValue ?? ""), new: "", kind: "enum" }];
    default:
      return [];
  }
}

/**
 * One-line human description of a change. Used by the CLI-style report, the legacy
 * projection and the demo, so the wording stays consistent everywhere.
 */
export function describeChange(change: ApiChange): string {
  const where = describeOperation(change.location);
  const property = change.location.propertyName ?? change.location.propertyPath?.join(".");
  const direction = change.direction === "both" ? "" : `${change.direction} `;

  switch (change.rule) {
    case "PATH_REMOVED":
      return `Path ${change.location.path} removed`;
    case "PATH_ADDED":
      return `Path ${change.location.path} added`;
    case "OPERATION_REMOVED":
      return `Operation ${where} removed`;
    case "OPERATION_ADDED":
      return `Operation ${where} added`;
    case "OPERATION_ID_CHANGED":
      return `${where} operationId changed from ${change.oldValue} to ${change.newValue}`;
    case "OPERATION_ID_REMOVED":
      return `Operation ${change.oldValue} (${where}) no longer exists`;
    case "OPERATION_ID_ADDED":
      return `${where} gained the operationId ${change.newValue}`;
    case "OPERATION_DEPRECATED":
      return `Operation ${where} is deprecated`;
    case "COMPOSITION_MEMBER_ADDED":
      return `A ${String(change.metadata?.keyword ?? "union")} variant was added in ${where}`;
    case "COMPOSITION_MEMBER_REMOVED":
      return `A ${String(change.metadata?.keyword ?? "union")} variant was removed in ${where}`;
    case "SECURITY_REQUIREMENT_ADDED":
      return `${where} now requires authentication`;
    case "SECURITY_REQUIREMENT_REMOVED":
      return `${where} no longer requires authentication`;
    case "SECURITY_REQUIREMENT_CHANGED":
      return `Authentication requirements changed for ${where}`;
    case "REQUIRED_REQUEST_BODY_ADDED":
      return `${where} now requires a request body`;
    case "REQUEST_BODY_MADE_REQUIRED":
      return `The request body of ${where} became required`;
    case "REQUEST_MEDIA_TYPE_REMOVED":
      return `Request media type ${change.oldValue} removed from ${where}`;
    case "RESPONSE_MEDIA_TYPE_REMOVED":
      return `Response media type ${change.oldValue} removed from ${where}`;
    case "REQUIRED_PARAMETER_ADDED":
      return `Required parameter ${change.location.parameterName} added to ${where}`;
    case "OPTIONAL_PARAMETER_ADDED":
      return `Optional parameter ${change.location.parameterName} added to ${where}`;
    case "PARAMETER_REMOVED":
      return `Parameter ${change.location.parameterName} removed from ${where}`;
    case "PARAMETER_MADE_REQUIRED":
      return `Parameter ${change.location.parameterName} became required in ${where}`;
    case "PARAMETER_MADE_OPTIONAL":
      return `Parameter ${change.location.parameterName} became optional in ${where}`;
    case "PARAMETER_LOCATION_CHANGED":
      return `Parameter ${change.location.parameterName} moved from ${change.oldValue} to ${change.newValue} in ${where}`;
    case "PROPERTY_REMOVED":
    case "PROPERTY_REMOVED_FROM_CLOSED_OBJECT":
      return `${capitalize(direction)}field ${property} removed from ${where}`;
    case "PROPERTY_ADDED":
      return `Optional ${direction}field ${property} added to ${where}`;
    case "REQUIRED_PROPERTY_ADDED":
      return `Required ${direction}field ${property} added to ${where}`;
    case "PROPERTY_MADE_REQUIRED":
      return `${capitalize(direction)}field ${property} became required in ${where}`;
    case "PROPERTY_MADE_OPTIONAL":
      return `${capitalize(direction)}field ${property} became optional in ${where}`;
    case "ENUM_VALUE_REMOVED":
      return `Enum value ${JSON.stringify(change.oldValue)} removed from ${property ?? "value"} in ${direction}of ${where}`;
    case "ENUM_VALUE_ADDED":
      return `Enum value ${JSON.stringify(change.newValue)} added to ${property ?? "value"} in ${direction}of ${where}`;
    case "TYPE_CHANGED":
    case "TYPE_NARROWED":
    case "TYPE_WIDENED":
      return `${capitalize(direction)}${property ? `field ${property}` : "value"} type changed from ${format(change.oldValue)} to ${format(change.newValue)} in ${where}`;
    case "SUCCESS_RESPONSE_REMOVED":
    case "RESPONSE_REMOVED":
      return `Response ${change.location.statusCode} removed from ${where}`;
    case "RESPONSE_ADDED":
      return `Response ${change.location.statusCode} added to ${where}`;
    case "SERVER_URL_CHANGED":
      return `Server URL changed from ${change.oldValue} to ${change.newValue}`;
    case "COMPONENT_SCHEMA_REMOVED":
      return `Schema ${change.location.componentSchema} removed`;
    case "COMPONENT_SCHEMA_ADDED":
      return `Schema ${change.location.componentSchema} added`;
    default: {
      const rendered = `${format(change.oldValue)} -> ${format(change.newValue)}`;
      const subject = property ? `${property} ` : "";
      return `${change.rule.replace(/_/g, " ").toLowerCase()}: ${subject}${rendered} at ${change.location.displayPath}`;
    }
  }
}

function describeOperation(location: { method?: string; path?: string; displayPath: string }): string {
  if (location.method && location.path) return `${location.method.toUpperCase()} ${location.path}`;
  return location.displayPath;
}

function format(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join("|");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

function indexRenames(renames: readonly RenameCandidate[]): Map<string, RenameCandidate[]> {
  const map = new Map<string, RenameCandidate[]>();
  for (const rename of renames) {
    const list = map.get(rename.location.displayPath) ?? [];
    list.push(rename);
    map.set(rename.location.displayPath, list);
  }
  return map;
}

function renameKey(displayPath: string, property: string): string {
  return `${displayPath}\u0000${property}`;
}

function parentPath(displayPath: string): string {
  const index = displayPath.lastIndexOf(".");
  return index === -1 ? displayPath : displayPath.slice(0, index);
}

function push(
  changes: BreakingChange[],
  instructions: MigrationInstruction[],
  change: BreakingChange,
  instruction: MigrationInstruction
): void {
  changes.push(change);
  instructions.push(instruction);
}

/** Small stable hash, used only to keep synthesised legacy ids unique. */
function hash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
