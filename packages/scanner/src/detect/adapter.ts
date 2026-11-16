/**
 * Usage-adapter architecture.
 *
 * An adapter knows how one *shape* of HTTP client code declares its method,
 * path, request body and response. Adapters are small, composable and
 * extensible — adding a new client framework means adding an adapter, not
 * editing a monolithic matcher. Every adapter must produce *evidence*, and an
 * adapter that cannot establish URL evidence must decline the call rather than
 * guess.
 *
 * Built-in adapters, in evaluation order:
 *   1. FetchAdapter          — global `fetch`, `fetch(url, config)`,
 *                              `body: JSON.stringify({...})`
 *   2. AxiosAdapter          — `axios.get(...)`, `axios({url, method})`, and
 *                              `axios.create(...)` instances with baseURL
 *   3. RequestObjectAdapter  — `request({ method: "GET", url: "/users" })`
 *   4. GeneratedClientAdapter — `createUser(...)` imported from an internal
 *                              module or generated SDK import
 *   5. SdkResourceAdapter    — `client.users.getUser(...)`, `usersApi.list(...)`
 *   6. GenericHttpClientAdapter — `.get("/users")` on anything else, but ONLY
 *                              with URL-shaped first-argument evidence
 */
import type { CallRecord, ObjectLiteralRecord, Range, Evidence } from "../model/types.js";
import type { PathPattern } from "../values/eval.js";

export interface HttpCallDetection {
  readonly adapter: string;
  readonly kind: string;
  /** Resolved HTTP method, when the adapter can establish it deterministically. */
  readonly method: string | undefined;
  readonly methodEvidence: ReadonlyArray<Evidence>;
  /** Reconstructed path (with explicit holes), when available. */
  readonly path: PathPattern | undefined;
  readonly pathEvidence: ReadonlyArray<Evidence>;
  /** Request-body object literal, when the adapter can locate one. */
  readonly bodyObject: ObjectLiteralRecord | undefined;
  /** Evidence for how the client/transport was identified. */
  readonly clientEvidence: ReadonlyArray<Evidence>;
  /** Response value convention ("data" wrapper vs raw body). */
  readonly responseConvention: "axios-data" | "fetch-json" | "unknown";
  /** Call range and symbol text for the usage record. */
  readonly range: Range;
  readonly symbol: string;
}

export interface UsageAdapter {
  readonly name: string;
  /** Return a detection when this call matches the adapter's shape, else null. */
  detect(call: CallRecord, ctx: DetectionContext): HttpCallDetection | null;
}

export interface DetectionContext {
  /** True when `fetch` is NOT shadowed and the file does not declare it. */
  isGlobalIdentifier(file: string, scopeId: string, name: string): boolean;
  /** Resolve a root identifier; returns the via-kind of the binding. */
  resolveRoot(file: string, scopeId: string, name: string): {
    via: "local" | "import" | "reexport" | "unresolved" | "external";
    importSpecifier?: string;
    declarationKind?: string;
    initKind?: string;
    /** Raw initialiser callee text when the binding is call-initialised. */
    initText?: string;
  };
  /** Object literal record by id, from the same file analysis. */
  objectById(id: string): ObjectLiteralRecord | undefined;
  /** Instance init info: `const api = axios.create({...})` tracking. */
  instanceInit(file: string, scopeId: string, name: string):
    | { kind: "axios-create"; configObject?: ObjectLiteralRecord }
    | { kind: "new-expression"; className: string }
    | undefined;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"]);

export function isHttpMethod(text: string): boolean {
  return HTTP_METHODS.has(text.toUpperCase());
}

/** Evidence helper. */
export function evidence(kind: string, detail: string, confidence: Evidence["confidence"]): Evidence {
  return { kind, detail, confidence };
}
