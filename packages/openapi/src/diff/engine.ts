import { OpenAPIError } from "@capibara/shared";
import type { OpenApiDocument } from "../interfaces.js";
import { Budget, DEFAULT_LIMITS, type AnalysisLimits } from "../limits.js";
import { buildApiModel, type BuiltModel } from "../model/build.js";
import type {
  ApiMediaType,
  ApiOperation,
  ApiParameter,
  Direction,
  SchemaId,
  SchemaRegistry
} from "../model/canonical.js";
import {
  compareChanges,
  computeChangeId,
  summarize,
  type ApiChange,
  type ChangeLocation,
  type Confidence,
  type RenameCandidate,
  type SpecChangeReport,
  type UnsupportedNote
} from "./changes.js";
import { RULE_CATALOG, severityFor, type RuleId } from "./rules.js";
import { SchemaDiffer, type SchemaFinding, type SchemaRenameFinding } from "./schema-diff.js";

export interface DiffOptions {
  limits?: AnalysisLimits;
}

/** Which operations use a component schema, and in which compatibility direction. */
export interface ComponentUsage {
  readonly component: string;
  readonly changed: boolean;
  readonly usedBy: readonly {
    readonly operationKey: string;
    readonly operationId?: string;
    readonly direction: Direction;
    readonly displayPath: string;
  }[];
}

export interface SpecChangeAnalysis extends SpecChangeReport {
  /**
   * Component-level impact.
   *
   * Answers "the `User` schema changed — which operations does that touch, and is it
   * a request or a response there?" without collapsing distinct usages into one
   * finding.
   */
  readonly componentUsage: readonly ComponentUsage[];
}

/**
 * Semantic diff between two OpenAPI documents.
 *
 * The engine is a pure function of its two inputs: no clock, no randomness, no
 * network, no LLM. Running it twice on the same pair produces byte-identical output,
 * which is what makes precision and recall measurable over a benchmark corpus.
 */
export function analyzeSpecChange(
  oldDocument: OpenApiDocument,
  newDocument: OpenApiDocument,
  options: DiffOptions = {}
): SpecChangeAnalysis {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const oldModel = buildApiModel(oldDocument, { limits });
  const newModel = buildApiModel(newDocument, { limits });
  return new SemanticDiff(oldModel, newModel, limits).run();
}

/** Compare two already-built models (used when the caller has cached them). */
export function analyzeModelChange(
  oldModel: BuiltModel,
  newModel: BuiltModel,
  options: DiffOptions = {}
): SpecChangeAnalysis {
  return new SemanticDiff(oldModel, newModel, options.limits ?? DEFAULT_LIMITS).run();
}

class SemanticDiff {
  private readonly changes: ApiChange[] = [];
  private readonly renames: RenameCandidate[] = [];
  private readonly changeBudget: Budget;
  private readonly comparisonBudget: Budget;
  private readonly differs = new Map<Direction, SchemaDiffer>();
  private readonly componentUsage = new Map<string, ComponentUsage["usedBy"][number][]>();
  private readonly reachableCache = new Map<string, Set<string>>();

  constructor(
    private readonly oldModel: BuiltModel,
    private readonly newModel: BuiltModel,
    private readonly limits: AnalysisLimits
  ) {
    this.changeBudget = new Budget(limits.maxChanges, "change", "OPENAPI_TOO_MANY_CHANGES");
    this.comparisonBudget = new Budget(limits.maxComparisons, "schema comparison", "OPENAPI_DIFF_TOO_COMPLEX");
  }

  run(): SpecChangeAnalysis {
    this.diffServers();
    this.diffOperations();
    const componentUsage = this.diffComponents();

    const changes = [...this.changes].sort(compareChanges);
    const unsupported = mergeUnsupported(this.oldModel, this.newModel);

    return {
      oldVersion: this.oldModel.version,
      newVersion: this.newModel.version,
      oldOpenApiVersion: this.oldModel.openapiVersion,
      newOpenApiVersion: this.newModel.openapiVersion,
      changes,
      renameCandidates: [...this.renames].sort((a, b) =>
        a.location.displayPath === b.location.displayPath
          ? a.from < b.from
            ? -1
            : 1
          : a.location.displayPath < b.location.displayPath
            ? -1
            : 1
      ),
      unsupported,
      summary: summarize(changes),
      componentUsage
    };
  }

  // -------------------------------------------------------------------------
  // Document level
  // -------------------------------------------------------------------------

  private diffServers(): void {
    const oldServers = this.oldModel.serverUrls;
    const newServers = this.newModel.serverUrls;
    if (canonical(oldServers) === canonical(newServers)) return;

    const removed = oldServers.filter((url) => !newServers.includes(url));
    const added = newServers.filter((url) => !oldServers.includes(url));

    // One server replaced by exactly one other is the common "v1 -> v2" case and is
    // reported as a single, actionable change rather than a removal plus an addition.
    if (removed.length === 1 && added.length === 1 && oldServers.length === newServers.length) {
      this.emit("SERVER_URL_CHANGED", { displayPath: "servers" }, "both", removed[0], added[0]);
      return;
    }
    for (const url of removed) this.emit("SERVER_REMOVED", { displayPath: "servers" }, "both", url, null);
    for (const url of added) this.emit("SERVER_ADDED", { displayPath: "servers" }, "both", null, url);
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  private diffOperations(): void {
    const oldOps = new Map(this.oldModel.operations.map((op) => [op.key, op]));
    const newOps = new Map(this.newModel.operations.map((op) => [op.key, op]));
    const oldPaths = new Set(this.oldModel.operations.map((op) => op.path));
    const newPaths = new Set(this.newModel.operations.map((op) => op.path));

    for (const path of [...oldPaths].sort()) {
      if (!newPaths.has(path)) {
        this.emit("PATH_REMOVED", { displayPath: `paths.${path}`, path }, "both", path, null);
      }
    }
    for (const path of [...newPaths].sort()) {
      if (!oldPaths.has(path)) {
        this.emit("PATH_ADDED", { displayPath: `paths.${path}`, path }, "both", null, path);
      }
    }

    this.proposePathRename(oldPaths, newPaths, oldOps, newOps);
    this.diffVanishedOperationIds(oldOps, newOps);

    for (const [key, oldOp] of [...oldOps].sort(byKey)) {
      const newOp = newOps.get(key);
      if (!newOp) {
        // A removed operation on a removed path is already covered by PATH_REMOVED.
        if (newPaths.has(oldOp.path)) {
          this.emit("OPERATION_REMOVED", locationOf(oldOp), "both", key, null);
        }
        continue;
      }
      this.diffOperation(oldOp, newOp);
    }

    for (const [key, newOp] of [...newOps].sort(byKey)) {
      if (oldOps.has(key)) continue;
      if (oldPaths.has(newOp.path)) {
        this.emit("OPERATION_ADDED", locationOf(newOp), "both", null, key);
      }
    }
  }

  /**
   * Report operationIds that disappeared along with their operation.
   *
   * `PATH_REMOVED` already says the endpoint is gone, but a generated client also
   * loses a *named method*, and that is what a repository actually references. The id
   * is therefore tracked as its own client-visible symbol.
   */
  private diffVanishedOperationIds(
    oldOps: ReadonlyMap<string, ApiOperation>,
    newOps: ReadonlyMap<string, ApiOperation>
  ): void {
    const newIds = new Set(
      [...newOps.values()].map((op) => op.operationId).filter((id): id is string => id !== undefined)
    );
    const vanished = [...oldOps.values()].filter(
      (op) => op.operationId !== undefined && !newIds.has(op.operationId) && !newOps.has(op.key)
    );

    for (const operation of vanished) {
      this.emit("OPERATION_ID_REMOVED", locationOf(operation), "both", operation.operationId, null);
    }

    // Hypothesis: one method vanished and one appeared on the same HTTP verb.
    const oldIds = new Set(
      [...oldOps.values()].map((op) => op.operationId).filter((id): id is string => id !== undefined)
    );
    const appeared = [...newOps.values()].filter(
      (op) => op.operationId !== undefined && !oldIds.has(op.operationId) && !oldOps.has(op.key)
    );
    if (vanished.length !== 1 || appeared.length !== 1) return;
    if (vanished[0].method !== appeared[0].method) return;

    this.renames.push({
      kind: "operationId",
      from: vanished[0].operationId!,
      to: appeared[0].operationId!,
      location: locationOf(appeared[0]),
      direction: "both",
      confidence: "LOW",
      evidence: [
        "exactly one operationId disappeared and one appeared",
        `both operations use the ${vanished[0].method.toUpperCase()} method`
      ]
    });
  }

  /**
   * Propose that a removed path and an added path are the same endpoint moved.
   *
   * This is a hypothesis, never a classification: the authoritative changes remain
   * `PATH_REMOVED` and `PATH_ADDED`. The evidence is structural — exactly one path
   * disappeared, exactly one appeared, and both declare the same set of HTTP methods
   * — and never string similarity between the two paths.
   */
  private proposePathRename(
    oldPaths: ReadonlySet<string>,
    newPaths: ReadonlySet<string>,
    oldOps: ReadonlyMap<string, ApiOperation>,
    newOps: ReadonlyMap<string, ApiOperation>
  ): void {
    const removed = [...oldPaths].filter((path) => !newPaths.has(path));
    const added = [...newPaths].filter((path) => !oldPaths.has(path));
    if (removed.length !== 1 || added.length !== 1) return;

    const methodsOf = (operations: ReadonlyMap<string, ApiOperation>, path: string) =>
      [...operations.values()]
        .filter((op) => op.path === path)
        .map((op) => op.method)
        .sort()
        .join(",");

    const oldMethods = methodsOf(oldOps, removed[0]);
    const newMethods = methodsOf(newOps, added[0]);
    if (oldMethods === "" || oldMethods !== newMethods) return;

    this.renames.push({
      kind: "path",
      from: removed[0],
      to: added[0],
      location: { displayPath: `paths.${added[0]}`, path: added[0] },
      direction: "both",
      confidence: "LOW",
      evidence: [
        "exactly one path was removed and one added",
        `both declare the same methods (${oldMethods})`
      ]
    });
  }

  private diffOperation(oldOp: ApiOperation, newOp: ApiOperation): void {
    const base = locationOf(newOp);

    if (oldOp.operationId !== newOp.operationId) {
      if (oldOp.operationId && newOp.operationId) {
        this.emit("OPERATION_ID_CHANGED", base, "both", oldOp.operationId, newOp.operationId);
        this.renames.push({
          kind: "operationId",
          from: oldOp.operationId,
          to: newOp.operationId,
          location: base,
          direction: "both",
          confidence: "HIGH",
          evidence: ["the same path and method carries a different operationId"]
        });
      } else if (oldOp.operationId) {
        this.emit("OPERATION_ID_REMOVED", base, "both", oldOp.operationId, null);
      } else {
        this.emit("OPERATION_ID_ADDED", base, "both", null, newOp.operationId);
      }
    }

    if (!oldOp.deprecated && newOp.deprecated) {
      this.emit("OPERATION_DEPRECATED", base, "both", false, true);
    }

    this.diffSecurity(oldOp, newOp, base);
    this.diffParameters(oldOp, newOp, base);
    this.diffRequestBody(oldOp, newOp, base);
    this.diffResponses(oldOp, newOp, base);
  }

  private diffSecurity(oldOp: ApiOperation, newOp: ApiOperation, base: ChangeLocation): void {
    const oldSecurity = oldOp.security ?? [];
    const newSecurity = newOp.security ?? [];
    if (canonical(oldSecurity) === canonical(newSecurity)) return;

    const location = { ...base, displayPath: `${base.displayPath}.security` };
    if (oldSecurity.length === 0) {
      this.emit("SECURITY_REQUIREMENT_ADDED", location, "request", null, newSecurity);
    } else if (newSecurity.length === 0) {
      this.emit("SECURITY_REQUIREMENT_REMOVED", location, "request", oldSecurity, null);
    } else {
      this.emit("SECURITY_REQUIREMENT_CHANGED", location, "request", oldSecurity, newSecurity);
    }
  }

  private diffParameters(oldOp: ApiOperation, newOp: ApiOperation, base: ChangeLocation): void {
    const oldByName = groupByName(oldOp.parameters);
    const newByName = groupByName(newOp.parameters);
    const removed: ApiParameter[] = [];
    const added: ApiParameter[] = [];

    for (const name of [...oldByName.keys()].sort()) {
      const oldParams = oldByName.get(name)!;
      const newParams = newByName.get(name) ?? [];

      for (const oldParam of oldParams) {
        const exact = newParams.find((p) => p.in === oldParam.in);
        if (exact) {
          this.diffParameterPair(oldParam, exact, base);
          continue;
        }
        // Same name in a different location is a move, not a removal plus addition:
        // the caller still passes the value, just in the wrong place.
        const moved = newParams.find((p) => !oldParams.some((o) => o.in === p.in));
        if (moved) {
          this.emit(
            "PARAMETER_LOCATION_CHANGED",
            parameterLocation(base, oldParam),
            "request",
            oldParam.in,
            moved.in
          );
          this.diffParameterPair(oldParam, moved, base, /* skipLocation */ true);
          continue;
        }
        removed.push(oldParam);
        this.emit(
          "PARAMETER_REMOVED",
          parameterLocation(base, oldParam),
          "request",
          { name: oldParam.name, in: oldParam.in, required: oldParam.required },
          null
        );
      }
    }

    for (const name of [...newByName.keys()].sort()) {
      const newParams = newByName.get(name)!;
      const oldParams = oldByName.get(name) ?? [];
      for (const newParam of newParams) {
        if (oldParams.some((p) => p.in === newParam.in)) continue;
        // Already reported as a location change above.
        if (oldParams.length > 0) continue;
        added.push(newParam);
        this.emit(
          newParam.required ? "REQUIRED_PARAMETER_ADDED" : "OPTIONAL_PARAMETER_ADDED",
          parameterLocation(base, newParam),
          "request",
          null,
          { name: newParam.name, in: newParam.in, required: newParam.required }
        );
      }
    }

    this.proposeParameterRenames(removed, added, base);
  }

  private diffParameterPair(
    oldParam: ApiParameter,
    newParam: ApiParameter,
    base: ChangeLocation,
    skipLocation = false
  ): void {
    const location = parameterLocation(base, newParam);
    void skipLocation;

    if (!oldParam.required && newParam.required) {
      this.emit("PARAMETER_MADE_REQUIRED", { ...location, displayPath: `${location.displayPath}.required` }, "request", false, true);
    } else if (oldParam.required && !newParam.required) {
      this.emit("PARAMETER_MADE_OPTIONAL", { ...location, displayPath: `${location.displayPath}.required` }, "request", true, false);
    }

    if (!oldParam.deprecated && newParam.deprecated) {
      this.emit("PARAMETER_DEPRECATED", location, "request", false, true);
    }

    this.applySchemaFindings(oldParam.schema, newParam.schema, "request", {
      ...location,
      displayPath: `${location.displayPath}.schema`
    });
  }

  private proposeParameterRenames(
    removed: readonly ApiParameter[],
    added: readonly ApiParameter[],
    base: ChangeLocation
  ): void {
    if (removed.length !== 1 || added.length !== 1) return;
    const from = removed[0];
    const to = added[0];
    if (from.in !== to.in) return;
    this.renames.push({
      kind: "parameter",
      from: from.name,
      to: to.name,
      location: parameterLocation(base, to),
      direction: "request",
      confidence: "LOW",
      evidence: [
        `exactly one ${from.in} parameter was removed and one added on the same operation`,
        `both are in "${from.in}"`
      ]
    });
  }

  private diffRequestBody(oldOp: ApiOperation, newOp: ApiOperation, base: ChangeLocation): void {
    const oldBody = oldOp.requestBody;
    const newBody = newOp.requestBody;
    const location: ChangeLocation = { ...base, displayPath: `${base.displayPath}.requestBody` };

    if (!oldBody && !newBody) return;
    if (!oldBody && newBody) {
      this.emit(
        newBody.required ? "REQUIRED_REQUEST_BODY_ADDED" : "OPTIONAL_REQUEST_BODY_ADDED",
        location,
        "request",
        null,
        { required: newBody.required, mediaTypes: newBody.content.map((c) => c.mediaType) }
      );
      return;
    }
    if (oldBody && !newBody) {
      this.emit("REQUEST_BODY_REMOVED", location, "request", { required: oldBody.required }, null);
      return;
    }

    if (!oldBody!.required && newBody!.required) {
      this.emit("REQUEST_BODY_MADE_REQUIRED", location, "request", false, true);
    } else if (oldBody!.required && !newBody!.required) {
      this.emit("REQUEST_BODY_MADE_OPTIONAL", location, "request", true, false);
    }

    this.diffContent(oldBody!.content, newBody!.content, "request", location, {
      removed: "REQUEST_MEDIA_TYPE_REMOVED",
      added: "REQUEST_MEDIA_TYPE_ADDED"
    });
  }

  private diffResponses(oldOp: ApiOperation, newOp: ApiOperation, base: ChangeLocation): void {
    const oldResponses = new Map(oldOp.responses.map((r) => [r.statusCode, r]));
    const newResponses = new Map(newOp.responses.map((r) => [r.statusCode, r]));

    for (const statusCode of [...oldResponses.keys()].sort()) {
      const location: ChangeLocation = {
        ...base,
        statusCode,
        displayPath: `${base.displayPath}.responses.${statusCode}`
      };
      const newResponse = newResponses.get(statusCode);
      if (!newResponse) {
        this.emit(
          isSuccess(statusCode) ? "SUCCESS_RESPONSE_REMOVED" : "RESPONSE_REMOVED",
          location,
          "response",
          statusCode,
          null
        );
        continue;
      }
      this.diffContent(oldResponses.get(statusCode)!.content, newResponse.content, "response", location, {
        removed: "RESPONSE_MEDIA_TYPE_REMOVED",
        added: "RESPONSE_MEDIA_TYPE_ADDED"
      });
    }

    for (const statusCode of [...newResponses.keys()].sort()) {
      if (oldResponses.has(statusCode)) continue;
      this.emit(
        "RESPONSE_ADDED",
        { ...base, statusCode, displayPath: `${base.displayPath}.responses.${statusCode}` },
        "response",
        null,
        statusCode
      );
    }
  }

  private diffContent(
    oldContent: readonly ApiMediaType[],
    newContent: readonly ApiMediaType[],
    direction: Direction,
    base: ChangeLocation,
    rules: { removed: RuleId; added: RuleId }
  ): void {
    const oldByType = new Map(oldContent.map((c) => [c.mediaType, c]));
    const newByType = new Map(newContent.map((c) => [c.mediaType, c]));

    for (const mediaType of [...oldByType.keys()].sort()) {
      const location: ChangeLocation = {
        ...base,
        mediaType,
        displayPath: `${base.displayPath}.content.${mediaType}`
      };
      const newMedia = newByType.get(mediaType);
      if (!newMedia) {
        this.emit(rules.removed, location, direction, mediaType, null);
        continue;
      }
      const oldMedia = oldByType.get(mediaType)!;
      this.recordComponentUsage(oldMedia.schema, newMedia.schema, direction, base, location);
      this.applySchemaFindings(oldMedia.schema, newMedia.schema, direction, {
        ...location,
        displayPath: `${location.displayPath}.schema`
      });
    }

    for (const mediaType of [...newByType.keys()].sort()) {
      if (oldByType.has(mediaType)) continue;
      this.emit(
        rules.added,
        { ...base, mediaType, displayPath: `${base.displayPath}.content.${mediaType}` },
        direction,
        null,
        mediaType
      );
    }
  }

  // -------------------------------------------------------------------------
  // Components
  // -------------------------------------------------------------------------

  private diffComponents(): ComponentUsage[] {
    const oldComponents = this.oldModel.componentSchemas;
    const newComponents = this.newModel.componentSchemas;

    for (const name of [...oldComponents.keys()].sort()) {
      if (newComponents.has(name)) continue;
      this.emit(
        "COMPONENT_SCHEMA_REMOVED",
        { displayPath: `components.schemas.${name}`, componentSchema: name },
        "both",
        name,
        null
      );
    }
    for (const name of [...newComponents.keys()].sort()) {
      if (oldComponents.has(name)) continue;
      this.emit(
        "COMPONENT_SCHEMA_ADDED",
        { displayPath: `components.schemas.${name}`, componentSchema: name },
        "both",
        null,
        name
      );
    }

    const usage: ComponentUsage[] = [];
    for (const name of [...oldComponents.keys()].sort()) {
      const newId = newComponents.get(name);
      if (newId === undefined) continue;
      const oldId = oldComponents.get(name)!;

      const differ = this.differFor("both");
      const result = differ.compare(oldId, newId);
      const changed = result.findings.length > 0;
      const usedBy = this.componentUsage.get(name) ?? [];

      if (changed && usedBy.length === 0) {
        // Nothing references this schema, so no operation-level location exists. Report
        // it at the component itself rather than dropping the change.
        this.applyFindings(result.findings, result.renames, "both", {
          displayPath: `components.schemas.${name}`,
          componentSchema: name
        });
      }
      usage.push({ component: name, changed, usedBy });
    }
    return usage;
  }

  private recordComponentUsage(
    oldSchema: SchemaId | undefined,
    newSchema: SchemaId | undefined,
    direction: Direction,
    operationLocation: ChangeLocation,
    mediaLocation: ChangeLocation
  ): void {
    const components = new Set<string>([
      ...(oldSchema ? this.reachableComponents(this.oldModel.registry, oldSchema, "old") : []),
      ...(newSchema ? this.reachableComponents(this.newModel.registry, newSchema, "new") : [])
    ]);
    for (const component of components) {
      const list = this.componentUsage.get(component) ?? [];
      list.push({
        operationKey: `${operationLocation.method?.toUpperCase() ?? ""} ${operationLocation.path ?? ""}`.trim(),
        operationId: operationLocation.operationId,
        direction,
        displayPath: mediaLocation.displayPath
      });
      this.componentUsage.set(component, list);
    }
  }

  /** Component schema names reachable from a schema root, computed once per root. */
  private reachableComponents(registry: SchemaRegistry, rootId: SchemaId, side: "old" | "new"): Set<string> {
    const cacheKey = `${side}\u0000${rootId}`;
    const cached = this.reachableCache.get(cacheKey);
    if (cached) return cached;

    const found = new Set<string>();
    const visited = new Set<SchemaId>();
    const stack: SchemaId[] = [rootId];

    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const node = registry.get(id);
      if (!node) continue;
      if (node.origin.kind === "component") found.add(node.origin.name);

      for (const child of node.properties.values()) stack.push(child);
      if (node.items) stack.push(node.items);
      if (typeof node.additionalProperties === "string") stack.push(node.additionalProperties);
      for (const list of [node.oneOf, node.anyOf, node.allOf]) {
        if (list) stack.push(...list);
      }
    }

    this.reachableCache.set(cacheKey, found);
    return found;
  }

  // -------------------------------------------------------------------------
  // Schema plumbing
  // -------------------------------------------------------------------------

  private differFor(direction: Direction): SchemaDiffer {
    let differ = this.differs.get(direction);
    if (!differ) {
      differ = new SchemaDiffer(this.oldModel.registry, this.newModel.registry, direction, this.comparisonBudget);
      this.differs.set(direction, differ);
    }
    return differ;
  }

  private applySchemaFindings(
    oldSchema: SchemaId | undefined,
    newSchema: SchemaId | undefined,
    direction: Direction,
    base: ChangeLocation
  ): void {
    if (oldSchema === undefined || newSchema === undefined) return;
    const result = this.differFor(direction).compare(oldSchema, newSchema);
    this.applyFindings(result.findings, result.renames, direction, base);
  }

  private applyFindings(
    findings: readonly SchemaFinding[],
    renames: readonly SchemaRenameFinding[],
    direction: Direction,
    base: ChangeLocation
  ): void {
    for (const finding of findings) {
      const displayPath =
        finding.propertyPath.length > 0
          ? `${base.displayPath}.${finding.propertyPath.join(".")}`
          : base.displayPath;
      this.emit(
        finding.rule,
        {
          ...base,
          displayPath,
          propertyPath: finding.propertyPath.length > 0 ? [...finding.propertyPath] : undefined,
          propertyName: finding.propertyName
        },
        direction,
        finding.oldValue,
        finding.newValue,
        finding.metadata,
        finding.confidenceOverride
      );
    }

    for (const rename of renames) {
      const displayPath =
        rename.propertyPath.length > 0 ? `${base.displayPath}.${rename.propertyPath.join(".")}` : base.displayPath;
      this.renames.push({
        kind: "property",
        from: rename.from,
        to: rename.to,
        location: { ...base, displayPath, propertyPath: [...rename.propertyPath] },
        direction,
        confidence: rename.confidence,
        evidence: [...rename.evidence]
      });
    }
  }

  private emit(
    ruleId: RuleId,
    location: ChangeLocation,
    direction: Direction,
    oldValue: unknown,
    newValue: unknown,
    metadata?: Record<string, unknown>,
    confidenceOverride?: Confidence
  ): void {
    this.changeBudget.spend();
    const definition = RULE_CATALOG[ruleId];
    const severity = severityFor(ruleId, direction);
    this.changes.push({
      id: computeChangeId(ruleId, location.displayPath, direction, oldValue, newValue),
      rule: ruleId,
      kind: definition.kind,
      location,
      direction,
      severity,
      breaking: severity === "BREAKING",
      confidence: confidenceOverride ?? definition.confidence,
      reason: definition.rationale,
      oldValue,
      newValue,
      metadata
    });
  }
}

// ---------------------------------------------------------------------------

function locationOf(operation: ApiOperation): ChangeLocation {
  return {
    displayPath: `paths.${operation.path}.${operation.method}`,
    jsonPointer: operation.pointer,
    path: operation.path,
    method: operation.method,
    operationId: operation.operationId
  };
}

function parameterLocation(base: ChangeLocation, parameter: ApiParameter): ChangeLocation {
  return {
    ...base,
    displayPath: `${base.displayPath}.parameters.${parameter.in}.${parameter.name}`,
    jsonPointer: parameter.pointer,
    parameterName: parameter.name,
    parameterIn: parameter.in
  };
}

function groupByName(parameters: readonly ApiParameter[]): Map<string, ApiParameter[]> {
  const map = new Map<string, ApiParameter[]>();
  for (const parameter of parameters) {
    const list = map.get(parameter.name) ?? [];
    list.push(parameter);
    map.set(parameter.name, list);
  }
  return map;
}

function isSuccess(statusCode: string): boolean {
  return /^2\d\d$/.test(statusCode);
}

function byKey(a: readonly [string, ApiOperation], b: readonly [string, ApiOperation]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function mergeUnsupported(oldModel: BuiltModel, newModel: BuiltModel): UnsupportedNote[] {
  const notes = new Map<string, UnsupportedNote>();
  for (const model of [oldModel, newModel]) {
    for (const feature of model.unsupported) {
      notes.set(`${feature.pointer}\u0000${feature.feature}`, {
        displayPath: feature.pointer,
        feature: feature.feature,
        detail: feature.detail
      });
    }
  }
  return [...notes.values()].sort((a, b) =>
    a.displayPath === b.displayPath
      ? a.feature < b.feature
        ? -1
        : 1
      : a.displayPath < b.displayPath
        ? -1
        : 1
  );
}

/** Guard used by callers that must not analyse documents of different major versions. */
export function assertComparable(oldDocument: OpenApiDocument, newDocument: OpenApiDocument): void {
  const oldMajor = oldDocument.openapi.split(".")[0];
  const newMajor = newDocument.openapi.split(".")[0];
  if (oldMajor !== newMajor) {
    throw new OpenAPIError(`Cannot compare OpenAPI ${oldDocument.openapi} with ${newDocument.openapi}`, {
      code: "OPENAPI_VERSION_MISMATCH",
      details: { oldVersion: oldDocument.openapi, newVersion: newDocument.openapi }
    });
  }
}
