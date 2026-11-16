import type { Confidence, Direction } from "./changes.js";
import type { RuleId } from "./rules.js";
import type { SchemaId, SchemaNode, SchemaRegistry } from "../model/canonical.js";
import { canonicalJson } from "../model/build.js";
import {
  additionalPropertiesMode,
  compareItemsRange,
  compareLengthRange,
  compareNumericRange,
  compareTypeSets,
  enumDelta
} from "./compat.js";
import type { Budget } from "../limits.js";

/** A change found inside a schema, addressed relative to the compared root. */
export interface SchemaFinding {
  readonly rule: RuleId;
  /** Property names from the compared root down to the change. `[]` is the root. */
  readonly propertyPath: readonly string[];
  readonly propertyName?: string;
  readonly oldValue?: unknown;
  readonly newValue?: unknown;
  readonly metadata?: Record<string, unknown>;
  /** Set when the concrete situation warrants less confidence than the rule's default. */
  readonly confidenceOverride?: Confidence;
}

export interface SchemaRenameFinding {
  readonly from: string;
  readonly to: string;
  readonly propertyPath: readonly string[];
  readonly evidence: readonly string[];
  readonly confidence: Confidence;
}

export interface SchemaDiffResult {
  readonly findings: readonly SchemaFinding[];
  readonly renames: readonly SchemaRenameFinding[];
}

const EMPTY: SchemaDiffResult = { findings: [], renames: [] };

/** A flattened, allOf-merged view of an object schema. */
interface ObjectView {
  properties: Map<string, SchemaId>;
  required: Set<string>;
  additionalProperties: boolean | SchemaId | undefined;
  /** False when allOf members could not be merged safely. */
  mergeable: boolean;
}

/**
 * Direction-aware, cycle-safe recursive schema comparison.
 *
 * ## Termination
 *
 * Schemas form a graph, not a tree: `Node.children: Node[]` is finite in the document
 * but infinite if expanded. The comparison walks *pairs* of schema ids and memoises
 * them. Re-entering a pair that is already being compared returns "no findings",
 * which is the standard coinductive treatment of equirecursive types: the pair is
 * assumed compatible unless some finite unrolling proves otherwise. Because the
 * assumption is the greatest fixed point, memoising the result is sound, and the
 * number of distinct pairs is bounded by |old schemas| × |new schemas|.
 *
 * ## Why one differ per direction
 *
 * The same schema pair produces different verdicts depending on whether the data
 * flows into a request or out of a response, so a differ is bound to one direction
 * and its cache is never shared across directions.
 */
export class SchemaDiffer {
  private readonly cache = new Map<string, SchemaDiffResult>();
  private readonly active = new Set<string>();
  private readonly signatures = new Map<string, string>();

  constructor(
    private readonly oldRegistry: SchemaRegistry,
    private readonly newRegistry: SchemaRegistry,
    private readonly direction: Direction,
    private readonly comparisons: Budget
  ) {}

  compare(oldId: SchemaId | undefined, newId: SchemaId | undefined): SchemaDiffResult {
    if (oldId === undefined || newId === undefined) return EMPTY;
    const key = `${oldId}\u0000${newId}`;

    const cached = this.cache.get(key);
    if (cached) return cached;
    if (this.active.has(key)) return EMPTY;

    this.comparisons.spend();
    this.active.add(key);
    try {
      const result = this.compareNodes(oldId, newId);
      this.cache.set(key, result);
      return result;
    } finally {
      this.active.delete(key);
    }
  }

  private compareNodes(oldId: SchemaId, newId: SchemaId): SchemaDiffResult {
    const previous = this.oldRegistry.get(oldId);
    const next = this.newRegistry.get(newId);
    if (!previous || !next) return EMPTY;

    const findings: SchemaFinding[] = [];
    const renames: SchemaRenameFinding[] = [];

    // --- constructs Tern cannot analyse -----------------------------------
    if (previous.origin.kind === "external" || next.origin.kind === "external") {
      const oldRef = previous.origin.kind === "external" ? previous.origin.ref : null;
      const newRef = next.origin.kind === "external" ? next.origin.ref : null;
      if (oldRef !== newRef) {
        findings.push({ rule: "EXTERNAL_REFERENCE_CHANGED", propertyPath: [], oldValue: oldRef, newValue: newRef });
      }
      return { findings, renames };
    }

    if (previous.unsupportedSignature !== next.unsupportedSignature) {
      findings.push({
        rule: "UNSUPPORTED_CONSTRUCT_CHANGED",
        propertyPath: [],
        oldValue: previous.unsupported.length > 0 ? [...previous.unsupported] : null,
        newValue: next.unsupported.length > 0 ? [...next.unsupported] : null,
        metadata: { keywords: [...new Set([...previous.unsupported, ...next.unsupported])].sort() }
      });
    }

    this.compareScalars(previous, next, findings);
    this.compareEnum(previous, next, findings);
    this.compareConstraints(previous, next, findings);
    this.compareComposition(previous, next, findings);
    this.compareObject(previous, next, findings, renames);

    if (previous.items !== undefined || next.items !== undefined) {
      const nested = this.compare(previous.items, next.items);
      pushNested(findings, renames, nested, "[]");
    }

    return { findings, renames };
  }

  // -------------------------------------------------------------------------

  private compareScalars(previous: SchemaNode, next: SchemaNode, findings: SchemaFinding[]): void {
    const relation = compareTypeSets(previous.types, next.types);
    if (relation === "changed") {
      findings.push({
        rule: "TYPE_CHANGED",
        propertyPath: [],
        oldValue: [...previous.types],
        newValue: [...next.types]
      });
    } else if (relation === "narrowed") {
      findings.push({
        rule: "TYPE_NARROWED",
        propertyPath: [],
        oldValue: previous.types.length ? [...previous.types] : null,
        newValue: [...next.types]
      });
    } else if (relation === "widened") {
      findings.push({
        rule: "TYPE_WIDENED",
        propertyPath: [],
        oldValue: [...previous.types],
        newValue: next.types.length ? [...next.types] : null
      });
    }

    if (previous.nullable !== next.nullable) {
      findings.push({
        rule: next.nullable ? "NULLABLE_ADDED" : "NULLABLE_REMOVED",
        propertyPath: [],
        oldValue: previous.nullable,
        newValue: next.nullable
      });
    }

    if (previous.format !== next.format) {
      const rule: RuleId =
        previous.format === undefined ? "FORMAT_ADDED" : next.format === undefined ? "FORMAT_REMOVED" : "FORMAT_CHANGED";
      findings.push({ rule, propertyPath: [], oldValue: previous.format ?? null, newValue: next.format ?? null });
    }

    if (previous.readOnly !== next.readOnly) {
      findings.push({
        rule: next.readOnly ? "READ_ONLY_ADDED" : "READ_ONLY_REMOVED",
        propertyPath: [],
        oldValue: previous.readOnly,
        newValue: next.readOnly
      });
    }

    if (previous.writeOnly !== next.writeOnly) {
      findings.push({
        rule: next.writeOnly ? "WRITE_ONLY_ADDED" : "WRITE_ONLY_REMOVED",
        propertyPath: [],
        oldValue: previous.writeOnly,
        newValue: next.writeOnly
      });
    }

    const oldDefault = previous.default ? canonicalJson(previous.default.value) : undefined;
    const newDefault = next.default ? canonicalJson(next.default.value) : undefined;
    if (oldDefault !== newDefault) {
      findings.push({
        rule: "DEFAULT_CHANGED",
        propertyPath: [],
        oldValue: previous.default?.value ?? null,
        newValue: next.default?.value ?? null
      });
    }
  }

  private compareEnum(previous: SchemaNode, next: SchemaNode, findings: SchemaFinding[]): void {
    const oldEnum = previous.enum;
    const newEnum = next.enum;
    if (!oldEnum && !newEnum) return;

    if (!oldEnum && newEnum) {
      findings.push({ rule: "ENUM_CONSTRAINT_ADDED", propertyPath: [], oldValue: null, newValue: [...newEnum] });
      return;
    }
    if (oldEnum && !newEnum) {
      findings.push({ rule: "ENUM_CONSTRAINT_REMOVED", propertyPath: [], oldValue: [...oldEnum], newValue: null });
      return;
    }

    const { removed, added } = enumDelta(oldEnum!, newEnum!);
    // One change per value: a migration needs to act on individual values, and a
    // single lumped change would make that information impossible to recover.
    for (const value of removed) {
      findings.push({ rule: "ENUM_VALUE_REMOVED", propertyPath: [], oldValue: value, newValue: null });
    }
    for (const value of added) {
      findings.push({ rule: "ENUM_VALUE_ADDED", propertyPath: [], oldValue: null, newValue: value });
    }
  }

  private compareConstraints(previous: SchemaNode, next: SchemaNode, findings: SchemaFinding[]): void {
    const numeric = compareNumericRange(previous.numeric, next.numeric);
    if (numeric.narrowed) {
      findings.push({
        rule: "NUMERIC_RANGE_NARROWED",
        propertyPath: [],
        oldValue: previous.numeric,
        newValue: next.numeric
      });
    }
    if (numeric.widened) {
      findings.push({
        rule: "NUMERIC_RANGE_WIDENED",
        propertyPath: [],
        oldValue: previous.numeric,
        newValue: next.numeric
      });
    }

    const length = compareLengthRange(previous.string, next.string);
    if (length.narrowed) {
      findings.push({
        rule: "LENGTH_RANGE_NARROWED",
        propertyPath: [],
        oldValue: { minLength: previous.string.minLength, maxLength: previous.string.maxLength },
        newValue: { minLength: next.string.minLength, maxLength: next.string.maxLength }
      });
    }
    if (length.widened) {
      findings.push({
        rule: "LENGTH_RANGE_WIDENED",
        propertyPath: [],
        oldValue: { minLength: previous.string.minLength, maxLength: previous.string.maxLength },
        newValue: { minLength: next.string.minLength, maxLength: next.string.maxLength }
      });
    }

    if (previous.string.pattern !== next.string.pattern) {
      const rule: RuleId =
        previous.string.pattern === undefined
          ? "PATTERN_ADDED"
          : next.string.pattern === undefined
            ? "PATTERN_REMOVED"
            : "PATTERN_CHANGED";
      findings.push({
        rule,
        propertyPath: [],
        oldValue: previous.string.pattern ?? null,
        newValue: next.string.pattern ?? null
      });
    }

    const items = compareItemsRange(previous.array, next.array);
    if (items.narrowed) {
      findings.push({ rule: "ITEMS_RANGE_NARROWED", propertyPath: [], oldValue: previous.array, newValue: next.array });
    }
    if (items.widened) {
      findings.push({ rule: "ITEMS_RANGE_WIDENED", propertyPath: [], oldValue: previous.array, newValue: next.array });
    }
  }

  private compareComposition(previous: SchemaNode, next: SchemaNode, findings: SchemaFinding[]): void {
    const oldKeywords = presentKeywords(previous);
    const newKeywords = presentKeywords(next);

    // Switching between oneOf, anyOf and allOf changes the meaning of the schema
    // wholesale. That is one semantic change, not one per keyword.
    if (oldKeywords.join(",") !== newKeywords.join(",")) {
      findings.push({
        rule: "COMPOSITION_KEYWORD_CHANGED",
        propertyPath: [],
        oldValue: oldKeywords.length > 0 ? oldKeywords : null,
        newValue: newKeywords.length > 0 ? newKeywords : null
      });
      return;
    }

    for (const keyword of ["oneOf", "anyOf"] as const) {
      const oldMembers = previous[keyword];
      const newMembers = next[keyword];
      if (!oldMembers || !newMembers) continue;

      const matched = this.matchMembers(oldMembers, newMembers);
      for (const removed of matched.removed) {
        findings.push({
          rule: "COMPOSITION_MEMBER_REMOVED",
          propertyPath: [],
          oldValue: describeMember(this.oldRegistry, removed),
          newValue: null,
          metadata: { keyword }
        });
      }
      for (const added of matched.added) {
        findings.push({
          rule: "COMPOSITION_MEMBER_ADDED",
          propertyPath: [],
          oldValue: null,
          newValue: describeMember(this.newRegistry, added),
          metadata: { keyword }
        });
      }
      matched.pairs.forEach(([oldMember, newMember], index) => {
        const nested = this.compare(oldMember, newMember);
        const localRenames: SchemaRenameFinding[] = [];
        pushNested(findings, localRenames, nested, `${keyword}[${index}]`);
      });
    }
  }

  private compareObject(
    previous: SchemaNode,
    next: SchemaNode,
    findings: SchemaFinding[],
    renames: SchemaRenameFinding[]
  ): void {
    const oldView = this.objectView(this.oldRegistry, previous);
    const newView = this.objectView(this.newRegistry, next);

    // allOf that could not be merged is reported structurally instead of being
    // silently treated as an object.
    if (!oldView.mergeable || !newView.mergeable) {
      const oldCount = previous.allOf?.length ?? 0;
      const newCount = next.allOf?.length ?? 0;
      if (newCount > oldCount) {
        findings.push({ rule: "ALL_OF_MEMBER_ADDED", propertyPath: [], oldValue: oldCount, newValue: newCount });
      } else if (newCount < oldCount) {
        findings.push({ rule: "ALL_OF_MEMBER_REMOVED", propertyPath: [], oldValue: oldCount, newValue: newCount });
      }
    }

    const oldClosed = additionalPropertiesMode(oldView.additionalProperties) === "closed";
    const newClosed = additionalPropertiesMode(newView.additionalProperties) === "closed";
    if (oldClosed !== newClosed) {
      findings.push({
        rule: newClosed ? "ADDITIONAL_PROPERTIES_RESTRICTED" : "ADDITIONAL_PROPERTIES_RELAXED",
        propertyPath: [],
        oldValue: normalizeAdditional(oldView.additionalProperties),
        newValue: normalizeAdditional(newView.additionalProperties)
      });
    }
    if (typeof oldView.additionalProperties === "string" && typeof newView.additionalProperties === "string") {
      const nested = this.compare(oldView.additionalProperties, newView.additionalProperties);
      pushNested(findings, renames, nested, "additionalProperties");
    }

    const removedNames: string[] = [];
    const addedNames: string[] = [];

    for (const [name, oldPropertyId] of oldView.properties) {
      const newPropertyId = newView.properties.get(name);
      if (newPropertyId === undefined) {
        removedNames.push(name);
        const closedForRequests = newClosed && this.direction === "request";
        findings.push({
          rule: closedForRequests ? "PROPERTY_REMOVED_FROM_CLOSED_OBJECT" : "PROPERTY_REMOVED",
          propertyPath: [name],
          propertyName: name,
          oldValue: summarizeSchema(this.oldRegistry, oldPropertyId),
          newValue: null,
          metadata: { wasRequired: oldView.required.has(name) }
        });
        continue;
      }

      const wasRequired = oldView.required.has(name);
      const isRequired = newView.required.has(name);
      if (!wasRequired && isRequired) {
        findings.push({
          rule: "PROPERTY_MADE_REQUIRED",
          propertyPath: [name],
          propertyName: name,
          oldValue: false,
          newValue: true
        });
      } else if (wasRequired && !isRequired) {
        findings.push({
          rule: "PROPERTY_MADE_OPTIONAL",
          propertyPath: [name],
          propertyName: name,
          oldValue: true,
          newValue: false
        });
      }

      const nested = this.compare(oldPropertyId, newPropertyId);
      pushNested(findings, renames, nested, name);
    }

    for (const [name, newPropertyId] of newView.properties) {
      if (oldView.properties.has(name)) continue;
      addedNames.push(name);
      const isRequired = newView.required.has(name);
      findings.push({
        rule: isRequired ? "REQUIRED_PROPERTY_ADDED" : "PROPERTY_ADDED",
        propertyPath: [name],
        propertyName: name,
        oldValue: null,
        newValue: summarizeSchema(this.newRegistry, newPropertyId),
        metadata: { required: isRequired }
      });
    }

    renames.push(...this.detectRenames(removedNames, addedNames, oldView, newView));
  }

  /**
   * Propose rename hypotheses from *structural* evidence only.
   *
   * This never influences a breaking-change classification: a rename is always also
   * reported as a removal plus an addition, and those are what the severity comes
   * from. Name similarity is deliberately not used as evidence — `emailAddress` and
   * `emailVerified` look alike and are unrelated, while `source` and
   * `payment_method` look unrelated and are the same field.
   */
  private detectRenames(
    removedNames: readonly string[],
    addedNames: readonly string[],
    oldView: ObjectView,
    newView: ObjectView
  ): SchemaRenameFinding[] {
    if (removedNames.length === 0 || addedNames.length === 0) return [];
    const renames: SchemaRenameFinding[] = [];
    const availableAdded = new Set(addedNames);

    // Evidence 1: both sides point at the same named component schema.
    for (const removed of removedNames) {
      const oldId = oldView.properties.get(removed)!;
      const oldNode = this.oldRegistry.get(oldId);
      if (oldNode?.origin.kind !== "component") continue;
      const componentName = oldNode.origin.name;

      const matches = [...availableAdded].filter((added) => {
        const newNode = this.newRegistry.get(newView.properties.get(added)!);
        return newNode?.origin.kind === "component" && newNode.origin.name === componentName;
      });
      if (matches.length === 1) {
        availableAdded.delete(matches[0]);
        renames.push({
          from: removed,
          to: matches[0],
          propertyPath: [],
          confidence: "MEDIUM",
          evidence: [`both properties reference the same component schema "${componentName}"`]
        });
      }
    }

    // Evidence 2: exactly one property left on each side, and they are structurally
    // identical. One-in, one-out with an identical shape is meaningful; anything
    // more ambiguous is left alone.
    const remainingRemoved = removedNames.filter((name) => !renames.some((r) => r.from === name));
    if (remainingRemoved.length === 1 && availableAdded.size === 1) {
      const from = remainingRemoved[0];
      const to = [...availableAdded][0];
      const oldSignature = this.signature(this.oldRegistry, oldView.properties.get(from)!, 0);
      const newSignature = this.signature(this.newRegistry, newView.properties.get(to)!, 0);
      if (oldSignature === newSignature) {
        renames.push({
          from,
          to,
          propertyPath: [],
          confidence: "LOW",
          evidence: [
            "exactly one property was removed and one added in the same object",
            "the two property schemas are structurally identical"
          ]
        });
      }
    }

    return renames;
  }

  // -------------------------------------------------------------------------

  /**
   * Flatten a schema into a single object view, merging `allOf` when every member is
   * a plain object contribution. Inheritance expressed with allOf is extremely common
   * and treating it opaquely would miss most real property changes.
   */
  private objectView(registry: SchemaRegistry, node: SchemaNode, depth = 0): ObjectView {
    const view: ObjectView = {
      properties: new Map(node.properties),
      required: new Set(node.required),
      additionalProperties: node.additionalProperties,
      mergeable: true
    };

    if (!node.allOf || node.allOf.length === 0 || depth > 16) return view;

    for (const memberId of node.allOf) {
      const member = registry.get(memberId);
      if (!member || !isMergeableMember(member)) {
        view.mergeable = false;
        continue;
      }
      const memberView = this.objectView(registry, member, depth + 1);
      if (!memberView.mergeable) view.mergeable = false;
      for (const [name, id] of memberView.properties) {
        if (!view.properties.has(name)) view.properties.set(name, id);
      }
      for (const name of memberView.required) view.required.add(name);
      if (additionalPropertiesMode(memberView.additionalProperties) === "closed") {
        view.additionalProperties = false;
      }
    }

    return view;
  }

  private matchMembers(
    oldMembers: readonly SchemaId[],
    newMembers: readonly SchemaId[]
  ): { pairs: [SchemaId, SchemaId][]; removed: SchemaId[]; added: SchemaId[] } {
    const pairs: [SchemaId, SchemaId][] = [];
    const remainingNew = [...newMembers];
    const removed: SchemaId[] = [];

    for (const oldMember of oldMembers) {
      // Prefer an identical id: a `$ref` to the same component is unambiguous.
      const exact = remainingNew.indexOf(oldMember);
      if (exact !== -1) {
        pairs.push([oldMember, remainingNew[exact]]);
        remainingNew.splice(exact, 1);
        continue;
      }
      removed.push(oldMember);
    }

    // Any leftover old members pair positionally with leftover new members, which is
    // the only deterministic option for inline union variants.
    const added: SchemaId[] = [];
    while (removed.length > 0 && remainingNew.length > 0) {
      pairs.push([removed.shift()!, remainingNew.shift()!]);
    }
    added.push(...remainingNew);

    return { pairs, removed, added };
  }

  /** Structural fingerprint used only as rename evidence. */
  private signature(registry: SchemaRegistry, id: SchemaId, depth: number): string {
    const cacheKey = `${registry === this.oldRegistry ? "o" : "n"}\u0000${id}`;
    const cached = this.signatures.get(cacheKey);
    if (cached) return cached;
    if (depth > 8) return "<deep>";

    const node = registry.get(id);
    if (!node) return "<missing>";

    // Placeholder first so a recursive schema terminates.
    this.signatures.set(cacheKey, "<recursive>");
    const parts = {
      types: node.types,
      nullable: node.nullable,
      format: node.format ?? null,
      enum: node.enum ?? null,
      required: [...node.required].sort(),
      numeric: node.numeric,
      string: node.string,
      array: node.array,
      properties: [...node.properties.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, child]) => [name, this.signature(registry, child, depth + 1)]),
      items: node.items ? this.signature(registry, node.items, depth + 1) : null
    };
    const signature = canonicalJson(parts);
    this.signatures.set(cacheKey, signature);
    return signature;
  }
}

// ---------------------------------------------------------------------------

/** Which composition keywords a schema actually uses, in a stable order. */
function presentKeywords(node: SchemaNode): string[] {
  const keywords: string[] = [];
  if (node.allOf) keywords.push("allOf");
  if (node.anyOf) keywords.push("anyOf");
  if (node.oneOf) keywords.push("oneOf");
  return keywords;
}

function isMergeableMember(member: SchemaNode): boolean {
  return (
    member.oneOf === undefined &&
    member.anyOf === undefined &&
    member.enum === undefined &&
    member.unsupported.length === 0 &&
    member.origin.kind !== "external"
  );
}

function pushNested(
  findings: SchemaFinding[],
  renames: SchemaRenameFinding[],
  nested: SchemaDiffResult,
  segment: string
): void {
  for (const finding of nested.findings) {
    findings.push({ ...finding, propertyPath: [segment, ...finding.propertyPath] });
  }
  for (const rename of nested.renames) {
    renames.push({ ...rename, propertyPath: [segment, ...rename.propertyPath] });
  }
}

function normalizeAdditional(value: boolean | SchemaId | undefined): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value;
  return { schema: value };
}

function describeMember(registry: SchemaRegistry, id: SchemaId): unknown {
  const node = registry.get(id);
  if (!node) return { ref: id };
  if (node.origin.kind === "component") return { component: node.origin.name };
  return { types: [...node.types] };
}

/** Compact description of a schema, used as the old/new value of presence changes. */
function summarizeSchema(registry: SchemaRegistry, id: SchemaId): unknown {
  const node = registry.get(id);
  if (!node) return null;
  const summary: Record<string, unknown> = {};
  if (node.origin.kind === "component") summary.component = node.origin.name;
  if (node.types.length > 0) summary.type = node.types.length === 1 ? node.types[0] : [...node.types];
  if (node.nullable) summary.nullable = true;
  if (node.format) summary.format = node.format;
  if (node.enum) summary.enum = [...node.enum];
  return summary;
}
