import { MigrationPatch, PatchValidator } from "./interfaces.js";
import { redactSecrets } from "@tern/shared";

const FORBIDDEN_PATTERNS = [
  /process\.env\s*=/,
  /eval\s*\(/,
  /Function\s*\(/,
  /child_process/,
  /require\s*\(\s*['"`]\.\./,
  /https?:\/\/\{token\}/,
  /password\s*[:=]/i,
  /secret\s*[:=]/i,
  /api[_-]?key\s*[:=]/i,
  /private[_-]?key\s*[:=]/i,
  /access[_-]?token\s*[:=]/i,
  /token\s*[:=]\s*['"`][a-zA-Z0-9]{8,}/i,
  /spawn\s*\(/,
  /exec\s*\(/,
  /new\s+Function\s*\(/,
  /\.env\b/,
  /crypto\.createPrivateKey/i,
  /ssh/i,
  /(?:base64|hex)\s*\.\s*(?:encode|decode)\s*\(\s*.*\b(secret|password|token|key)\b/i
];

const DISALLOWED_EXTENSIONS = [
  ".lock", ".lockb", ".env", ".env.local", ".env.production", ".env.development",
  ".pem", ".key", ".crt", ".p12", ".pfx", ".json.enc", ".yaml.enc", ".yml.enc"
];

const DISALLOWED_FILENAMES = [
  "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "pnpm-lock.yml",
  ".github/workflows", ".gitlab-ci.yml", ".travis.yml", ".circleci", "azure-pipelines.yml",
  "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "docker-compose.override.yml",
  ".gitignore", ".gitattributes", ".gitmodules", ".gitconfig",
  "tsconfig.json", "jsconfig.json", "Makefile", "makefile", "CMakeLists.txt"
];

const ALLOWED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml"];
const MAX_LINES = 500;
const MAX_FILE_SIZE = 500 * 1024; // 500KB

export class DefaultPatchValidator implements PatchValidator {
  validate(patch: MigrationPatch): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const filePath = patch.filePath.toLowerCase();

    // Reject disallowed file paths
    if (DISALLOWED_FILENAMES.some(name => filePath === name || filePath.includes(`/${name}/`) || filePath.endsWith(`/${name}`))) {
      errors.push(`Disallowed file modified: ${patch.filePath}`);
    }
    const extIndex = patch.filePath.lastIndexOf(".");
    const ext = extIndex >= 0 ? patch.filePath.slice(extIndex).toLowerCase() : "";
    if (ext && !ALLOWED_EXTENSIONS.includes(ext)) {
      errors.push(`File extension not allowed: ${ext}`);
    }
    if (DISALLOWED_EXTENSIONS.some(e => filePath.endsWith(e))) {
      errors.push(`Disallowed file extension in ${patch.filePath}`);
    }

    // Size limits
    const changed = patch.lineCountChanged;
    if (changed > MAX_LINES) errors.push(`Changed lines exceed limit: ${changed} > ${MAX_LINES}`);
    if (Buffer.byteLength(patch.modified, "utf8") > MAX_FILE_SIZE) errors.push(`Modified file exceeds ${MAX_FILE_SIZE} bytes`);
    const originalSize = Buffer.byteLength(patch.original, "utf8");
    const modifiedSize = Buffer.byteLength(patch.modified, "utf8");
    if (modifiedSize > originalSize * 3) warnings.push("Modified file is significantly larger than original");
    if (changed > originalSize / 10) warnings.push("Patch modifies a large fraction of the file");

    // Security: forbidden patterns
    const redacted = redactSecrets(patch.modified);
    if (redacted !== patch.modified) warnings.push("Potential secrets detected in patch; redacted for review");
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(patch.modified)) errors.push(`Forbidden pattern detected: ${pattern.source}`);
    }

    // Detect unrelated edits by comparing original/modified line overlap
    const originalLines = new Set(patch.original.split("\n").filter(Boolean));
    const modifiedLines = new Set(patch.modified.split("\n").filter(Boolean));
    const addedLines = [...modifiedLines].filter(l => !originalLines.has(l));
    const removedLines = [...originalLines].filter(l => !modifiedLines.has(l));
    const unrelated = addedLines.filter(l => !patch.description.toLowerCase().includes(this.extractKeyword(l).toLowerCase()));
    if (unrelated.length > addedLines.length * 0.5) warnings.push("Patch may contain unrelated edits");

    // Ensure diff is valid
    if (patch.diff && !patch.diff.includes("--- a/") && !patch.diff.includes("+++ b/")) {
      warnings.push("Diff does not follow standard unified format");
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  private extractKeyword(line: string): string {
    const keywords = ["payment_method", "customer_id", "source", "status", "state", "memo", "description", "chargeId", "id", "createPayment", "createCharge"];
    const lower = line.toLowerCase();
    return keywords.find(k => lower.includes(k.toLowerCase())) || "";
  }
}
