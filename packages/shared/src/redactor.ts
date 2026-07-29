
const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey|secret|token|password|private[_-]?key|auth)\s*[:=]\s*['"`][a-zA-Z0-9_\-+/=]{8,}['"`]/gi,
  /bearer\s+[a-zA-Z0-9_\-+/=]{8,}/gi,
  /ghp_[a-zA-Z0-9]{36}/gi,
  /gho_[a-zA-Z0-9]{36}/gi,
  /ghs_[a-zA-Z0-9]{36}/gi,
  /github_pat_[a-zA-Z0-9_]{22,}/gi,
  /sk-[a-zA-Z0-9]{48}/gi
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, "[REDACTED]"), text);
}

export function containsSecrets(text: string): boolean {
  return SECRET_PATTERNS.some(p => p.test(text));
}
