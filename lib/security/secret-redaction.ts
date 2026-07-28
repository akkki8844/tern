const secretPatterns = [
  /(sk-[a-zA-Z0-9]{20,})/g,
  /(ghp_[a-zA-Z0-9]{20,})/g,
  /(xox[baprs]-[a-zA-Z0-9-]{20,})/g,
  /(AKIA[0-9A-Z]{16})/g,
  /([A-Za-z0-9_\-]{24,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{20,})/g,
];

export function redactLikelySecrets(input: string): string {
  return secretPatterns.reduce((acc, pattern) => acc.replace(pattern, "[REDACTED_SECRET]"), input);
}

export function containsLikelySecret(input: string): boolean {
  return secretPatterns.some((pattern) => pattern.test(input));
}
