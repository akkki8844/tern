import { OpenAPIError } from "@tern/shared";

/**
 * JSON pointer and `$ref` handling.
 *
 * Tern resolves **internal** references only. External references — another file, a
 * URL, anything that is not a fragment rooted at the current document — are never
 * fetched. See `docs/openapi.md` (security model) for why: following a `$ref` because
 * a document contains a URL turns spec analysis into a server-side request forgery
 * primitive.
 */

/** Escape a path segment for use in an RFC 6901 JSON pointer. */
export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Build a pointer from a base pointer and additional segments. */
export function pointer(base: string, ...segments: (string | number)[]): string {
  const suffix = segments.map((s) => escapePointerSegment(String(s))).join("/");
  if (suffix === "") return base;
  return base === "#" ? `#/${suffix}` : `${base}/${suffix}`;
}

export type RefKind =
  | { kind: "internal"; segments: string[] }
  | { kind: "external"; reason: "remote" | "file" | "malformed" };

/**
 * Classify a `$ref`. Anything that is not a self-document fragment is external and
 * will not be resolved.
 */
export function classifyRef(ref: string): RefKind {
  if (typeof ref !== "string" || ref.length === 0) {
    return { kind: "external", reason: "malformed" };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) {
    // Has a URI scheme (http:, https:, file:, urn:, …).
    return { kind: "external", reason: "remote" };
  }
  if (!ref.startsWith("#")) {
    // Relative file reference such as `common.yaml#/components/schemas/Error`.
    return { kind: "external", reason: "file" };
  }
  if (ref === "#") {
    return { kind: "external", reason: "malformed" };
  }
  if (!ref.startsWith("#/")) {
    return { kind: "external", reason: "malformed" };
  }
  const segments = ref
    .slice(2)
    .split("/")
    .map(unescapePointerSegment);
  if (segments.some((segment) => segment.length === 0)) {
    return { kind: "external", reason: "malformed" };
  }
  return { kind: "internal", segments };
}

/**
 * Resolve an internal pointer against the document.
 *
 * Uses own-property access only, so a document containing `__proto__` or
 * `constructor` cannot walk into `Object.prototype`.
 */
export function resolvePointer(document: unknown, segments: readonly string[]): unknown {
  let current: unknown = document;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export interface ResolvedRef {
  /** The object the ref points at. */
  target: Record<string, unknown>;
  /** Canonical pointer of the final target, after following any ref chain. */
  pointer: string;
}

/**
 * Follow a `$ref` chain to its target.
 *
 * Returns `null` for external references (which are represented explicitly rather
 * than fetched) and throws for a chain that is circular with no content or that
 * points at nothing — both are malformed documents, and guessing would violate the
 * "never silently guess" rule.
 */
export function followRef(
  document: Record<string, unknown>,
  ref: string,
  maxChain: number
): ResolvedRef | null {
  const seen = new Set<string>();
  let currentRef = ref;

  for (let hop = 0; hop <= maxChain; hop += 1) {
    const classified = classifyRef(currentRef);
    if (classified.kind === "external") return null;

    const canonical = `#/${classified.segments.map(escapePointerSegment).join("/")}`;
    if (seen.has(canonical)) {
      throw new OpenAPIError(`Circular $ref chain with no target: ${ref}`, {
        code: "OPENAPI_REF_CYCLE",
        details: { ref, chain: [...seen] },
        publicMessage: "The OpenAPI document contains a circular reference that cannot be resolved."
      });
    }
    seen.add(canonical);

    const target = resolvePointer(document, classified.segments);
    if (target === undefined) {
      throw new OpenAPIError(`$ref does not resolve: ${currentRef}`, {
        code: "OPENAPI_REF_UNRESOLVED",
        details: { ref: currentRef },
        publicMessage: "The OpenAPI document contains a reference that does not resolve."
      });
    }
    if (target === null || typeof target !== "object" || Array.isArray(target)) {
      throw new OpenAPIError(`$ref must point at an object: ${currentRef}`, {
        code: "OPENAPI_REF_INVALID_TARGET",
        details: { ref: currentRef }
      });
    }

    const record = target as Record<string, unknown>;
    const next = record.$ref;
    if (typeof next === "string") {
      currentRef = next;
      continue;
    }
    return { target: record, pointer: canonical };
  }

  throw new OpenAPIError(`$ref chain longer than ${maxChain} hops: ${ref}`, {
    code: "OPENAPI_REF_CHAIN_TOO_LONG",
    details: { ref, maxChain }
  });
}
