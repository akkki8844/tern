
import { BreakingChange, BreakingChangeType } from "@tern/shared";
import { OpenApiDocument, PathItemObject, OperationObject } from "./interfaces";

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";
const METHODS: HttpMethod[] = ["get", "post", "put", "patch", "delete"];

export class DefaultDiffEngine {
  async diff(oldSpec: OpenApiDocument, newSpec: OpenApiDocument): Promise<BreakingChange[]> {
    const changes: BreakingChange[] = [];
    this.detectEndpointRemovals(oldSpec, newSpec, changes);
    this.detectMethodChanges(oldSpec, newSpec, changes);
    this.detectOperationIdChanges(oldSpec, newSpec, changes);
    this.detectParameterChanges(oldSpec, newSpec, changes);
    this.detectRequestBodyChanges(oldSpec, newSpec, changes);
    this.detectResponseChanges(oldSpec, newSpec, changes);
    this.detectServerChanges(oldSpec, newSpec, changes);
    return changes;
  }

  private listOps(spec: OpenApiDocument): Map<string, { path: string; method: HttpMethod; op: OperationObject }> {
    const map = new Map<string, { path: string; method: HttpMethod; op: OperationObject }>();
    for (const [path, item] of Object.entries(spec.paths || {})) {
      for (const method of METHODS) {
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
        changes.push(this.makeChange("endpoint-removed", path, undefined, `Endpoint ${path} removed`, "breaking"));
        continue;
      }
      for (const method of METHODS) {
        if ((oldItem as any)[method] && !(newItem as any)[method]) {
          changes.push(this.makeChange("endpoint-removed", path, method, `${method.toUpperCase()} ${path} removed`, "breaking"));
        }
      }
    }
  }

  private detectMethodChanges(oldSpec: OpenApiDocument, newSpec: OpenApiDocument, changes: BreakingChange[]): void {
    for (const [path, oldItem] of Object.entries(oldSpec.paths || {})) {
      const newItem = newSpec.paths[path];
      if (!newItem) continue;
      for (const method of METHODS) {
        if ((oldItem as any)[method] && !(newItem as any)[method]) {
          changes.push(this.makeChange("method-changed", path, method, `${method.toUpperCase()} ${path} changed`, "breaking"));
        }
      }
    }
  }

  private detectOperationIdChanges(oldSpec: OpenApiDocument, newSpec: OpenApiDocument, changes: BreakingChange[]): void {
    const oldOps = this.listOps(oldSpec);
    const newOps = this.listOps(newSpec);
    for (const [opId, oldEntry] of oldOps.entries()) {
      if (opId.startsWith("get:") || opId.startsWith("post:")) continue;
      const newEntry = newOps.get(opId);
      if (!newEntry) {
        changes.push(this.makeChange("operation-id-removed", oldEntry.path, oldEntry.method, `Operation ${opId} removed`, "breaking"));
      } else if (newEntry.path !== oldEntry.path || newEntry.method !== oldEntry.method) {
        changes.push(this.makeChange("operation-id-removed", oldEntry.path, oldEntry.method, `Operation ${opId} moved from ${oldEntry.method.toUpperCase()} ${oldEntry.path} to ${newEntry.method.toUpperCase()} ${newEntry.path}`, "breaking"));
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
          changes.push(this.makeChange("required-parameter-removed", oldEntry.path, oldEntry.method, `Parameter ${name} removed from ${oldEntry.method.toUpperCase()} ${oldEntry.path}`, "breaking"));
        } else if (oldParam.in === "path" && newParam.name !== name) {
          changes.push(this.makeChange("path-parameter-renamed", oldEntry.path, oldEntry.method, `Path parameter ${name} renamed to ${newParam.name}`, "breaking"));
        }
      }
      for (const [name, newParam] of newParams.entries()) {
        const oldParam = oldParams.get(name);
        if (!oldParam && newParam.required) {
          changes.push(this.makeChange("required-parameter-added", newEntry.path, newEntry.method, `Required parameter ${name} added to ${newEntry.method.toUpperCase()} ${newEntry.path}`, "breaking"));
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
      const oldBody = this.getBodySchema(oldEntry.op);
      const newBody = this.getBodySchema(newEntry.op);
      if (!oldBody && !newBody) continue;
      if (!oldBody && newBody && newBody.required && newBody.required.length) {
        changes.push(this.makeChange("required-parameter-added", newEntry.path, newEntry.method, `Request body required in ${newEntry.method.toUpperCase()} ${newEntry.path}`, "breaking"));
      }
      for (const field of oldBody?.required || []) {
        if (!newBody?.required?.includes(field)) {
          changes.push(this.makeChange("required-parameter-removed", oldEntry.path, oldEntry.method, `Field ${field} no longer required in ${oldEntry.method.toUpperCase()} ${oldEntry.path}`, "risky"));
        }
      }
      for (const field of newBody?.required || []) {
        if (!oldBody?.required?.includes(field)) {
          changes.push(this.makeChange("required-parameter-added", newEntry.path, newEntry.method, `Field ${field} now required in ${newEntry.method.toUpperCase()} ${newEntry.path}`, "breaking"));
        }
      }
      if (oldBody?.properties && newBody?.properties) {
        for (const [name, oldProp] of Object.entries(oldBody.properties)) {
          if (!newBody.properties[name]) {
            changes.push(this.makeChange("request-field-removed", oldEntry.path, oldEntry.method, `Request field ${name} removed from ${oldEntry.method.toUpperCase()} ${oldEntry.path}`, "breaking"));
          } else if ((oldProp as any).enum && !(newBody.properties[name] as any).enum) {
            changes.push(this.makeChange("enum-value-removed", oldEntry.path, oldEntry.method, `Enum removed from ${name} in ${oldEntry.method.toUpperCase()} ${oldEntry.path}`, "risky"));
          }
        }
        for (const [name, newProp] of Object.entries(newBody.properties)) {
          if (!oldBody.properties[name] && (newProp as any).enum) {
            changes.push(this.makeChange("enum-value-added", newEntry.path, newEntry.method, `Enum added to ${name} in ${newEntry.method.toUpperCase()} ${newEntry.path}`, "risky"));
          }
        }
      }
    }
  }

  private detectResponseChanges(oldSpec: OpenApiDocument, newSpec: OpenApiDocument, changes: BreakingChange[]): void {
    const oldOps = this.listOps(oldSpec);
    const newOps = this.listOps(newSpec);
    for (const [opId, oldEntry] of oldOps.entries()) {
      const newEntry = newOps.get(opId);
      if (!newEntry) continue;
      const oldResp = this.getResponseSchema(oldEntry.op);
      const newResp = this.getResponseSchema(newEntry.op);
      if (oldResp?.properties && newResp?.properties) {
        for (const [name, _oldProp] of Object.entries(oldResp.properties)) {
          if (!newResp.properties[name]) {
            changes.push(this.makeChange("response-field-removed", oldEntry.path, oldEntry.method, `Response field ${name} removed from ${oldEntry.method.toUpperCase()} ${oldEntry.path}`, "breaking"));
          } else if (name !== this.findNewName(name, newResp.properties)) {
            changes.push(this.makeChange("response-field-renamed", oldEntry.path, oldEntry.method, `Response field ${name} possibly renamed in ${oldEntry.method.toUpperCase()} ${oldEntry.path}`, "risky"));
          }
        }
        for (const [name, _newProp] of Object.entries(newResp.properties)) {
          if (!oldResp.properties[name]) {
            changes.push(this.makeChange("response-field-renamed", newEntry.path, newEntry.method, `Response field ${name} possibly added in ${newEntry.method.toUpperCase()} ${newEntry.path}`, "risky"));
          }
        }
      }
    }
  }

  private detectServerChanges(oldSpec: OpenApiDocument, newSpec: OpenApiDocument, changes: BreakingChange[]): void {
    const oldServers = oldSpec.servers?.map(s => s.url) || [];
    const newServers = newSpec.servers?.map(s => s.url) || [];
    const oldBase = oldServers[0]?.replace(/\/v\d+$/, "") || "";
    const newBase = newServers[0]?.replace(/\/v\d+$/, "") || "";
    if (oldServers[0] !== newServers[0]) {
      changes.push(this.makeChange("general", "servers", undefined, `Server URL changed from ${oldServers[0] || "none"} to ${newServers[0] || "none"}`, "breaking"));
    }
  }

  private flattenParams(item: PathItemObject | undefined, op: OperationObject): Map<string, { name: string; in: string; required?: boolean }> {
    const map = new Map<string, { name: string; in: string; required?: boolean }>();
    for (const source of [(item?.parameters || []), (op.parameters || [])]) {
      for (const p of source) {
        map.set(`${p.in}:${p.name}`, { name: p.name, in: p.in, required: p.required });
      }
    }
    return map;
  }

  private getBodySchema(op: OperationObject): { required?: string[]; properties?: Record<string, any> } | undefined {
    const content = op.requestBody?.content || {};
    for (const media of Object.values(content)) {
      if (media.schema) {
        return this.resolveSchema(media.schema);
      }
    }
    return undefined;
  }

  private getResponseSchema(op: OperationObject): { required?: string[]; properties?: Record<string, any> } | undefined {
    const responses = op.responses || {};
    for (const code of ["200", "201", "202"]) {
      const resp = responses[code];
      if (resp && resp.content) {
        for (const media of Object.values(resp.content)) {
          if (media.schema) return this.resolveSchema(media.schema);
        }
      }
    }
    return undefined;
  }

  private resolveSchema(schema: any, spec?: OpenApiDocument): any {
    if (schema.$ref && spec?.components?.schemas) {
      const name = schema.$ref.replace("#/components/schemas/", "");
      return spec.components.schemas[name] || schema;
    }
    return schema;
  }

  private findNewName(name: string, properties: Record<string, any>): string | undefined {
    if (properties[name]) return name;
    return Object.keys(properties).find(k => k.toLowerCase() === name.toLowerCase());
  }

  private makeChange(type: BreakingChangeType, path: string, method: string | undefined, description: string, severity: "breaking" | "risky"): BreakingChange {
    return { id: crypto.randomUUID(), type, path, method, description, severity };
  }
}
