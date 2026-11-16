/**
 * Bounded static value reconstruction.
 *
 * Reconstructs URL/path string values from literals, template literals and
 * concatenations, following constants and aliases through the symbol table
 * (`const USERS_PATH = "/users"`, `const base = "/users"; ... \`${base}/${id}\``).
 *
 * Everything is bounded: a fixed step budget per value, no function calls are
 * evaluated, no property loads beyond plain identifiers, and anything that
 * cannot be reconstructed becomes an explicit *hole* rather than a guess.
 */
import type { SymbolResolver } from "../symbols/resolve.js";
import type { ArgumentShape, StringPart, SymbolDeclaration } from "../model/types.js";

export type PathSegment =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "hole"; readonly source?: string };

export interface PathPattern {
  /** Reconstructed literal text with holes rendered as `{?}` (display only). */
  readonly display: string;
  readonly segments: ReadonlyArray<PathSegment>;
  /** True when the value starts with an unresolved hole (e.g. `${apiBase}/x`). */
  readonly leadingHole: boolean;
  /** True when every part resolved to literals. */
  readonly complete: boolean;
  /** Query string (`?x=1`) stripped from the tail, if present. */
  readonly queryStripped: boolean;
}

export interface EvalContext {
  readonly file: string;
  readonly scopeId: string;
  readonly resolver: SymbolResolver;
  readonly maxSteps: number;
}

interface Evaluated {
  /** Literal text pieces and holes, in order. */
  readonly segments: ReadonlyArray<PathSegment>;
  readonly anyHole: boolean;
  readonly stepsUsed: number;
}

export function evaluateArgument(arg: ArgumentShape, ctx: EvalContext): Evaluated {
  switch (arg.kind) {
    case "string-literal":
      return literalEval(arg.value, ctx.maxSteps);
    case "template":
      return evaluateParts(arg.parts, ctx);
    case "binary-concat":
      return evaluateParts(arg.parts, ctx);
    case "identifier":
      return evaluateIdentifier(arg.name, ctx, 0);
    default:
      return holeEval(undefined, ctx.maxSteps);
  }
}

function literalEval(text: string, steps: number): Evaluated {
  return { segments: [{ kind: "literal", text }], anyHole: false, stepsUsed: steps + 1 };
}

function holeEval(source: string | undefined, steps: number): Evaluated {
  return { segments: [{ kind: "hole", source }], anyHole: true, stepsUsed: steps + 1 };
}

function evaluateParts(parts: ReadonlyArray<StringPart>, ctx: EvalContext): Evaluated {
  const segments: PathSegment[] = [];
  let anyHole = false;
  let steps = 1;
  for (const part of parts) {
    if (steps > ctx.maxSteps) {
      segments.push({ kind: "hole" });
      anyHole = true;
      continue;
    }
    steps += 1;
    if (part.kind === "static") {
      segments.push({ kind: "literal", text: part.text });
      continue;
    }
    // `${expr}`: resolve plain identifiers through the symbol table; anything
    // else is a hole (we do not interpret expressions).
    const inner = part.text.trim();
    const identifierMatch = /^\(?([A-Za-z_$][\w$]*)\)?$/.exec(inner);
    if (identifierMatch) {
      const resolved = evaluateIdentifier(identifierMatch[1], ctx, steps);
      steps = resolved.stepsUsed;
      segments.push(...resolved.segments);
      if (resolved.anyHole) anyHole = true;
    } else {
      segments.push({ kind: "hole", source: inner });
      anyHole = true;
    }
  }
  return { segments: mergeLiterals(segments), anyHole, stepsUsed: steps };
}

function evaluateIdentifier(name: string, ctx: EvalContext, stepsSoFar: number): Evaluated {
  if (stepsSoFar > ctx.maxSteps) return holeEval(name, stepsSoFar);
  const resolution = ctx.resolver.resolveIdentifier(ctx.file, ctx.scopeId, name);
  const decl = resolution.declaration;
  if (!decl || resolution.via === "external") return holeEval(name, stepsSoFar + 1);
  if (decl.kind === "parameter") return holeEval(name, stepsSoFar + 1);
  return evaluateDeclarationInit(decl, ctx, stepsSoFar + 1, name);
}

function evaluateDeclarationInit(
  decl: SymbolDeclaration,
  ctx: EvalContext,
  steps: number,
  sourceName: string
): Evaluated {
  const init = decl.init;
  if (!init || init.kind === "uninitialized") return holeEval(sourceName, steps);
  switch (init.kind) {
    case "literal":
      return literalEval(init.value, steps);
    case "template":
      return evaluateParts(init.parts, { ...ctx, maxSteps: ctx.maxSteps });
    case "binary-concat":
      return evaluateParts(init.parts, { ...ctx, maxSteps: ctx.maxSteps });
    case "identifier": {
      if (init.target === decl.name) return holeEval(sourceName, steps); // self-reference guard
      return evaluateIdentifier(init.target, ctx, steps);
    }
    default:
      return holeEval(sourceName, steps);
  }
}

function mergeLiterals(segments: ReadonlyArray<PathSegment>): PathSegment[] {
  const out: PathSegment[] = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    if (segment.kind === "literal" && last && last.kind === "literal") {
      out[out.length - 1] = { kind: "literal", text: last.text + segment.text };
    } else {
      out.push(segment);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path pattern extraction
// ---------------------------------------------------------------------------

/** Split query string and normalise trailing slashes; build a PathPattern. */
export function toPathPattern(evaluated: Evaluated): PathPattern | null {
  const segments: PathSegment[] = [];
  let queryStripped = false;
  let anyHole = false;
  for (const segment of evaluated.segments) {
    if (segment.kind === "hole") {
      segments.push(segment);
      anyHole = true;
      continue;
    }
    let text = segment.text;
    const queryIndex = text.indexOf("?");
    if (queryIndex >= 0) {
      text = text.slice(0, queryIndex);
      queryStripped = true;
    }
    if (text === "") continue;
    segments.push({ kind: "literal", text });
  }
  if (segments.length === 0) return null;
  const leadingHole = segments[0].kind === "hole";
  const display = segments
    .map((s) => (s.kind === "literal" ? s.text : s.source !== undefined ? `\${${s.source}}` : "${?}"))
    .join("");
  return { display, segments, leadingHole, complete: !anyHole, queryStripped };
}

/** Does this evaluated value look like an HTTP path or URL at all? */
export function looksLikeHttpPath(pattern: PathPattern): boolean {
  const head = pattern.segments.find((s) => s.kind === "literal" && s.text !== "");
  if (!head || head.kind !== "literal") return false;
  const text = head.text;
  if (text.startsWith("/")) return true;
  if (/^https?:\/\//i.test(text)) return true;
  // A leading hole followed by path-like literals: `${base}/users` — accept
  // only when a later literal segment starts with '/'.
  return pattern.segments.some((s) => s.kind === "literal" && s.text.startsWith("/"));
}

/** Strip a scheme+authority prefix from a URL-shaped value. */
export function stripUrlOrigin(pattern: PathPattern): PathPattern {
  const first = pattern.segments[0];
  if (!first || first.kind !== "literal") return pattern;
  const match = /^https?:\/\/[^/?#]+/i.exec(first.text);
  if (!match) return pattern;
  const rest = first.text.slice(match[0].length);
  const segments = rest === ""
    ? pattern.segments.slice(1)
    : [{ kind: "literal" as const, text: rest }, ...pattern.segments.slice(1)];
  const merged = mergeLiterals(segments.length > 0 ? segments : [{ kind: "literal", text: "/" }]);
  const display = merged.map((s) => (s.kind === "literal" ? s.text : "${?}")).join("");
  return {
    display,
    segments: merged,
    leadingHole: merged.length > 0 ? merged[0].kind === "hole" : false,
    complete: pattern.complete && rest !== "",
    queryStripped: pattern.queryStripped
  };
}
