
import { BreakingChange, BreakingChangeType } from "@tern/shared";
import { OpenApiDocument, PathItemObject, OperationObject, SchemaObject, HttpMethod, HTTP_METHODS, MigrationInstruction } from "./interfaces";
import { resolveSchema } from "./normalizer";

export class DefaultDiffEngine {
  private instructions: MigrationInstruction[] = [];
  private oldSpec!: OpenApiDocument;
  private newSpec!: OpenApiDocument;

  async diff(oldSpec: OpenApiDocument, newSpec: OpenApiDocument): Promise<BreakingChange[]> {
    this.oldSpec = oldSpec;
    this.newSpec = newSpec;
    this.instructions = [];
    const changes: BreakingChange[] = [];
    this.detectEndpointRemovals(changes);
    this.detectEndpointAdditions(changes);
    this.detectOperationIdChanges(changes);
    this.detectParameterChanges(changes);
    this.detectRequestBodyChanges(changes);
    this.detectResponseChanges(changes);
    this.detectServerChanges(changes);
    this.detectSecurityChanges(changes);
    this.detectComponentSchemaChanges(changes);
    return changes;
  }

  getMigrationInstructions(): MigrationInstruction[] { return [...this.instructions]; }

  private detectEndpointRemovals(changes: BreakingChange[]): void {
    for (const [path, oldItem] of Object.entries(this.oldSpec.paths || {})) {
      const newItem = this.newSpec.paths[path];
      if (!newItem) {
        this.add(changes, "endpoint-removed", path, undefined, `Endpoint ${path} removed`, "breaking", "Remove all client calls to this endpoint; find a replacement or deprecate the feature.", [], 0.95, "Endpoint no longer exists in new spec.");
        continue;
      }
      for (const method of HTTP_METHODS) {
        if ((oldItem as any)[method] && !(newItem as any)[method]) {
          this.add(changes, "endpoint-removed", path, method, `${method.toUpperCase()} ${path} removed`, "breaking", `Replace ${method.toUpperCase()} ${path} calls with the supported method on the same path.`, [], 0.85, `Method ${method.toUpperCase()} no longer available for ${path}.`);
        }
      }
    }
  }

  private detectEndpointAdditions(changes: BreakingChange[]): void {
    for (const [path, newItem] of Object.entries(this.newSpec.paths || {})) {
      if (this.oldSpec.paths[path]) continue;
      for (const method of HTTP_METHODS) {
        if ((newItem as any)[method]) {
          this.add(changes, "general", path, method, `New ${method.toUpperCase()} ${path} added`, "risky", `No changes required; new endpoint may be used if needed.`, [], 0.99, "New endpoint added in new spec.");
        }
      }
    }
  }

  private detectOperationIdChanges(changes: BreakingChange[]): void {
    const oldOps = listOperations(this.oldSpec);
    const newOps = listOperations(this.newSpec);
    for (const [id, oldEntry] of oldOps.entries()) {
      if (id.includes(":")) continue;
      const newEntry = newOps.get(id);
      if (!newEntry) {
        this.add(changes, "operation-id-removed", oldEntry.path, oldEntry.method, `Operation ${id} removed`, "breaking", `Remove or replace calls to ${id}.`, [], 0.9, "operationId no longer exists in new spec.");
        continue;
      }
      if (oldEntry.path !== newEntry.path || oldEntry.method !== newEntry.method) {
        this.add(changes, "operation-id-removed", oldEntry.path, oldEntry.method, `Operation ${id} moved from ${oldEntry.method.toUpperCase()} ${oldEntry.path} to ${newEntry.method.toUpperCase()} ${newEntry.path}`, "breaking", `Update calls to use the new path and method.`, [{ old: `${oldEntry.method.toUpperCase()} ${oldEntry.path}`, new: `${newEntry.method.toUpperCase()} ${newEntry.path}`, kind: "endpoint" }], 0.85, "operationId moved to a new endpoint.");
      } else if (oldEntry.op.operationId !== newEntry.op.operationId) {
        this.add(changes, "operation-id-removed", oldEntry.path, oldEntry.method, `${oldEntry.method.toUpperCase()} ${oldEntry.path} operationId changed from ${oldEntry.op.operationId} to ${newEntry.op.operationId}`, "breaking", `Rename method calls from ${oldEntry.op.operationId} to ${newEntry.op.operationId}.`, [{ old: oldEntry.op.operationId, new: newEntry.op.operationId, kind: "operationId" }], 0.95, "operationId changed for same path/method.");
      }
    }
  }

  private detectParameterChanges(changes: BreakingChange[]): void {
    const oldOps = listOperations(this.oldSpec);
    const newOps = listOperations(this.newSpec);
    for (const [id, oldEntry] of oldOps.entries()) {
      const newEntry = newOps.get(id);
      if (!newEntry) continue;
      const oldParams = flattenParams(oldEntry.item, oldEntry.op);
      const newParams = flattenParams(newEntry.item, newEntry.op);
      for (const [name, oldParam] of oldParams.entries()) {
        const newParam = newParams.get(name);
        if (!newParam) {
          this.add(changes, "required-parameter-removed", oldEntry.path, oldEntry.method, `Parameter ${name} removed from ${oldEntry.method.toUpperCase()} ${oldEntry.path}`, "breaking", `Remove the ${name} parameter from calls.`, [{ old: name, new: "", kind: "parameter" }], 0.9, "Parameter removed from operation.");
        } else if (oldParam.in === "path" && newParam.name !== name) {
          this.add(changes, "path-parameter-renamed", oldEntry.path, oldEntry.method, `Path parameter ${name} renamed to ${newParam.name} in ${oldEntry.method.toUpperCase()} ${oldEntry.path}`, "breaking", `Rename path parameter variable from ${name} to ${newParam.name}.`, [{ old: name, new: newParam.name, kind: "pathParameter" }], 0.95, "Path parameter name changed.");
        } else if (oldParam.required && !newParam.required) {
          this.add(changes, "required-parameter-removed", oldEntry.path, oldEntry.method, `Parameter ${name} is no longer required in ${oldEntry.method.toUpperCase()} ${oldEntry.path}`, "risky", `Parameter ${name} is optional now.`, [{ old: `${name}?`, new: name, kind: "parameter" }], 0.95, "Parameter became optional.");
        } else if (!oldParam.required && newParam.required) {
          this.add(changes, "required-parameter-added", oldEntry.path, oldEntry.method, `Parameter ${name} became required in ${oldEntry.method.toUpperCase()} ${oldEntry.path}`, "breaking", `Ensure ${name} is always provided in calls.`, [{ old: `${name}?`, new: name, kind: "parameter" }], 0.8, "Parameter became required.");
        }
      }
      for (const [name, newParam] of newParams.entries()) {
        if (!oldParams.has(name) && newParam.required) {
          this.add(changes, "required-parameter-added", newEntry.path, newEntry.method, `Required parameter ${name} added to ${newEntry.method.toUpperCase()} ${newEntry.path}`, "breaking", `Add required parameter ${name} to calls.`, [{ old: "", new: name, kind: "parameter" }], 0.8, "New required parameter added.");
        }
      }
    }
  }

  private detectRequestBodyChanges(changes: BreakingChange[]): void {
    this.forEachPairedOp((oldEntry, newEntry) => {
      const oldBody = getBodySchema(oldEntry.op, this.oldSpec);
      const newBody = getBodySchema(newEntry.op, this.newSpec);
      if (!oldBody && !newBody) return;
      if (!oldBody && newBody && (newBody.required?.length ?? 0)) {
        this.add(changes, "required-parameter-added", newEntry.path, newEntry.method, `Request body required in ${newEntry.method.toUpperCase()} ${newEntry.path}`, "breaking", `Add request body with required fields: ${newBody.required?.join(", ")}.`, (newBody.required || []).map(r => ({ old: "", new: r, kind: "requestBody" })), 0.8, "Request body became required.");
      }
      if (oldBody && newBody) {
        this.detectSchemaFieldChanges(oldBody, newBody, oldEntry.path, oldEntry.method, "request", changes);
        this.detectTypeChanges(oldBody, newBody, oldEntry.path, oldEntry.method, "request", changes);
        this.detectEnumChanges(oldBody, newBody, oldEntry.path, oldEntry.method, "request", changes);
      }
    });
  }

  private detectResponseChanges(changes: BreakingChange[]): void {
    this.forEachPairedOp((oldEntry, newEntry) => {
      const oldResp = getResponseSchema(oldEntry.op, this.oldSpec);
      const newResp = getResponseSchema(newEntry.op, this.newSpec);
      if (oldResp && newResp) {
        this.detectSchemaFieldChanges(oldResp, newResp, oldEntry.path, oldEntry.method, "response", changes);
        this.detectTypeChanges(oldResp, newResp, oldEntry.path, oldEntry.method, "response", changes);
        this.detectEnumChanges(oldResp, newResp, oldEntry.path, oldEntry.method, "response", changes);
      }
    });
  }

  private detectSchemaFieldChanges(oldSchema: SchemaObject, newSchema: SchemaObject, path: string, method: HttpMethod, kind: "request" | "response", changes: BreakingChange[]): void {
    const oldProps = oldSchema.properties || {};
    const newProps = newSchema.properties || {};
    const oldRequired = new Set(oldSchema.required || []);
    const newRequired = new Set(newSchema.required || []);
    for (const name of Object.keys(oldProps)) {
      if (!newProps[name]) {
        this.add(changes, `${kind}-field-removed`, path, method, `${capitalize(kind)} field ${name} removed from ${method.toUpperCase()} ${path}`, "breaking", `Remove usage of ${name} from ${kind} handling.`, [{ old: name, new: "", kind: "field" }], 0.9, "Field removed.");
      } else {
        if (!oldRequired.has(name) && newRequired.has(name)) {
          this.add(changes, "required-parameter-added", path, method, `Field ${name} became required in ${kind} of ${method.toUpperCase()} ${path}`, "breaking", `Ensure ${name} is always provided in ${kind}.`, [{ old: `${name}?`, new: name, kind: "field" }], 0.8, "Field became required.");
        }
        this.detectFieldRename(name, oldProps[name], newProps, path, method, kind, changes);
      }
    }
    for (const name of Object.keys(newProps)) {
      if (!oldProps[name] && newRequired.has(name)) {
        this.add(changes, "required-parameter-added", path, method, `Required ${kind} field ${name} added to ${method.toUpperCase()} ${path}`, "breaking", `Add required ${kind} field ${name}.`, [{ old: "", new: name, kind: "field" }], 0.75, "New required field added.");
      }
    }
  }

  private detectFieldRename(name: string, oldProp: SchemaObject, newProps: Record<string, SchemaObject>, path: string, method: HttpMethod, kind: "request" | "response", changes: BreakingChange[]): void {
    if (newProps[name]) return;
    const candidates = Object.keys(newProps).filter(k => {
      const newProp = newProps[k];
      return oldProp.type === newProp.type && (oldProp.description === newProp.description || oldProp.format === newProp.format);
    });
    if (candidates.length === 1) {
      this.add(changes, `${kind}-field-renamed`, path, method, `${capitalize(kind)} field ${name} likely renamed to ${candidates[0]} in ${method.toUpperCase()} ${path}`, "risky", `Rename ${kind} field ${name} to ${candidates[0]}.`, [{ old: name, new: candidates[0], kind: "field" }], 0.6, "Similar field found with matching type/description.");
    }
  }

  private detectTypeChanges(oldSchema: SchemaObject, newSchema: SchemaObject, path: string, method: HttpMethod, kind: "request" | "response", changes: BreakingChange[]): void {
    if (oldSchema.type && newSchema.type && oldSchema.type !== newSchema.type) {
      this.add(changes, "type-changed", path, method, `${capitalize(kind)} body type changed from ${oldSchema.type} to ${newSchema.type} in ${method.toUpperCase()} ${path}`, "breaking", `Update ${kind} handling to match the new type.`, [], 0.7, "Body type changed.");
    }
    const oldProps = oldSchema.properties || {};
    const newProps = newSchema.properties || {};
    for (const [name, oldProp] of Object.entries(oldProps)) {
      const newProp = newProps[name];
      if (newProp && oldProp.type && newProp.type && oldProp.type !== newProp.type) {
        this.add(changes, "type-changed", path, method, `Field ${name} type changed from ${oldProp.type} to ${newProp.type} in ${kind} of ${method.toUpperCase()} ${path}`, "breaking", `Update usage of ${name} to match the new type.`, [{ old: name, new: name, kind: "type" }], 0.75, "Field type changed.");
      }
    }
  }

  private detectEnumChanges(oldSchema: SchemaObject, newSchema: SchemaObject, path: string, method: HttpMethod, kind: "request" | "response", changes: BreakingChange[]): void {
    const oldProps = oldSchema.properties || {};
    const newProps = newSchema.properties || {};
    for (const [name, oldProp] of Object.entries(oldProps)) {
      const newProp = newProps[name];
      if (!newProp) continue;
      const oldEnum = new Set(oldProp.enum || []);
      const newEnum = new Set(newProp.enum || []);
      const removed = [...oldEnum].filter(v => !newEnum.has(v));
      const added = [...newEnum].filter(v => !oldEnum.has(v));
      if (removed.length) {
        this.add(changes, "enum-value-removed", path, method, `Enum values removed from ${name} in ${kind} of ${method.toUpperCase()} ${path}: ${removed.join(", ")}`, "breaking", `Remove usage of deprecated enum values: ${removed.join(", ")}.`, removed.map(v => ({ old: String(v), new: "", kind: "enum" })), 0.85, "Enum values removed.");
      }
      if (added.length) {
        this.add(changes, "enum-value-added", path, method, `New enum values added to ${name} in ${kind} of ${method.toUpperCase()} ${path}: ${added.join(", ")}`, "risky", `New enum values are available; no changes required unless adopted.`, [], 0.95, "New enum values added.");
      }
    }
  }

  private detectComponentSchemaChanges(changes: BreakingChange[]): void {
    const oldSchemas = this.oldSpec.components?.schemas || {};
    const newSchemas = this.newSpec.components?.schemas || {};
    for (const [name, oldSchema] of Object.entries(oldSchemas)) {
      const newSchema = newSchemas[name];
      if (!newSchema) {
        this.add(changes, "general", `components/schemas/${name}`, undefined, `Schema ${name} removed`, "breaking", `Remove references to schema ${name} or replace them.`, [], 0.9, "Component schema removed.");
      } else {
        this.detectSchemaFieldChanges(oldSchema, newSchema, `components/schemas/${name}`, "get" as HttpMethod, "response", changes);
      }
    }
  }

  private detectServerChanges(changes: BreakingChange[]): void {
    const oldServers = this.oldSpec.servers?.map(s => s.url) || [];
    const newServers = this.newSpec.servers?.map(s => s.url) || [];
    if (JSON.stringify(oldServers) !== JSON.stringify(newServers)) {
      const mappings = oldServers.map((old, i) => ({ old, new: newServers[i] || "", kind: "server" }));
      this.add(changes, "general", "servers", undefined, `Server URLs changed from ${oldServers.join(", ") || "none"} to ${newServers.join(", ") || "none"}`, "breaking", `Update base URLs in client configuration.`, mappings, 0.95, "Server URL changed.");
    }
  }

  private detectSecurityChanges(changes: BreakingChange[]): void {
    const oldSecurity = this.oldSpec.security || [];
    const newSecurity = this.newSpec.security || [];
    if (JSON.stringify(oldSecurity) !== JSON.stringify(newSecurity)) {
      this.add(changes, "general", "security", undefined, "Global security requirements changed", "breaking", `Review authentication requirements and update client configuration.`, [], 0.8, "Security requirements changed.");
    }
  }

  private forEachPairedOp(fn: (oldEntry: OpEntry, newEntry: OpEntry) => void): void {
    const oldOps = listOperations(this.oldSpec);
    const newOps = listOperations(this.newSpec);
    for (const [id, oldEntry] of oldOps.entries()) {
      if (id.includes(":")) continue;
      const newEntry = newOps.get(id);
      if (!newEntry) continue;
      fn(oldEntry, newEntry);
    }
  }

  private add(changes: BreakingChange[], type: BreakingChangeType, path: string, method: HttpMethod | undefined, description: string, severity: "breaking" | "risky", action: string, mappings: Array<{ old: string; new: string; kind: string }>, confidence: number, reasoning: string): void {
    const change: BreakingChange = { id: crypto.randomUUID(), type, path, method, description, severity };
    changes.push(change);
    this.instructions.push({ changeType: type, path, method, operationId: undefined, severity, description, action, mappings, confidence, reasoning });
  }
}

interface OpEntry { path: string; method: HttpMethod; item: PathItemObject; op: OperationObject; }

function listOperations(spec: OpenApiDocument): Map<string, OpEntry> {
  const map = new Map<string, OpEntry>();
  for (const [path, item] of Object.entries(spec.paths || {})) {
    for (const method of HTTP_METHODS) {
      const op = (item as any)[method] as OperationObject | undefined;
      if (!op) continue;
      const key = op.operationId ?? `${method}:${path}`;
      map.set(key, { path, method, item, op });
    }
  }
  return map;
}

function flattenParams(item: PathItemObject | undefined, op: OperationObject): Map<string, { name: string; in: string; required: boolean; schema?: SchemaObject }> {
  const map = new Map<string, { name: string; in: string; required: boolean; schema?: SchemaObject }>();
  for (const source of [item?.parameters || [], op.parameters || []]) {
    for (const p of source) {
      map.set(`${p.in}:${p.name}`, { name: p.name, in: p.in, required: p.required ?? (p.in === "path"), schema: p.schema });
    }
  }
  return map;
}

function getBodySchema(op: OperationObject, spec: OpenApiDocument): SchemaObject | undefined {
  const content = op.requestBody?.content || {};
  for (const media of Object.values(content)) {
    if (media.schema) return resolveSchema(media.schema, spec);
  }
  return undefined;
}

function getResponseSchema(op: OperationObject, spec: OpenApiDocument): SchemaObject | undefined {
  const responses = op.responses || {};
  for (const code of ["200", "201", "202", "203"]) {
    const resp = responses[code];
    if (resp && resp.content) {
      for (const media of Object.values(resp.content)) {
        if (media.schema) return resolveSchema(media.schema, spec);
      }
    }
  }
  return undefined;
}

function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
