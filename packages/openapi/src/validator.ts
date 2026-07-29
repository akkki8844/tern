
import { OpenApiDocument, SpecValidator, ValidationIssue, HTTP_METHODS } from "./interfaces";

export class DefaultSpecValidator implements SpecValidator {
  async validate(spec: OpenApiDocument): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    if (!spec.openapi || !spec.openapi.startsWith("3.")) {
      issues.push({ type: "error", message: "Unsupported or missing openapi field", path: "openapi" });
    }
    if (!spec.info || !spec.info.version) {
      issues.push({ type: "error", message: "Missing info.version", path: "info.version" });
    }
    if (!spec.paths || Object.keys(spec.paths).length === 0) {
      issues.push({ type: "warning", message: "No paths defined", path: "paths" });
    }
    for (const [path, item] of Object.entries(spec.paths || {})) {
      if (!path.startsWith("/")) {
        issues.push({ type: "error", message: `Path must start with /: ${path}`, path: `paths.${path}` });
      }
      for (const method of HTTP_METHODS) {
        const op = (item as any)[method];
        if (!op) continue;
        if (!op.operationId) {
          issues.push({ type: "warning", message: `${method.toUpperCase()} ${path} missing operationId`, path: `paths.${path}.${method}` });
        }
        if (op.deprecated) {
          issues.push({ type: "warning", message: `${method.toUpperCase()} ${path} is deprecated`, path: `paths.${path}.${method}` });
        }
      }
    }
    return issues;
  }
}
