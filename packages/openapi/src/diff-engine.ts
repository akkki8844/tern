
import { BreakingChange, BreakingChangeType } from "@tern/shared";
import {
  OpenApiDocument, PathItemObject, OperationObject, SchemaObject, HttpMethod, HTTP_METHODS,
  MigrationInstruction
} from "./interfaces";
import { normalizeOperations, normalizeSchema, resolveSchema } from "./normalizer";

export class DefaultDiffEngine {
  private instructions: MigrationInstruction[] = [];

  async diff(oldSpec: OpenApiDocument, newSpec: OpenApiDocument): Promise<BreakingChange[]> {
    this.instructions = [];
    const changes: BreakingChange[] = [];
    this.detectEndpointRemovals(oldSpec, newSpec, changes);
    this.detectEndpointAdditions(oldSpec, newSpec, changes);
    this.detectMethodChanges(oldSpec, newSpec, changes);
    this.detectOperationIdChanges(oldSpec, newSpec, changes);
    this.detectParameterChanges(oldSpec, newSpec, changes);
    this.detectRequestBodyChanges(oldSpec, newSpec, changes);
    this.detectResponseChanges(oldSpec, newSpec, changes);
    this.detectServerChanges(oldSpec, newSpec, changes);
    this.detectSecurityChanges(oldSpec, newSpec, changes);
    this.detectSchemaChanges(oldSpec, newSpec, changes);
    return changes;
  }

  getMigrationInstructions(): MigrationInstruction[] {
    return [...this.instructions];
  }

  private makeInstruction(change: BreakingChange, action: string, mappings: Array<{ old: string; new: string; kind: string }>, confidence: number, reasoning: string): void {
    this.instructions.push({
      changeType: change.type,
      path: change.path,
      method: change.method as HttpMethod,
      operationId: change.operationId,
      severity: change.severity,
      description: change.description,
      action,
      mappings,
      confidence,
      reasoning
    });
  }

  private listOps(spec: OpenApiDocument): Map<string, { path: string; method: HttpMethod; op: OperationObject }> {
    const map = new Map<string, { path: string; method: HttpMethod; op: OperationObject }>();
    for (const [path, item] of Object.entries(spec.paths || {})) {
      for (const method of HTTP_METHODS) {
        const op = (item as any)[method] as OperationObject | undefined;
        if (op) {
          const key = op.operationId ?? `${method}:${path}`;
          map.set(key, { path, method, op });
        }
      }
    }
    return map;
  }

  private detectEndpointRemovals(oldSpec: OpenApiDocument, newSpec: OpenApiDocument, changes: BreakingChange[]): void {
    for (const [path, oldItem] of Object.entries(oldSpec.paths || {})) {
      const newItem = newSpec.paths[path];
      if (!newItem) {
        const c = this.makeChange("endpoint-removed", path, undefined, `Endpoint ${path} removed`, "breaking");
        changes.push(c);
        this.makeInstruction(c, "Remove all client calls to this endpoint; find replacement endpoint or deprecate feature.", [], 0.95, "Endpoint no longer exists in new spec.");
        continue;
      }
      for (const method of HTTP_METHODS) {
        if ((oldItem as any)[method] && !(newItem as any)[method]) {
          const c = this.makeChange("endpoint-removed", path, method, `${method.toUpperCase()} ${path} removed`, "breaking");
          changes.push(c);
          this.makeInstruction(c, `Replace ${method.toUpperCase()} ${path} calls with the supported method on the same path.`, [], 0.85, `Method ${method.toUpperCase()} no longer available for ${path}.`);
        }
      }
    }
  }

  private detectEndpointAdditions(oldSpec: OpenApiDocument, newSpec: OpenApiDocument, changes: BreakingChange[]): void {
    for (const [path, newItem] of Object.entries(newSpec.paths || {})) {
      if (oldSpec.paths[path]) continue;
      for (const method of HTTP_METHODS) {
        if ((newItem as any)[method]) {
          changes.push(this.makeChange("general", path, method, `New ${method.toUpperCase()} ${path} added`, "risky"));
        }
      }
    }
  }

  private detectMethodChanges(oldSpec: OpenApiDocument, newSpec: OpenApiDocument, changes: BreakingChange[]): void {
    for (const [path, oldItem] of Object.entries(oldSpec.paths || {})) {
      const newItem = newSpec.paths[path];
      if (!newItem) continue;
      for (const method of HTTP_METHODS) {
        const oldMethod = (oldItem as any)[method];
        const newMethod = (newItem as any)[method];
        if (oldMethod && newMethod && oldMethod.operationId !== newMethod.operationId && oldMethod.operationId && newMethod.operationId) {
          const c = this.makeChange("operation-id-removed", path, method, `${method.toUpperCase()} ${path} operationId changed from ${oldMethod.operationId} to ${newMethod.operationId}`, "breaking");
          changes.push(c);
          this.makeInstruction(c, "Rename method calls from old operationId to new operationId.", [{ old: oldMethod.operationId, new: newMethod.operationId, kind: "operationId" }], 0.95, `operationId changed for same method/path.`);
        }
      }
    }
  }

  private detectOperationIdChanges(oldSpec: OpenApiDocument, newSpec: OpenApiDocument, changes: BreakingChange[]): void {
    const oldOps = this.listOps(oldSpec);
    const newOps = this.listOps(newSpec);
    for (const [opId, oldEntry] of oldOps.entries()) {
      if (opId.includes(":")) continue;
      const newEntry = newOps.get(opId);
      if (!newEntry) {
        const c = this.makeChange("operation-id-removed", oldEntry.path, oldEntry.method, `Operation ${opId} removed`, "breaking");
        changes.push(c);
        this.makeInstruction(c, `Remove or replace calls to ${opId}.`, [], 0.9, "operationId no longer exists in new spec.");
      } else if (newEntry.path !== oldEntry.path || newEntry.method !== oldEntry.method) {
        const c = this.makeChange("operation-id-removed", oldEntry.path, oldEntry.method, `Operation ${opId} moved from ${oldEntry.method.toUpperCase()} ${oldEntry.path} to ${newEntry.method.toUpperCase()} ${newEntry.path}`, "breaking");
        changes.push(c);
        this.makeInstruction(c, "Update calls to use the new path/method.", [{ old: `${oldEntry.method.toUpperCase()} ${oldEntry.path}`, new: `${newEntry.method.toUpperCase()} ${newEntry.path}`, kind: "endpoint" }], 0.85, "operationId moved to a new endpoint.");
      }
    }
  }

  private detectParameterChanges(oldSpec: OpenApiDocument, newSpec: OpenApiDocument, changes: BreakingChange[]): void {
    const oldOps = this.listOps(oldSpec);
    const newOps = this.listOps(newSpec);
    for (const [opId, oldEntry] of oldOps.entries()) {
      const newEntry = newOps.get(opId);
      if (!newEntry) continue;
      const oldParams = this.flattenParams(oldSpec.paths[oldEntry.path], oldEntry.op);
      const newParams = this.flattenParams(newSpec.paths[newEntry.path], newEntry.op);
      for (const [name, oldParam] of oldParams.entries()) {
        const newParam = newParams.get(name);
        if (!newParam) {
          const c = this.makeChange("required-parameter-removed", oldEntry.path, oldEntry.method, `Parameter ${name} removed from ${oldEntry.method.toUpperCase()} ${oldEntry.path}`, "breaking");
          changes.push(c);
          this.makeInstruction(c, `Remove the ${name} parameter from calls.`, [{ old: name, new: "", kind: "parameter" }], 0.9, "Parameter removed from operation.");
        } else if (oldParam.in === "path" && newParam.name !== name) {
          const c = this.makeChange("path-parameter-renamed", oldEntry.path, oldEntry.method, `Path parameter ${name} renamed to ${newParam.name}`, "breaking");
          changes.push(c);
          this.makeInstruction(c, `Rename path parameter variable from ${name} to ${newParam.name}.`, [{ old: name, new: newParam.name, kind: "pathParameter" }], 0.95, "Path parameter name changed.");
        } else if (oldParam.required && !newParam.required) {
          changes.push(this.makeChange("required-parameter-removed", oldEntry.path, oldEntry.method, `Parameter ${name} is no longer required`, "risky"));
        } else if (!oldParam.required && newParam.required) {
          const c = this.makeChange("required-parameter-added", oldEntry.path, oldEntry.method, `Parameter ${name} became required in ${oldEntry.method.toUpperCase()} ${oldEntry.path}`, "breaking");
          changes.push(c);
          this.makeInstruction(c, `Ensure ${name} is always provided in calls.`, [{ old: `${name}?`, new: name, kind: "parameter" }], 0.8, "Parameter became required.");
        }
      }
      for (const [name, newParam] of newParams.entries()) {
        const oldParam = oldParams.get(name);
        if (!oldParam && newParam.required) {
          const c = this.makeChange("required-parameter-added", newEntry.path, newEntry.method, `Required parameter ${name} added to ${newEntry.method.toUpperCase()} ${newEntry.path}`, "breaking");
          changes.push(c);
          this.makeInstruction(c, `Add required parameter ${name} to calls.`, [{ old: "", new: name, kind: "parameter" }], 0.8, "New required parameter added.");
        }
      }
    }
  }

  private detectRequestBodyChanges(oldSpec: OpenApiDocument, newSpec: OpenApiDocument, changes: BreakingChange[]): void {
    const oldOps = this.listOps(oldSpec);
    const newOps = this.listOps(newSpec);
    for (const [opId, oldEntry] of oldOps.entries()) {
      const newEntry = newOps.get(opId);
      if (!newEntry) continue;
      const oldBody = this.getBodySchema(oldEntry.op, oldSpec);
      const newBody = this.getBodySchema(newEntry.op, newSpec);
      if (!oldBody && !newBody) continue;
      if (!oldBody && newBody && newBody.required && newBody.required.length) {
        const c = this.makeChange("required-parameter-added", newEntry.path, newEntry.method, `Request body required in ${newEntry.method.toUpperCase()} ${newEntry.path}`, "breaking");
        changes.push(c);
        this.makeInstruction(c, "Add request body with required fields.", newBody.required.map(r => ({ old: "", new: r, kind: "requestBody" })), 0.8, "Request body became required.");
      }
      if (oldBody && newBody) {
        this.detectSchemaFieldChanges(oldBody, newBody, oldEntry.path, oldEntry.method, "request", changes, oldEntry.operationId);
        this.detectTypeChanges(oldBody, newBody, oldEntry.path, oldEntry.method, "request", changes);
        this.detectEnumChanges(oldBody, newBody, oldEntry.path, oldEntry.method, "request", changes);
      }
    }
  }

  private detectResponseChanges(oldSpec: OpenApiDocument, newSpec: OpenApiDocument, changes: BreakingChange[]): void {
    const oldOps = this.listOps(oldSpec);
    const newOps = this.listOps(newSpec);
    for (const [opId, oldEntry] of oldOps.entries()) {
      const newEntry = newOps.get(opId);
      if (!newEntry) continue;
      const oldResp = this.getResponseSchema(oldEntry.op, oldSpec);
      const newResp = this.getResponseSchema(newEntry.op, newSpec);
      if (oldResp && newResp) {
        this.detectSchemaFieldChanges(oldResp, newResp, oldEntry.path, oldEntry.method, "response", changes, oldEntry.operationId);
        this.detectTypeChanges(oldResp, newResp, oldEntry.path, oldEntry.method, "response", changes);
        this.detectEnumChanges(oldResp, newResp, oldEntry.path, oldEntry.method, "response", changes);
      }
    }
  }

  private detectSchemaFieldChanges(oldSchema: SchemaObject, newSchema: SchemaObject, path: string, method: HttpMethod, kind: "request" | "response", changes: BreakingChange[], operationId?: string): void {
    const oldProps = oldSchema.properties || {};
    const newProps = newSchema.properties || {};
    const oldRequired = new Set(oldSchema.required || []);
    const newRequired = new Set(newSchema.required || []);
    for (const name of Object.keys(oldProps)) {
      if (!newProps[name]) {
        const c = this.makeChange(`${kind}-field-removed`, path, method, `${kind === "request" ? "Request" : "Response"} field ${name} removed from ${method.toUpperCase()} ${path}`, "breaking");
        changes.push(c);
        this.makeInstruction(c, `Remove usage of ${name} from ${kind} handling.`, [{ old: name, new: "", kind: "field" }], 0.9, "Field removed.");
      } else {
        if (!oldRequired.has(name) && newRequired.has(name)) {
          changes.push(this.makeChange("required-parameter-added", path, method, `Field ${name} became required in ${kind} of ${method.toUpperCase()} ${path}`, "breaking"));
        }
        this.detectFieldRename(name, oldProps[name], newProps, path, method, kind, changes);
      }
    }
    for (const name of Object.keys(newProps)) {
      if (!oldProps[name] && newRequired.has(name)) {
        const c = this.makeChange("required-parameter-added", path, method, `Required ${kind} field ${name} added to ${method.toUpperCase()} ${path}`, "breaking");
        changes.push(c);
        this.makeInstruction(c, `Add required ${kind} field ${name}.`, [{ old: "", new: name, kind: "field" }], 0.75, "New required field added.");
      }
    }
  }

  private detectFieldRename(name: string, oldProp: SchemaObject, newProps: Record<string, SchemaObject>, path: string, method: HttpMethod, kind: "request" | "response", changes: BreakingChange[]): void {
    if (newProps[name]) return;
    const candidates = Object.keys(newProps).filter(k => {
      const newProp = newProps[k];
      return (oldProp.type === newProp.type) && (oldProp.description === newProp.description || oldProp.format === newProp.format);
    });
    if (candidates.length === 1) {
      const c = this.makeChange(`${kind}-field-renamed`, path, method, `${kind === "request" ? "Request" : "Response"} field ${name} likely renamed to ${candidates[0]} in ${method.toUpperCase()} ${path}`, "risky");
      changes.push(c);
      this.makeInstruction(c, `Rename ${kind} field ${name} to ${candidates[0]}.`, [{ old: name, new: candidates[0], kind: "field" }], 0.6, "Similar field found with matching type/description.");
    }
  }

  private detectTypeChanges(oldSchema: SchemaObject, newSchema: SchemaObject, path: string, method: HttpMethod, kind: "request" | "response", changes: BreakingChange[]): void {
    if (oldSchema.type && newSchema.type && oldSchema.type !== newSchema.type) {
      changes.push(this.makeChange("type-changed", path, method, `${kind} body type changed from ${oldSchema.type} to ${newSchema.type} in ${method.toUpperCase()} ${path}`, "breaking"));
    }
    const oldProps = oldSchema.properties || {};
    const newProps = newSchema.properties || {};
    for (const [name, oldProp] of Object.entries(oldProps)) {
      const newProp = newProps[name];
      if (newProp && oldProp.type && newProp.type && oldProp.type !== newProp.type) {
        changes.push(this.makeChange("type-changed", path, method, `Field ${name} type changed from ${oldProp.type} to ${newProp.type} in ${kind} of ${method.toUpperCase()} ${path}`, "breaking"));
      }
    }
  }

  private detectEnumChanges(oldSchema: SchemaObject, newSchema: SchemaObject, path: string, method: HttpMethod, kind: "request" | "response", changes: BreakingChange[]): void {
    const oldProps = oldSchema.properties || {};
    const newProps = newSchema.properties || {};
    for (const [name, oldProp] of Object.entries(oldProps)) {
      const newProp = newProps[name];
      if (!newProp) continue;
      const oldEnum = oldProp.enum || [];
      const newEnum = newProp.enum || [];
      const removed = oldEnum.filter(v => !newEnum.includes(v));
      const added = newEnum.filter(v => !oldEnum.includes(v));
      if (removed.length) {
        const c = this.makeChange("enum-value-removed", path, method, `Enum values removed from ${name} in ${kind} of ${method.toUpperCase()} ${path}: ${removed.join(", ")}`, "breaking");
        changes.push(c);
        this.makeInstruction(c, `Remove usage of deprecated enum values: ${removed.join(", ")}.`, removed.map(v => ({ old: String(v), new: "", kind: "enum" })), 0.85, "Enum values removed.");
      }
      if (added.length) {
        changes.push(this.makeChange("enum-value-added", path, method, `New enum values added to ${name} in ${kind} of ${method.toUpperCase()} ${path}: ${added.join(", ")}`, "risky"));
      }
    }
  }

  private detectSchemaChanges(oldSpec: OpenApiDocument, newSpec: OpenApiDocument, changes: BreakingChange[]): void {
    const oldSchemas = oldSpec.components?.schemas || {};
    const newSchemas = newSpec.components?.schemas || {};
    for (const [name, oldSchema] of Object.entries(oldSchemas)) {
      const newSchema = newSchemas[name];
      if (!newSchema) {
        changes.push(this.makeChange("general", "components/schemas", undefined, `Schema ${name} removed`, "breaking"));
      } else {
        this.detectSchemaFieldChanges(oldSchema, newSchema, "components/schemas", "get" as HttpMethod, "response", changes);
      }
    }
  }

  private detectServerChanges(oldSpec: OpenApiDocument, newSpec: OpenApiDocument, changes: BreakingChange[]): void {
    const oldServers = oldSpec.servers?.map(s => s.url) || [];
    const newServers = newSpec.servers?.map(s => s.url) || [];
    if (JSON.stringify(oldServers) !== JSON.stringify(newServers)) {
      const c = this.makeChange("general", "servers", undefined, `Server URLs changed from ${oldServers.join(", ") || "none"} to ${newServers.join(", ") || "none"}`, "breaking");
      changes.push(c);
      this.makeInstruction(c, "Update base URLs in client configuration.", oldServers.map((s, i) => ({ old: s, new: newServers[i] || "", kind: "server" })), 0.95, "Server URL changed.");
    }
  }

  private detectSecurityChanges(oldSpec: OpenApiDocument, newSpec: OpenApiDocument, changes: BreakingChange[]): void {
    const oldSecurity = oldSpec.security || [];
    const newSecurity = newSpec.security || [];
    if (JSON.stringify(oldSecurity) !== JSON.stringify(newSecurity)) {
      changes.push(this.makeChange("general", "security", undefined, "Global security requirements changed", "breaking"));
    }
  }

  private flattenParams(item: PathItemObject | undefined, op: OperationObject): Map<string, { name: string; in: string; required: boolean; schema?: SchemaObject }> {
    const map = new Map<string, { name: string; in: string; required: boolean; schema?: SchemaObject }>();
    for (const source of [(item?.parameters || []), (op.parameters || [])]) {
      for (const p of source) {
        map.set(`${p.in}:${p.name}`, { name: p.name, in: p.in, required: p.required ?? (p.in === "path"), schema: p.schema });
      }
    }
    return map;
  }

  private getBodySchema(op: OperationObject, spec: OpenApiDocument): SchemaObject | undefined {
    const content = op.requestBody?.content || {};
    for (const media of Object.values(content)) {
      if (media.schema) {
        return resolveSchema(media.schema, spec);
      }
    }
    return undefined;
  }

  private getResponseSchema(op: OperationObject, spec: OpenApiDocument): SchemaObject | undefined {
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

  private makeChange(type: BreakingChangeType, path: string, method: HttpMethod | undefined, description: string, severity: "breaking" | "risky"): BreakingChange {
    return { id: crypto.randomUUID(), type, path, method, description, severity };
  }
}
