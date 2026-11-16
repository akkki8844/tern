/**
 * Secret redaction.
 *
 * Two layers exist:
 *  1. `Secret` (see secret.ts) prevents configured secrets from being stringified.
 *  2. The helpers here defend against secrets that arrive from *outside* the config
 *     system — repository contents, provider responses, subprocess output, webhook
 *     payloads — where we cannot control the shape of the data.
 */

interface SecretPattern {
  readonly regex: RegExp;
  readonly label: string;
}

/**
 * Patterns are intentionally conservative: they must not rewrite ordinary source code.
 * Every pattern is anchored on a recognisable prefix or an explicit assignment.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |PKCS8 )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |PKCS8 )?PRIVATE KEY-----/g, label: "PRIVATE_KEY" },
  { regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, label: "GITHUB_TOKEN" },
  { regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: "GITHUB_TOKEN" },
  { regex: /\bv1\.[a-f0-9]{40}\b/g, label: "GITHUB_TOKEN" },
  { regex: /\bfw_[A-Za-z0-9]{16,}\b/g, label: "FIREWORKS_KEY" },
  { regex: /\bsk-[A-Za-z0-9_-]{16,}\b/g, label: "API_KEY" },
  { regex: /\bAKIA[0-9A-Z]{16}\b/g, label: "AWS_ACCESS_KEY_ID" },
  { regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: "GOOGLE_API_KEY" },
  { regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: "JWT" },
  { regex: /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@/gi, label: "DATABASE_URL" },
  { regex: /\b(?:authorization|auth)\s*[:=]\s*["'`]?(?:bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{8,}["'`]?/gi, label: "AUTHORIZATION" },
  { regex: /\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|webhook[_-]?secret|session[_-]?secret|encryption[_-]?key|password|passwd|secret)\s*[:=]\s*["'`][^"'`\n]{6,}["'`]/gi, label: "CREDENTIAL" }
];

/** Replace anything that looks like a credential with a labelled placeholder. */
export function redactSecrets(input: string): string {
  if (!input) return input;
  let output = input;
  for (const { regex, label } of SECRET_PATTERNS) {
    output = output.replace(regex, `[REDACTED:${label}]`);
  }
  return output;
}

/** True when the text contains something that looks like a credential. */
export function containsSecret(input: string): boolean {
  return SECRET_PATTERNS.some(({ regex }) => {
    regex.lastIndex = 0;
    return regex.test(input);
  });
}

const SENSITIVE_KEY_RE =
  /(token|secret|password|passwd|credential|private[_-]?key|api[_-]?key|apikey|authorization|cookie|session|signature|encryption[_-]?key|connection[_-]?string|database[_-]?url)/i;

const MAX_DEPTH = 6;
const MAX_STRING_LENGTH = 4_000;

/**
 * Deeply redact an arbitrary value for logging:
 *  - keys that look sensitive are replaced wholesale
 *  - string values are scanned for credential patterns
 *  - long strings are truncated (repository content must never fill the log pipeline)
 *  - cycles and excessive depth are handled explicitly
 */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    const redacted = redactSecrets(value);
    return redacted.length > MAX_STRING_LENGTH ? `${redacted.slice(0, MAX_STRING_LENGTH)}…[truncated]` : redacted;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value;
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return value.toString();

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactSecrets(value.message) };
  }

  if (depth >= MAX_DEPTH) return "[MaxDepth]";

  if (typeof value === "object") {
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);

    // Objects that opt into their own redacted serialisation (e.g. Secret).
    const maybeToJSON = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof maybeToJSON === "function" && !Array.isArray(value)) {
      try {
        const serialised = maybeToJSON.call(value);
        if (typeof serialised === "string") return redactSecrets(serialised);
      } catch {
        return "[Unserialisable]";
      }
    }

    if (Array.isArray(value)) {
      return value.slice(0, 100).map((item) => redactValue(item, depth + 1, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? "[REDACTED]" : redactValue(item, depth + 1, seen);
    }
    return out;
  }

  return "[Unknown]";
}
