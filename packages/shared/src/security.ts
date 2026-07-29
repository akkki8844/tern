
import { createHash } from "crypto";

const SECRET_PATTERNS = [
  { regex: /(sk-[a-zA-Z0-9]{20,})/g, label: "api_key" },
  { regex: /(gh[pousr]_[a-zA-Z0-9]{20,})/g, label: "github_token" },
  { regex: /([a-zA-Z0-9]{32,}-[a-zA-Z0-9]{10,})/g, label: "token" },
  { regex: /(AIza[0-9A-Za-z_\-]{35})/g, label: "google_token" },
  { regex: /(eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*)/g, label: "jwt" },
  { regex: /(-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----)/g, label: "private_key" },
  { regex: /(password\s*[:=]\s*['"`][^'"`]{4,}['"`])/gi, label: "password" },
  { regex: /(secret\s*[:=]\s*['"`][^'"`]{4,}['"`])/gi, label: "secret" },
  { regex: /(api[_-]?key\s*[:=]\s*['"`][^'"`]{4,}['"`])/gi, label: "api_key" },
  { regex: /(access[_-]?token\s*[:=]\s*['"`][^'"`]{4,}['"`])/gi, label: "access_token" }
];

export function redactSecrets(input: string): string {
  let redacted = input;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern.regex, `[REDACTED_${pattern.label.toUpperCase()}]`);
  }
  return redacted;
}

export function hashSensitiveValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function sanitizePath(input: string): string {
  const normalized = input.replace(/\+/g, "/").replace(/\/\/+/g, "/");
  if (normalized.includes("..")) throw new Error("Path traversal detected");
  return normalized;
}

export function isAllowedFileExtension(filePath: string, allowed = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml"])): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return allowed.has(ext);
}

export function isExecutableContent(content: string): boolean {
  const dangerous = [
    /eval\s*\(/,
    /new\s+Function\s*\(/,
    /setInterval\s*\(\s*['"`]/,
    /setTimeout\s*\(\s*['"`]/,
    /require\s*\(\s*['"`]child_process['"`]/,
    /require\s*\(\s*['"`]vm['"`]/,
    /spawn\s*\(/,
    /exec\s*\(/,
    /execSync\s*\(/,
    /process\.mainModule/
  ];
  return dangerous.some(p => p.test(content));
}

export function safeShellArg(arg: string): string {
  return arg.replace(/[^a-zA-Z0-9_./:-]/g, "_");
}

export function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
