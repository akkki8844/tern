
import { BreakingChange, AffectedUsage } from "@tern/shared";
import { MigrationInstruction } from "@tern/openapi";
import { Rule } from "./interfaces";

export function getRule(type: string): Rule | undefined {
  return RULES[type];
}

const RULES: Record<string, Rule> = {
  "request-field-renamed": renameFieldRule,
  "response-field-renamed": renameFieldRule,
  "request-field-removed": removeFieldRule,
  "response-field-removed": removeFieldRule,
  "path-parameter-renamed": renameIdentifierRule,
  "sdk-method-renamed": renameIdentifierRule,
  "sdk-import-renamed": renameIdentifierRule,
  "operation-id-removed": renameIdentifierRule,
  "required-parameter-added": nullRule,
  "enum-value-removed": nullRule,
  "type-changed": nullRule,
  "endpoint-removed": nullRule,
  "general": generalRule,
};

function renameFieldRule(change: BreakingChange, usage: AffectedUsage, content: string, instruction?: MigrationInstruction): string | null {
  return applyMappings(instruction, change, content, ["field", "requestBody", "parameter"]);
}

function renameIdentifierRule(change: BreakingChange, usage: AffectedUsage, content: string, instruction?: MigrationInstruction): string | null {
  return applyMappings(instruction, change, content, ["operationId", "endpoint", "pathParameter", "inferred"]);
}

function removeFieldRule(change: BreakingChange, usage: AffectedUsage, content: string): string | null {
  const names = extractNamesFromDescription(change.description);
  let result = content;
  let changed = false;
  for (const name of names) {
    const modified = removeField(result, name);
    if (modified !== result) { result = modified; changed = true; }
  }
  return changed ? result : null;
}

function generalRule(change: BreakingChange, usage: AffectedUsage, content: string, instruction?: MigrationInstruction): string | null {
  if (change.path === "servers") {
    return applyMappings(instruction, change, content, ["server"]);
  }
  return null;
}

function nullRule(_change: BreakingChange, _usage: AffectedUsage, _content: string, _instruction?: MigrationInstruction): string | null { return null; }

function applyMappings(instruction: MigrationInstruction | undefined, change: BreakingChange, content: string, allowedKinds: string[]): string | null {
  const mappings = instruction?.mappings.filter(m => allowedKinds.includes(m.kind)) || extractMappings(change.description);
  let result = content;
  let changed = false;
  for (const { old, new: newName } of mappings) {
    if (old && newName && old !== newName) {
      const modified = safeReplace(result, old, newName);
      if (modified !== result) { result = modified; changed = true; }
    }
  }
  return changed ? result : null;
}

export function safeReplace(content: string, old: string, newName: string): string {
  const escaped = old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\b${escaped}\b`, "g");
  return content.replace(regex, newName);
}

export function removeField(content: string, field: string): string {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Remove field assignments in object literals: { ..., field: value, ... }
  const objectLiteral = new RegExp(`\s*,?\s*\b${escaped}\s*:\s*[^,}]+`, "g");
  const removedFromObject = content.replace(objectLiteral, "");
  if (removedFromObject !== content) return removedFromObject.replace(/\{\s*,/g, "{").replace(/,\s*\}/g, "}");
  // Remove property access usage: obj.field
  const propertyAccess = new RegExp(`\.${escaped}\b`, "g");
  const removedAccess = content.replace(propertyAccess, "");
  if (removedAccess !== content) return removedAccess;
  return content;
}

export function extractMappings(description: string): Array<{ old: string; new: string; kind: string }> {
  const matches = description.match(/\b`?([a-zA-Z_][a-zA-Z0-9_]*)`?\b/g);
  if (!matches || matches.length < 2) return [];
  const unique = [...new Set(matches.map(m => m.replace(/`/g, "")))].filter(m => m.length > 1);
  const mappings: Array<{ old: string; new: string; kind: string }> = [];
  for (let i = 0; i < unique.length - 1; i++) {
    mappings.push({ old: unique[i], new: unique[i + 1], kind: "inferred" });
  }
  return mappings;
}

export function extractNamesFromDescription(description: string): string[] {
  const matches = description.match(/\b`?([a-zA-Z_][a-zA-Z0-9_]*)`?\b/g);
  if (!matches) return [];
  return [...new Set(matches.map(m => m.replace(/`/g, "")))].filter(m => m.length > 1);
}
