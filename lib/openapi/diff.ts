import YAML from "yaml";
import type { BreakingChange } from "@/lib/types";

type OpenApiSpec = {
  paths?: Record<string, Record<string, { operationId?: string; parameters?: Array<{ name: string; in: string; required?: boolean }>; requestBody?: { content?: Record<string, { schema?: { properties?: Record<string, unknown>; required?: string[] } }> }; responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }> }>>;
};

const methods = ["get", "post", "put", "patch", "delete"];

export function parseSpec(input: string): OpenApiSpec {
  const trimmed = input.trim();
  return trimmed.startsWith("{") ? JSON.parse(trimmed) : YAML.parse(trimmed);
}

export function detectBreakingChanges(oldSpecRaw: string, newSpecRaw: string, migrationMap: Record<string, string> = {}): BreakingChange[] {
  const oldSpec = parseSpec(oldSpecRaw);
  const newSpec = parseSpec(newSpecRaw);
  const changes: BreakingChange[] = [];

  const oldPaths = oldSpec.paths ?? {};
  const newPaths = newSpec.paths ?? {};
  const unmatchedNewPaths = new Set(Object.keys(newPaths));
  const removedPathOperations: Array<{ path: string; method: string; operation: NonNullable<OpenApiSpec["paths"]>[string][string] }> = [];

  for (const [path, oldOps] of Object.entries(oldPaths)) {
    const newOps = newPaths[path];
    if (!newOps) {
      changes.push({ type: "removed_endpoint", severity: "high", endpoint: path, oldValue: path, confidence: 0.98 });
      for (const method of methods) {
        const oldOp = oldOps[method as keyof typeof oldOps];
        if (oldOp) {
          removedPathOperations.push({ path, method, operation: oldOp });
        }
      }
      continue;
    }
    unmatchedNewPaths.delete(path);

    for (const method of methods) {
      const oldOp = oldOps[method as keyof typeof oldOps];
      if (!oldOp) continue;
      if (!newOps[method]) {
        const newMethod = methods.find((m) => newOps[m]);
        changes.push({
          type: "changed_http_method",
          severity: "high",
          endpoint: path,
          operationId: oldOp.operationId,
          oldValue: method,
          newValue: newMethod,
          confidence: 0.95,
        });
      }

      const newOp = newOps[method];
      if (!newOp) continue;
      compareOperations(oldOp, newOp, path, migrationMap, changes);
    }
  }

  for (const removed of removedPathOperations) {
    const candidateNewPath = [...unmatchedNewPaths].find((path) => newPaths[path]?.[removed.method]);
    if (!candidateNewPath) continue;
    const newOp = newPaths[candidateNewPath]?.[removed.method];
    if (!newOp) continue;
    compareOperations(removed.operation, newOp, candidateNewPath, migrationMap, changes);
    unmatchedNewPaths.delete(candidateNewPath);
  }

  return dedupeChanges(changes);
}

function compareOperations(
  oldOp: NonNullable<OpenApiSpec["paths"]>[string][string],
  newOp: NonNullable<OpenApiSpec["paths"]>[string][string],
  endpoint: string,
  migrationMap: Record<string, string>,
  changes: BreakingChange[],
) {
  if (oldOp.operationId && !newOp.operationId) {
    changes.push({ type: "removed_operation_id", severity: "high", endpoint, operationId: oldOp.operationId, oldValue: oldOp.operationId, confidence: 0.9 });
  }

  const oldParams = oldOp.parameters?.filter((p) => p.in === "path") ?? [];
  const newParams = newOp.parameters?.filter((p) => p.in === "path") ?? [];
  for (const oldParam of oldParams) {
    const exists = newParams.find((p) => p.name === oldParam.name);
    if (!exists && newParams.length === oldParams.length && newParams.length > 0) {
      changes.push({
        type: "renamed_path_parameter",
        severity: "high",
        endpoint,
        operationId: oldOp.operationId,
        oldValue: oldParam.name,
        newValue: newParams[0]?.name,
        confidence: 0.78,
      });
    }
  }

  const oldRequiredParams = oldOp.parameters?.filter((p) => p.required && p.in !== "path") ?? [];
  const newRequiredParams = newOp.parameters?.filter((p) => p.required && p.in !== "path") ?? [];
  for (const oldParam of oldRequiredParams) {
    if (!newRequiredParams.find((p) => p.name === oldParam.name)) {
      changes.push({ type: "removed_required_request_parameter", severity: "medium", endpoint, oldValue: oldParam.name, confidence: 0.82 });
    }
  }
  for (const newParam of newRequiredParams) {
    if (!oldRequiredParams.find((p) => p.name === newParam.name)) {
      changes.push({ type: "added_required_request_parameter", severity: "high", endpoint, newValue: newParam.name, confidence: 0.88 });
    }
  }

  const oldReq = oldOp.requestBody?.content?.["application/json"]?.schema;
  const newReq = newOp.requestBody?.content?.["application/json"]?.schema;
  const oldReqRequired = oldReq?.required ?? [];
  const newReqRequired = newReq?.required ?? [];
  for (const reqField of newReqRequired) {
    if (!oldReqRequired.includes(reqField)) {
      changes.push({ type: "added_required_request_parameter", severity: "high", endpoint, newValue: reqField, confidence: 0.9 });
    }
  }
  const oldReqProps = oldReq?.properties ?? {};
  const newReqProps = newReq?.properties ?? {};
  for (const [oldName, mapped] of Object.entries(migrationMap)) {
    if (oldReqProps[oldName] && newReqProps[mapped]) {
      changes.push({ type: "renamed_request_body_field", severity: "medium", endpoint, oldValue: oldName, newValue: mapped, confidence: 0.86 });
    }
  }

  const oldResp = oldOp.responses?.["200"]?.content?.["application/json"]?.schema?.properties ?? {};
  const newResp = newOp.responses?.["200"]?.content?.["application/json"]?.schema?.properties ?? {};
  for (const field of Object.keys(oldResp)) {
    if (!newResp[field]) {
      const mapped = migrationMap[field];
      if (mapped && newResp[mapped]) {
        changes.push({ type: "renamed_response_field", severity: "medium", endpoint, oldValue: field, newValue: mapped, confidence: 0.8 });
      } else {
        changes.push({ type: "removed_response_field", severity: "high", endpoint, oldValue: field, confidence: 0.9 });
      }
    }
  }
}

function dedupeChanges(changes: BreakingChange[]): BreakingChange[] {
  const seen = new Set<string>();
  return changes.filter((change) => {
    const key = [change.type, change.endpoint, change.oldValue, change.newValue].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
