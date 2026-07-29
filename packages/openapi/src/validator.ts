
import { OpenApiDocument, SpecValidator, ValidationIssue } from "./interfaces";

export class DefaultSpecValidator implements SpecValidator {
  async validate(spec: OpenApiDocument): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    if (!spec.openapi) issues.push({ type: "error", message: "Missing openapi field", path: "openapi" });
    if (!spec.info?.version) issues.push({ type: "error", message: "Missing info.version", path: "info.version" });
    if (!spec.paths || Object.keys(spec.paths).length === 0) issues.push({ type: "warning", message: "No paths defined", path: "paths" });
    for (const [path, item] of Object.entries(spec.paths || {})) {
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        const op = (item as any)[method];
        if (op && !op.operationId) issues.push({ type: "warning", message: `${method.toUpperCase()} ${path} missing operationId`, path: `paths.${path}.${method}` });
      }
    }
    return issues;
  }
}
