import {
  SecurityError,
  containsSecret,
  isForbiddenPath,
  isSourceFile,
  normalizeRelativePath,
  redactSecrets,
  type AIMigrationRequest,
  type AffectedUsage,
  type BreakingChange
} from "@tern/shared";

/** Lines of surrounding context included on each side of the affected line. */
export const DEFAULT_CONTEXT_LINES = 25;
/** Hard cap on the excerpt, independent of the provider prompt budget. */
export const MAX_EXCERPT_CHARS = 8_000;

export interface BuildContextInput {
  breakingChange: BreakingChange;
  usage: AffectedUsage;
  /** Full content of the single file the usage lives in. */
  fileContent: string;
  contextLines?: number;
}

/**
 * Build the minimal context an AI provider is allowed to see.
 *
 * Enforced properties (all covered by tests):
 *  - exactly one file is ever referenced, never a repository or a directory
 *  - the file must be a source file and must not match a forbidden path
 *    (.env, .git, keys, credentials, node_modules, …)
 *  - only a bounded window of lines around the affected call site is included
 *  - the excerpt is redacted, and refused outright if a credential survives redaction
 *  - the excerpt is truncated to a hard character cap
 */
export function buildMigrationContext(input: BuildContextInput): AIMigrationRequest {
  const filePath = normalizeRelativePath(input.usage.file);

  if (isForbiddenPath(filePath)) {
    throw new SecurityError("Refusing to send a sensitive file to an AI provider", {
      code: "AI_CONTEXT_FORBIDDEN_PATH",
      details: { filePath }
    });
  }
  if (!isSourceFile(filePath)) {
    throw new SecurityError("Refusing to send a non-source file to an AI provider", {
      code: "AI_CONTEXT_NOT_SOURCE",
      details: { filePath }
    });
  }

  const contextLines = input.contextLines ?? DEFAULT_CONTEXT_LINES;
  const lines = input.fileContent.split("\n");
  const zeroBased = Math.max(0, Math.min(lines.length - 1, input.usage.line - 1));
  const start = Math.max(0, zeroBased - contextLines);
  const end = Math.min(lines.length, zeroBased + contextLines + 1);

  let excerpt = redactSecrets(lines.slice(start, end).join("\n"));

  if (containsSecret(excerpt)) {
    throw new SecurityError("Excerpt still contains credential-like content after redaction", {
      code: "AI_CONTEXT_SECRET_DETECTED",
      details: { filePath }
    });
  }

  if (excerpt.length > MAX_EXCERPT_CHARS) {
    excerpt = `${excerpt.slice(0, MAX_EXCERPT_CHARS)}\n// … excerpt truncated by Tern`;
  }

  return {
    breakingChange: {
      type: input.breakingChange.type,
      description: input.breakingChange.description,
      path: input.breakingChange.path,
      method: input.breakingChange.method,
      operationId: input.breakingChange.operationId,
      migrationHint: input.breakingChange.migrationHint
    },
    usage: {
      file: filePath,
      line: input.usage.line,
      column: input.usage.column,
      functionName: input.usage.functionName,
      confidence: input.usage.confidence
    },
    excerpt,
    excerptStartLine: start + 1,
    language: /\.(tsx?|mts|cts)$/.test(filePath) ? "typescript" : "javascript"
  };
}
