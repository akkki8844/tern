/**
 * Security primitives shared by every subsystem.
 *
 * These are the building blocks the pipeline relies on to stay safe when handling
 * untrusted input: repository paths, webhook bodies, provider responses and
 * subprocess arguments.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { SecurityError } from "./errors.js";

/** Constant-time string comparison that does not leak length through early exit. */
export function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  // Hash both sides so the comparison is constant time even for different lengths.
  const aHash = createHash("sha256").update(aBuf).digest();
  const bHash = createHash("sha256").update(bBuf).digest();
  return timingSafeEqual(aHash, bHash) && aBuf.length === bBuf.length;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Short, non-reversible fingerprint suitable for logs and correlation. */
export function fingerprint(value: string): string {
  return sha256Hex(value).slice(0, 16);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Normalise a repository-relative path.
 *
 * Rejects: absolute paths, null bytes, traversal (`..`), Windows drive letters and
 * UNC prefixes. Returns a POSIX-style relative path.
 */
export function normalizeRelativePath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new SecurityError("Path must be a non-empty string", { code: "PATH_INVALID" });
  }
  if (input.includes("\0")) {
    throw new SecurityError("Path contains a null byte", { code: "PATH_NULL_BYTE" });
  }
  if (/^[a-zA-Z]:[\\/]/.test(input) || input.startsWith("\\\\")) {
    throw new SecurityError("Absolute Windows paths are not allowed", { code: "PATH_ABSOLUTE" });
  }
  const unix = input.replace(/\\/g, "/");
  if (unix.startsWith("/")) {
    throw new SecurityError("Absolute paths are not allowed", { code: "PATH_ABSOLUTE" });
  }
  const segments: string[] = [];
  for (const segment of unix.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw new SecurityError("Path traversal is not allowed", { code: "PATH_TRAVERSAL" });
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new SecurityError("Path resolves to an empty location", { code: "PATH_EMPTY" });
  }
  return segments.join("/");
}

/**
 * Resolve `relativePath` inside `root` and prove the result stays inside `root`.
 * This is the only sanctioned way to build a filesystem path from untrusted input.
 */
export function resolveWithin(root: string, relativePath: string): string {
  const safeRelative = normalizeRelativePath(relativePath);
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, safeRelative);
  if (!isWithin(absoluteRoot, candidate)) {
    throw new SecurityError("Resolved path escapes its root", {
      code: "PATH_ESCAPE",
      details: { root: absoluteRoot }
    });
  }
  return candidate;
}

/** True when `candidate` is `root` itself or a descendant of it. */
export function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = normalize(resolve(root));
  const normalizedCandidate = normalize(resolve(candidate));
  if (normalizedCandidate === normalizedRoot) return true;
  const rel = relative(normalizedRoot, normalizedCandidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

const DEFAULT_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

export function isSourceFile(path: string, allowed: ReadonlySet<string> = DEFAULT_SOURCE_EXTENSIONS): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return allowed.has(path.slice(dot).toLowerCase());
}

/**
 * Paths Tern must never read into an AI prompt, never patch and never copy into a
 * sandbox. Matching is performed on POSIX-style repository-relative paths.
 */
const FORBIDDEN_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env($|\.|\/)/i,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)secrets?\.(json|ya?ml|toml)$/i,
  /(^|\/)credentials?(\.json|\.ya?ml)?$/i,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.docker(\/|$)/,
  /(^|\/)node_modules(\/|$)/
];

/** True when the path must never be read, patched or shipped to a provider. */
export function isForbiddenPath(repoRelativePath: string): boolean {
  const normalized = repoRelativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return FORBIDDEN_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Validate a value passed to a child process as an argument.
 *
 * Tern never uses a shell, so shell metacharacters are inert — rejecting them would
 * break legitimate arguments (`node -e "console.log(1)"`). What is rejected is what
 * can actually cause harm across an execve boundary: NUL bytes (truncate the string
 * in libc), control characters (log/terminal injection) and unbounded length.
 * Option injection is handled separately by `assertNotOption`.
 */
export function assertSafeProcessArg(arg: string, name = "argument"): string {
  if (typeof arg !== "string" || arg.length === 0 || arg.length > 8192) {
    throw new SecurityError(`Unsafe process ${name}: empty or too long`, { code: "PROCESS_ARG_INVALID" });
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(arg)) {
    throw new SecurityError(`Unsafe process ${name}: contains control characters`, { code: "PROCESS_ARG_INVALID" });
  }
  return arg;
}

const SAFE_COMMAND_RE = /^\/?[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/**
 * Validate the executable name. This one IS strict: the command is the only part of
 * the invocation that selects which program runs, so it must never be derived from
 * repository content in an unconstrained way.
 */
export function assertSafeCommandName(command: string): string {
  if (
    typeof command !== "string" ||
    command.length === 0 ||
    command.length > 256 ||
    command.includes("..") ||
    !SAFE_COMMAND_RE.test(command)
  ) {
    throw new SecurityError("Unsafe process command", { code: "PROCESS_COMMAND_INVALID" });
  }
  return command;
}

/** Reject a value that would be interpreted as an option by the target program. */
export function assertNotOption(value: string, name = "value"): string {
  if (value.startsWith("-")) {
    throw new SecurityError(`Unsafe ${name}: must not start with "-"`, { code: "PROCESS_OPTION_INJECTION" });
  }
  return value;
}

/** Validate a git ref/branch name against the subset of git's rules we need. */
export function assertSafeBranchName(branch: string): string {
  if (
    typeof branch !== "string" ||
    branch.length === 0 ||
    branch.length > 255 ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    /[\s~^:?*[\\\0]/.test(branch)
  ) {
    throw new SecurityError("Invalid git branch name", { code: "BRANCH_NAME_INVALID" });
  }
  return branch;
}

/** Validate a GitHub owner or repository name. */
export function assertGitHubSlug(value: string, kind: "owner" | "repo"): string {
  const pattern = kind === "owner" ? /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/ : /^[A-Za-z0-9._-]{1,100}$/;
  if (!pattern.test(value)) {
    throw new SecurityError(`Invalid GitHub ${kind}`, { code: "GITHUB_SLUG_INVALID" });
  }
  return value;
}
