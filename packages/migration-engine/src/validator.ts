
import { MigrationPatch, PatchValidator } from "./interfaces";

const FORBIDDEN_PATTERNS = [
  /process\.env\s*=/,
  /eval\s*\(/,
  /Function\s*\(/,
  /child_process/,
  /require\s*\(\s*['"`]\.\./,
  /https?:\/\/\{token\}/,
  /password\s*[:=]/i,
  /secret\s*[:=]/i,
  /private_key\s*[:=]/i
];

const ALLOWED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".yml", ".yaml"];
const MAX_LINES = 500;

export class DefaultPatchValidator implements PatchValidator {
  validate(patch: MigrationPatch): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const ext = patch.filePath.slice(patch.filePath.lastIndexOf("."));
    if (!ALLOWED_EXTENSIONS.includes(ext)) errors.push(`File extension not allowed: ${ext}`);
    const changed = patch.lineCountChanged;
    if (changed > MAX_LINES) errors.push(`Changed lines exceed limit: ${changed} > ${MAX_LINES}`);
    const text = patch.modified;
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(text)) errors.push(`Forbidden pattern detected: ${pattern.source}`);
    }
    const diff = patch.diff;
    if (diff.includes("--- a/") && diff.includes("+++ b/")) {
      const lockFiles = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"];
      if (lockFiles.some(f => patch.filePath.includes(f))) errors.push("Lockfile modification not allowed");
    }
    return { valid: errors.length === 0, errors };
  }
}
