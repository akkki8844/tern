import { HTTP_METHODS, type OpenApiDocument, type SpecValidator, type ValidationIssue } from "./interfaces.js";
import { classifyRef, resolvePointer } from "./model/refs.js";

/**
 * Structural validation.
 *
 * This is deliberately not a full JSON Schema validation of the OpenAPI meta-schema.
 * It checks the properties that make a document *analysable* by Tern — reference
 * integrity, identifier uniqueness, path template consistency — because those are the
 * failures that would otherwise turn into a wrong diff rather than a loud error.
 */
export class DefaultSpecValidator implements SpecValidator {
  async validate(spec: OpenApiDocument): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    const document = spec as unknown as Record<string, unknown>;

    if (typeof spec.openapi !== "string" || !/^3\.(0|1)\.\d+$/.test(spec.openapi)) {
      issues.push({ type: "error", message: "Unsupported or missing `openapi` version", path: "openapi" });
    }
    if (!spec.info || typeof spec.info.version !== "string") {
      issues.push({ type: "error", message: "Missing `info.version`", path: "info.version" });
    }
    if (!spec.info || typeof spec.info.title !== "string") {
      issues.push({ type: "error", message: "Missing `info.title`", path: "info.title" });
    }

    const paths = spec.paths ?? {};
    if (Object.keys(paths).length === 0) {
      issues.push({ type: "warning", message: "No paths defined", path: "paths" });
    }

    const operationIds = new Map<string, string>();

    for (const [path, item] of Object.entries(paths)) {
      const pathLabel = `paths.${path}`;
      if (!path.startsWith("/")) {
        issues.push({ type: "error", message: `Path must start with "/": ${path}`, path: pathLabel });
      }

      const templateNames = [...path.matchAll(/\{([^}/]+)\}/g)].map((match) => match[1]);
      const duplicateTemplates = templateNames.filter((name, index) => templateNames.indexOf(name) !== index);
      for (const name of new Set(duplicateTemplates)) {
        issues.push({
          type: "error",
          message: `Path template declares "${name}" more than once`,
          path: pathLabel
        });
      }

      const pathParameters = collectParameterNames(item.parameters);

      for (const method of HTTP_METHODS) {
        const operation = (item as unknown as Record<string, unknown>)[method];
        if (!operation || typeof operation !== "object") continue;
        const op = operation as Record<string, unknown>;
        const opLabel = `${pathLabel}.${method}`;

        if (typeof op.operationId !== "string") {
          issues.push({ type: "warning", message: `${method.toUpperCase()} ${path} has no operationId`, path: opLabel });
        } else {
          const previous = operationIds.get(op.operationId);
          if (previous) {
            issues.push({
              type: "error",
              message: `Duplicate operationId "${op.operationId}" (also on ${previous})`,
              path: opLabel
            });
          } else {
            operationIds.set(op.operationId, `${method.toUpperCase()} ${path}`);
          }
        }

        if (op.deprecated === true) {
          issues.push({ type: "warning", message: `${method.toUpperCase()} ${path} is deprecated`, path: opLabel });
        }

        const declared = new Set([...pathParameters.path, ...collectParameterNames(op.parameters).path]);
        for (const name of templateNames) {
          if (!declared.has(name)) {
            issues.push({
              type: "error",
              message: `Path template "{${name}}" has no matching path parameter`,
              path: opLabel
            });
          }
        }
        for (const name of declared) {
          if (!templateNames.includes(name)) {
            issues.push({
              type: "error",
              message: `Path parameter "${name}" does not appear in the path template`,
              path: opLabel
            });
          }
        }

        const responses = op.responses;
        if (!responses || typeof responses !== "object" || Object.keys(responses).length === 0) {
          issues.push({ type: "error", message: `${method.toUpperCase()} ${path} declares no responses`, path: opLabel });
        }
      }
    }

    issues.push(...validateReferences(document));
    return issues;
  }
}

function collectParameterNames(parameters: unknown): { path: string[]; all: string[] } {
  const result = { path: [] as string[], all: [] as string[] };
  if (!Array.isArray(parameters)) return result;
  for (const entry of parameters) {
    if (!entry || typeof entry !== "object") continue;
    const parameter = entry as Record<string, unknown>;
    if (typeof parameter.name !== "string") continue;
    result.all.push(parameter.name);
    if (parameter.in === "path") result.path.push(parameter.name);
  }
  return result;
}

/**
 * Walk every `$ref` in the document.
 *
 * An unresolvable internal reference is an error: the diff would silently treat the
 * schema as empty. An external reference is a warning: Tern never fetches it, so the
 * target is invisible to the analysis and the operator should know.
 */
function validateReferences(document: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<unknown>();

  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }

    const node = value as Record<string, unknown>;
    const ref = node.$ref;
    if (typeof ref === "string") {
      const classified = classifyRef(ref);
      if (classified.kind === "external") {
        issues.push({
          type: "warning",
          message: `External reference "${ref}" is not resolved by Tern; the target is not analysed`,
          path
        });
      } else if (resolvePointer(document, classified.segments) === undefined) {
        issues.push({ type: "error", message: `Reference "${ref}" does not resolve`, path });
      }
    }

    for (const [key, entry] of Object.entries(node)) {
      if (key === "$ref") continue;
      walk(entry, path === "" ? key : `${path}.${key}`);
    }
  };

  walk(document, "");
  return issues;
}
