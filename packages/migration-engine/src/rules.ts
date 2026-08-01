
import { BreakingChange, AffectedUsage } from "@tern/shared";
import { MigrationInstruction } from "@tern/openapi";


export function getRule(type: string): RuleFunction | undefined {
  return RULES[type];
}

export type RuleFunction = (change: BreakingChange, usage: AffectedUsage, fileContent: string, instruction?: MigrationInstruction) => string | null;

const RULES: Record<string, RuleFunction> = {
  "request-field-renamed": renameFieldRule,
  "response-field-renamed": renameFieldRule,
  "request-field-removed": removeFieldRule,
  "response-field-removed": removeFieldRule,
  "path-parameter-renamed": renameIdentifierRule,
  "sdk-method-renamed": renameIdentifierRule,
  "sdk-import-renamed": renameIdentifierRule,
  "operation-id-removed": renameIdentifierRule,
  "required-parameter-added": addRequiredParameterRule,
  "enum-value-removed": removeEnumValueRule,
  "type-changed": typeChangedRule,
  "endpoint-removed": endpointRemovedRule,
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

function addRequiredParameterRule(change: BreakingChange, usage: AffectedUsage, content: string, instruction?: MigrationInstruction): string | null {
  // Extract parameter name from description or mappings
  const mappings = instruction?.mappings || extractMappings(change.description);
  if (mappings.length === 0) return null;

  const paramName = mappings[0].new;
  if (!paramName) return null;

  // Look for function call patterns and add the parameter
  const lines = content.split("\n");
  let modified = false;
  const result = lines.map((line, index) => {
    // Check if this line contains the affected function call
    if (index + 1 === usage.line || line.includes(usage.functionName)) {
      // Try to add parameter to object literal
      const objectMatch = line.match(/(\{[^}]*)(}\s*\)?\s*;?\s*$)/);
      if (objectMatch) {
        modified = true;
        const prefix = objectMatch[1];
        const suffix = objectMatch[2];
        // Add parameter with TODO placeholder
        const separator = prefix.trim().endsWith(",") ? " " : ", ";
        return `${prefix}${separator}${paramName}: /* TODO: provide required value */,${suffix}`;
      }

      // Try to add parameter to function arguments
      const funcMatch = line.match(/(\w+\s*\([^)]*)(\)\s*;?\s*$)/);
      if (funcMatch) {
        modified = true;
        const prefix = funcMatch[1];
        const suffix = funcMatch[2];
        const separator = prefix.trim().endsWith(",") ? " " : ", ";
        return `${prefix}${separator}${paramName}: /* TODO: provide required value */${suffix}`;
      }
    }
    return line;
  });

  return modified ? result.join("\n") : null;
}

function removeEnumValueRule(change: BreakingChange, usage: AffectedUsage, content: string, instruction?: MigrationInstruction): string | null {
  // Extract enum values from description
  const removedMatch = change.description.match(/removed.*?:\s*([^.]*)/i);
  if (!removedMatch) return null;

  const removedValues = removedMatch[1].split(",").map(v => v.trim()).filter(Boolean);
  if (removedValues.length === 0) return null;

  let result = content;
  let changed = false;

  for (const value of removedValues) {
    // Remove enum value assignments or comparisons
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Remove from string literals: 'value' or "value"
    const stringLiteral = new RegExp(`['"\`]${escaped}['"\`]`, "g");
    const removedStrings = result.replace(stringLiteral, "/* TODO: removed enum value */");
    if (removedStrings !== result) {
      result = removedStrings;
      changed = true;
    }

    // Remove from object properties: key: 'value'
    const propertyPattern = new RegExp(`(\\w+\\s*:\\s*)['"\`]${escaped}['"\`]`, "g");
    const removedProperties = result.replace(propertyPattern, "$1/* TODO: removed enum value */");
    if (removedProperties !== result) {
      result = removedProperties;
      changed = true;
    }

    // Remove from switch cases: case 'value':
    const switchCase = new RegExp(`case\\s+['"\`]${escaped}['"\`]\\s*:`, "g");
    const removedCases = result.replace(switchCase, "/* TODO: removed enum value */ case 'REMOVED':");
    if (removedCases !== result) {
      result = removedCases;
      changed = true;
    }
  }

  return changed ? result : null;
}

function typeChangedRule(change: BreakingChange, usage: AffectedUsage, content: string, instruction?: MigrationInstruction): string | null {
  // Extract type change information from description
  const typeMatch = change.description.match(/type changed from (\w+) to (\w+)/i);
  if (!typeMatch) return null;

  const [, oldType, newType] = typeMatch;
  const lines = content.split("\n");
  let modified = false;

  const result = lines.map((line, index) => {
    // Check if this line contains the affected field
    if (index + 1 === usage.line || line.includes(usage.functionName)) {
      // Handle common type conversions
      if (oldType === "string" && newType === "number") {
        // Add Number() conversion
        const stringToNumber = line.replace(
          /(\w+)\s*=\s*['"`]([^'"`]*)['"`]/,
          "$1 = Number($2)"
        );
        if (stringToNumber !== line) {
          modified = true;
          return stringToNumber;
        }
      } else if (oldType === "number" && newType === "string") {
        // Add String() conversion
        const numberToString = line.replace(
          /(\w+)\s*=\s*(\d+)/,
          "$1 = String($2)"
        );
        if (numberToString !== line) {
          modified = true;
          return numberToString;
        }
      } else if (oldType === "boolean" && newType === "string") {
        // Add String() conversion
        const boolToString = line.replace(
          /(\w+)\s*=\s*(true|false)/,
          "$1 = String($2)"
        );
        if (boolToString !== line) {
          modified = true;
          return boolToString;
        }
      }
    }
    return line;
  });

  return modified ? result.join("\n") : null;
}

function endpointRemovedRule(change: BreakingChange, usage: AffectedUsage, content: string, instruction?: MigrationInstruction): string | null {
  // Extract endpoint information
  const endpoint = change.path;
  if (!endpoint) return null;

  const lines = content.split("\n");
  let modified = false;

  const result = lines.map((line, index) => {
    // Check if this line contains the endpoint call
    if (index + 1 === usage.line || line.includes(endpoint)) {
      // Comment out the endpoint call
      if (line.trim().startsWith("//") || line.trim().startsWith("/*")) {
        return line; // Already commented
      }

      // Add deprecation comment
      modified = true;
      const indent = line.match(/^(\s*)/)?.[1] || "";
      return `${indent}/* TODO: Endpoint ${endpoint} has been removed */\n${line}`;
    }
    return line;
  });

  return modified ? result.join("\n") : null;
}

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
  const regex = new RegExp(`\\b${escaped}\\b`, "g");
  return content.replace(regex, newName);
}

export function removeField(content: string, field: string): string {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Remove field assignments in object literals: { ..., field: value, ... }
  const objectLiteral = new RegExp(`\\s*,?\\s*\\b${escaped}\\s*:\\s*[^,}]+`, "g");
  const removedFromObject = content.replace(objectLiteral, "");
  if (removedFromObject !== content) return removedFromObject.replace(/\{\s*,/g, "{").replace(/,\s*\}/g, "}");
  // Remove property access usage: obj.field
  const propertyAccess = new RegExp(`\\.${escaped}\\b`, "g");
  const removedAccess = content.replace(propertyAccess, "");
  if (removedAccess !== content) return removedAccess;
  return content;
}

export function extractMappings(description: string): Array<{ old: string; new: string; kind: string }> {
  // Look for patterns like "Rename X to Y" or "X renamed to Y"
  const renameMatch = description.match(/(?:rename|renamed)\s+(\w+)\s+to\s+(\w+)/i);
  if (renameMatch) {
    return [{ old: renameMatch[1], new: renameMatch[2], kind: "inferred" }];
  }

  // Look for patterns like "X changed to Y"
  const changeMatch = description.match(/(\w+)\s+changed\s+to\s+(\w+)/i);
  if (changeMatch) {
    return [{ old: changeMatch[1], new: changeMatch[2], kind: "inferred" }];
  }

  // Look for patterns like "Remove field X" or "X removed from Y"
  const removeFieldMatch = description.match(/(?:remove|removed)\s+(?:field|parameter)\s+(\w+)/i);
  if (removeFieldMatch) {
    return [{ old: removeFieldMatch[1], new: "", kind: "field" }];
  }

  // Look for patterns like "X removed"
  const removeMatch = description.match(/(\w+)\s+removed/i);
  if (removeMatch) {
    return [{ old: removeMatch[1], new: "", kind: "field" }];
  }

  // Look for patterns like "Add required parameter X" or "Add X"
  const addParamMatch = description.match(/(?:add|added)\s+(?:required\s+)?(?:parameter|field)\s+(\w+)/i);
  if (addParamMatch) {
    return [{ old: "", new: addParamMatch[1], kind: "field" }];
  }

  // Look for patterns like "X added"
  const addMatch = description.match(/(\w+)\s+added/i);
  if (addMatch) {
    return [{ old: "", new: addMatch[1], kind: "field" }];
  }

  // Fallback: extract words and create mappings
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
