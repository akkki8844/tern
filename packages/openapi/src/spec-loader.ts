import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { OpenAPIError, SecurityError, isWithin } from "@tern/shared";
import yaml from "js-yaml";
import { DEFAULT_LIMITS, type AnalysisLimits } from "./limits.js";
import type { OpenApiDocument, SpecLoader } from "./interfaces.js";

/**
 * Keys that must never survive parsing.
 *
 * A YAML or JSON document is untrusted input. `JSON.parse` and `js-yaml` both create
 * `__proto__` as an *own* property rather than mutating the prototype, so they are
 * not directly exploitable — but any downstream code that copies keys with
 * `obj[key] = value` would be. Stripping them at the boundary removes the class of
 * bug entirely rather than relying on every consumer being careful.
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface LoadOptions {
  limits?: AnalysisLimits;
  /**
   * Root directory that local specification paths must stay inside.
   * Required for `DefaultSpecLoader.load` with a filesystem path.
   */
  rootDir?: string;
  /**
   * Remote loading is **off** by default.
   *
   * An OpenAPI document is attacker-influenced data. Fetching a URL because a
   * document contains one turns spec analysis into a server-side request forgery
   * primitive against the worker's network position. Callers that genuinely need it
   * must opt in and supply an explicit host allowlist.
   */
  remote?: {
    allowedHosts: readonly string[];
    timeoutMs?: number;
  };
}

const DEFAULT_REMOTE_TIMEOUT_MS = 10_000;

export class DefaultSpecLoader implements SpecLoader {
  constructor(private readonly options: LoadOptions = {}) {}

  async load(source: string): Promise<OpenApiDocument> {
    const limits = this.options.limits ?? DEFAULT_LIMITS;
    const raw = isRemote(source) ? await this.loadRemote(source, limits) : await this.loadLocal(source, limits);
    return parseSpec(raw, limits);
  }

  private async loadLocal(source: string, limits: AnalysisLimits): Promise<string> {
    const resolved = resolveSpecPath(source, this.options.rootDir);
    const buffer = await readFile(resolved);
    if (buffer.length > limits.maxDocumentBytes) {
      throw new OpenAPIError(`Specification exceeds ${limits.maxDocumentBytes} bytes`, {
        code: "OPENAPI_DOCUMENT_TOO_LARGE",
        details: { bytes: buffer.length, limit: limits.maxDocumentBytes }
      });
    }
    return buffer.toString("utf8");
  }

  private async loadRemote(source: string, limits: AnalysisLimits): Promise<string> {
    const remote = this.options.remote;
    if (!remote) {
      throw new SecurityError("Remote specification loading is disabled", {
        code: "OPENAPI_REMOTE_DISABLED",
        details: { source: redactUrl(source) },
        publicMessage: "Tern does not fetch specifications over the network."
      });
    }

    const url = new URL(source);
    if (url.protocol !== "https:") {
      throw new SecurityError("Remote specifications must be served over HTTPS", {
        code: "OPENAPI_REMOTE_INSECURE",
        details: { protocol: url.protocol }
      });
    }
    // The private-range check runs first, deliberately: an operator must not be able
    // to re-enable SSRF against link-local or internal addresses by allowlisting them.
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (isPrivateHost(hostname)) {
      throw new SecurityError("Remote specification host is a private or loopback address", {
        code: "OPENAPI_REMOTE_PRIVATE_HOST",
        details: { host: hostname }
      });
    }
    if (!remote.allowedHosts.some((allowed) => allowed.replace(/^\[|\]$/g, "") === hostname)) {
      throw new SecurityError("Remote specification host is not allowlisted", {
        code: "OPENAPI_REMOTE_HOST_DENIED",
        details: { host: hostname }
      });
    }

    const response = await fetch(url, {
      redirect: "error",
      headers: { accept: "application/json, application/yaml, text/yaml, text/plain" },
      signal: AbortSignal.timeout(remote.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS)
    });
    if (!response.ok) {
      throw new OpenAPIError(`Failed to fetch specification: HTTP ${response.status}`, {
        code: "OPENAPI_REMOTE_FETCH_FAILED",
        retryable: response.status >= 500,
        details: { status: response.status, host: url.hostname }
      });
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > limits.maxDocumentBytes) {
      throw new OpenAPIError("Remote specification exceeds the size limit", {
        code: "OPENAPI_DOCUMENT_TOO_LARGE",
        details: { bytes: declaredLength }
      });
    }

    const text = await response.text();
    if (text.length > limits.maxDocumentBytes) {
      throw new OpenAPIError("Remote specification exceeds the size limit", {
        code: "OPENAPI_DOCUMENT_TOO_LARGE",
        details: { bytes: text.length }
      });
    }
    return text;
  }
}

/** Parse a specification from an in-memory string. */
export function loadFromString(raw: string, limits: AnalysisLimits = DEFAULT_LIMITS): OpenApiDocument {
  return parseSpec(raw, limits);
}

function parseSpec(raw: string, limits: AnalysisLimits): OpenApiDocument {
  if (raw.length > limits.maxDocumentBytes) {
    throw new OpenAPIError(`Specification exceeds ${limits.maxDocumentBytes} bytes`, {
      code: "OPENAPI_DOCUMENT_TOO_LARGE",
      details: { bytes: raw.length }
    });
  }

  let parsed: unknown;
  try {
    parsed = looksLikeYaml(raw)
      ? // CORE_SCHEMA disables custom tags, so no constructor can be invoked from the
        // document. `json: true` keeps duplicate-key behaviour predictable.
        yaml.load(raw, { schema: yaml.CORE_SCHEMA, json: true })
      : JSON.parse(raw);
  } catch (error) {
    throw new OpenAPIError("Specification is not valid YAML or JSON", {
      code: "OPENAPI_PARSE_FAILED",
      cause: error,
      details: { reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" },
      publicMessage: "The OpenAPI document could not be parsed."
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OpenAPIError("OpenAPI document must be an object", { code: "OPENAPI_NOT_AN_OBJECT" });
  }

  const document = stripForbiddenKeys(parsed, limits) as OpenApiDocument;

  const version = (document as { openapi?: unknown }).openapi;
  if (typeof version !== "string") {
    throw new OpenAPIError("OpenAPI document is missing the `openapi` version field", {
      code: "OPENAPI_VERSION_MISSING"
    });
  }
  if (!/^3\.(0|1)\.\d+$/.test(version)) {
    throw new OpenAPIError(`Unsupported OpenAPI version: ${version}`, {
      code: "OPENAPI_VERSION_UNSUPPORTED",
      details: { version, supported: ["3.0.x", "3.1.x"] },
      publicMessage: "Tern supports OpenAPI 3.0.x and 3.1.x."
    });
  }

  const paths = (document as { paths?: unknown }).paths;
  const webhooks = (document as { webhooks?: unknown }).webhooks;
  if (paths === undefined && webhooks === undefined) {
    // 3.1 allows a document with only `webhooks` or only `components`; 3.0 requires
    // `paths`. Either way, a document with neither has nothing to analyse.
    throw new OpenAPIError("OpenAPI document declares no paths", { code: "OPENAPI_NO_PATHS" });
  }
  if (paths !== undefined && (typeof paths !== "object" || paths === null || Array.isArray(paths))) {
    throw new OpenAPIError("`paths` must be an object", { code: "OPENAPI_PATHS_INVALID" });
  }
  if (paths === undefined) {
    (document as unknown as Record<string, unknown>).paths = {};
  }

  return document;
}

/**
 * Recursively rebuild the parsed value, dropping prototype-polluting keys and
 * counting nodes so an alias-expanded YAML bomb is rejected instead of exhausting
 * memory downstream.
 */
function stripForbiddenKeys(value: unknown, limits: AnalysisLimits, budget = { count: 0 }): unknown {
  budget.count += 1;
  if (budget.count > limits.maxModelNodes) {
    throw new OpenAPIError("Specification expands to too many nodes", {
      code: "OPENAPI_DOCUMENT_TOO_COMPLEX",
      details: { limit: limits.maxModelNodes },
      publicMessage: "The OpenAPI document is too complex for Tern to analyse safely."
    });
  }

  if (Array.isArray(value)) return value.map((entry) => stripForbiddenKeys(entry, limits, budget));
  if (value === null || typeof value !== "object") return value;

  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    result[key] = stripForbiddenKeys(entry, limits, budget);
  }
  // Re-attach a normal prototype so consumers can use ordinary object semantics while
  // the dangerous keys are gone.
  return Object.assign({}, result);
}

/**
 * Resolve a local specification path.
 *
 * When `rootDir` is supplied the resolved path is proven to stay inside it. This
 * replaces a previous implementation that rewrote `+` to `/`, deleted `..` sequences
 * and compared strings — which neither confined the path nor handled symlinks.
 */
export function resolveSpecPath(source: string, rootDir?: string): string {
  if (typeof source !== "string" || source.length === 0) {
    throw new SecurityError("Specification path must be a non-empty string", { code: "OPENAPI_PATH_INVALID" });
  }
  if (source.includes("\0")) {
    throw new SecurityError("Specification path contains a null byte", { code: "OPENAPI_PATH_NULL_BYTE" });
  }

  if (!rootDir) {
    // No root configured: only absolute paths chosen by the operator are accepted, so
    // a relative path from a document can never be used to read arbitrary files.
    if (!isAbsolute(source)) {
      throw new SecurityError("A rootDir is required to resolve a relative specification path", {
        code: "OPENAPI_PATH_ROOT_REQUIRED"
      });
    }
    return resolve(source);
  }

  const root = resolve(rootDir);
  const resolved = resolve(root, source);
  if (!isWithin(root, resolved)) {
    throw new SecurityError("Specification path escapes the configured root", {
      code: "OPENAPI_PATH_ESCAPE",
      details: { rootDir: root }
    });
  }
  return resolved;
}

function isRemote(source: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(source);
}

function looksLikeYaml(raw: string): boolean {
  const trimmed = raw.trimStart();
  return !trimmed.startsWith("{") && !trimmed.startsWith("[");
}

/** Block obvious link-local, loopback and private ranges given as literal hosts. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return true;
  }
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function redactUrl(source: string): string {
  try {
    const url = new URL(source);
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return "invalid-url";
  }
}
