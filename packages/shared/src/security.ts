
import { createHash, timingSafeEqual } from "crypto";

const SECRET_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /\b(sk-[a-zA-Z0-9]{20,})\b/g, label: "api_key" },
  { regex: /\b(gh[pousr]_[a-zA-Z0-9]{20,})\b/g, label: "github_token" },
  { regex: /\b([a-zA-Z0-9]{32,}-[a-zA-Z0-9]{10,})\b/g, label: "generic_token" },
  { regex: /\b(AIza[0-9A-Za-z_\-]{35})\b/g, label: "google_token" },
  { regex: /\b(eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*)\b/g, label: "jwt" },
  { regex: /(-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----)/g, label: "private_key" },
  { regex: /\b(password\s*[:=]\s*['"`][^'"`]{4,}['"`])\b/gi, label: "password" },
  { regex: /\b(secret\s*[:=]\s*['"`][^'"`]{4,}['"`])\b/gi, label: "secret" },
  { regex: /\b(api[_-]?key\s*[:=]\s*['"`][^'"`]{4,}['"`])\b/gi, label: "api_key" },
  { regex: /\b(access[_-]?token\s*[:=]\s*['"`][^'"`]{4,}['"`])\b/gi, label: "access_token" },
  { regex: /\b(auth(?:orization)?\s*[:=]\s*['"`][bB]earer\s+[a-zA-Z0-9_\-\.]{8,}['"`])\b/gi, label: "bearer_token" }
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
  if (input.includes("\u0000")) throw new Error("Invalid null byte in path");
  const normalized = input.replace(/\+/g, "/").replace(/\/\/+/g, "/");
  const parts = normalized.split("/").filter(p => p !== "" && p !== ".");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") throw new Error("Path traversal detected");
    resolved.push(part);
  }
  return resolved.join("/");
}

export function isAllowedFileExtension(filePath: string, allowed?: Set<string>): boolean {
  const extensions = allowed ?? new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml"]);
  const lastDot = filePath.lastIndexOf(".");
  const ext = lastDot === -1 ? "" : filePath.slice(lastDot).toLowerCase();
  return extensions.has(ext);
}

export function isExecutableContent(content: string): boolean {
  const dangerous = [
    /\beval\s*\(/,
    /\bnew\s+Function\s*\(/,
    /\bsetInterval\s*\(\s*['"`]/,
    /\bsetTimeout\s*\(\s*['"`]/,
    /\brequire\s*\(\s*['"`]child_process['"`]/,
    /\brequire\s*\(\s*['"`]vm['"`]/,
    /\bspawn\s*\(/,
    /\bexec\s*\(/,
    /\bexecSync\s*\(/,
    /\bprocess\.mainModule/
  ];
  return dangerous.some(p => p.test(content));
}

export function safeShellArg(arg: string): string {
  return arg.replace(/[^a-zA-Z0-9_./:-]/g, "_");
}

export function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
