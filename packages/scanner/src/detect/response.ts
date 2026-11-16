/**
 * Bounded response-usage analysis.
 *
 * Tracks, within one file, which response properties the code actually reads:
 *
 *     const res = await client.get("/users/1");
 *     const { data } = res;
 *     console.log(data.user.email);        // consumes response path user.email
 *
 * The analysis is deliberately bounded:
 * - only local, same-file assignments and destructuring are followed;
 * - alias chains are resolved with a visited set and a depth bound;
 * - a `...rest` destructure is recorded as unknown remaining properties;
 * - values returned from functions are NOT followed across files here — that
 *   is the wrapper-chain expansion's job — and `.then(...)` flows are counted
 *   as untracked (explicitly, in metrics), never guessed.
 */
import type { AccessRecord, Evidence, Scope } from "../model/types.js";
import type { DestructuringAlias, FileAnalysis } from "../ast/analyze.js";
import type { SymbolResolver } from "../symbols/resolve.js";
import { evidence } from "./adapter.js";

export interface ResponseBinding {
  /** Variable name bound to a response of a tracked call. */
  readonly name: string;
  readonly callId: string;
  readonly convention: "axios-data" | "fetch-json" | "unknown";
  readonly scopeId: string;
}

export interface ConsumedAccess {
  /** Property path relative to the response body (wrapper prefixes stripped). */
  readonly path: ReadonlyArray<string>;
  /** Id of the tracked call whose response is consumed. */
  readonly callId: string;
  readonly range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  readonly viaRest: boolean;
  readonly evidence: ReadonlyArray<Evidence>;
}

export interface ResponseFlowResult {
  readonly bindings: ReadonlyArray<ResponseBinding>;
  readonly consumed: ReadonlyArray<ConsumedAccess>;
  readonly untrackedFlows: number;
}

interface BindingEntry {
  name: string;
  callId: string;
  convention: ResponseBinding["convention"];
  scopeId: string;
}

export function analyzeResponseFlow(
  analysis: FileAnalysis,
  trackedCallIds: ReadonlyMap<string, { convention: ResponseBinding["convention"] }>,
  resolver: SymbolResolver
): ResponseFlowResult {
  const bindings: BindingEntry[] = [];
  let untrackedFlows = 0;

  // 1. Direct assignments: `const res = await client.get(...)` — the analyzer
  //    recorded `assignsTo` on the call itself.
  for (const call of analysis.calls) {
    if (!call.assignsTo) continue;
    const tracked = trackedCallIds.get(call.id);
    if (tracked) {
      bindings.push({ name: call.assignsTo, callId: call.id, convention: tracked.convention, scopeId: call.scopeId });
    }
  }

  // 2. `const body = await res.json()` for fetch-style responses.
  const jsonRoots = new Map<string, { root: string; scopeId: string }>();
  for (const decl of analysis.declarations) {
    if (decl.kind !== "variable" || !decl.init || decl.init.kind !== "call") continue;
    const callee = decl.init.calleeText;
    const memberMatch = /^([A-Za-z_$][\w$]*)\.json$/.exec(callee);
    if (!memberMatch) continue;
    const rootBinding = bindings.find((b) => b.name === memberMatch[1] && scopeContains(analysis, b.scopeId, decl.scopeId));
    if (rootBinding && rootBinding.convention === "fetch-json") {
      jsonRoots.set(decl.name, { root: rootBinding.name, scopeId: decl.scopeId });
      bindings.push({ name: decl.name, callId: rootBinding.callId, convention: "fetch-json", scopeId: decl.scopeId });
    }
  }

  // 3. `.then(...)` flows: counted as explicitly untracked.
  for (const call of analysis.calls) {
    if (call.callee.length >= 2 && call.callee[call.callee.length - 1].text === "then") {
      untrackedFlows += 1;
    }
  }

  // 4. Destructuring/alias bindings over response roots.
  //    `const { data } = res` → alias `data` maps to response root `res` + path ['data'].
  const aliases: Array<DestructuringAlias & { resolvedRoot?: string; rootCallId?: string; convention?: ResponseBinding["convention"] }> = [];
  for (const alias of analysis.destructuringAliases) {
    const sourceName = headIdentifier(alias.sourceText);
    if (sourceName === null) continue;
    const root = bindings.find((b) => b.name === sourceName && scopeContains(analysis, b.scopeId, alias.scopeId));
    if (root) {
      aliases.push({ ...alias, resolvedRoot: root.name, rootCallId: root.callId, convention: root.convention });
    }
  }

  // 5. Consume access chains: `data.user.email` where `data` resolves to a
  //    response binding.
  const consumed: ConsumedAccess[] = [];
  for (const access of analysis.accesses) {
    const resolution = resolveAccessRoot(access, analysis, bindings, aliases, jsonRoots, resolver);
    if (resolution === null) continue;
    const { root, prefix, convention, callId, viaAliasPath, viaRest } = resolution;
    let segments = access.segments.map((s) => s.text);
    // Wrapper conventions: axios responses carry the payload under `data`.
    if (convention === "axios-data" && segments[0] === "data") segments = segments.slice(1);
    else if (convention === "unknown" && segments[0] === "data") segments = segments.slice(1);
    // fetch-json: the binding IS the body (after `.json()`); nothing to strip.
    const path = [...viaAliasPath, ...segments];
    consumed.push({
      path,
      callId,
      range: access.range,
      viaRest,
      evidence: [
        evidence(
          "response-access",
          `reads response property '${path.join(".")}' of the call at line ${callLine(analysis, callId)} (binding '${root}'${prefix ? ` via ${prefix}` : ""})`,
          "HIGH"
        )
      ]
    });
  }

  return {
    bindings: bindings.map((b) => ({ name: b.name, callId: b.callId, convention: b.convention, scopeId: b.scopeId })),
    consumed,
    untrackedFlows
  };
}

interface AccessResolution {
  readonly root: string;
  readonly callId: string;
  readonly convention: ResponseBinding["convention"];
  readonly prefix: string;
  readonly viaAliasPath: ReadonlyArray<string>;
  readonly viaRest: boolean;
}

function resolveAccessRoot(
  access: AccessRecord,
  analysis: FileAnalysis,
  bindings: ReadonlyArray<BindingEntry>,
  aliases: ReadonlyArray<DestructuringAlias & { resolvedRoot?: string; rootCallId?: string; convention?: ResponseBinding["convention"] }>,
  jsonRoots: ReadonlyMap<string, { root: string; scopeId: string }>,
  _resolver: SymbolResolver
): AccessResolution | null {
  // Direct binding.
  const direct = bindings.find((b) => b.name === access.rootIdentifier && scopeContains(analysis, b.scopeId, access.scopeId));
  if (direct) {
    return { root: direct.name, callId: direct.callId, convention: direct.convention, prefix: "", viaAliasPath: [], viaRest: false };
  }
  // json() result binding.
  const jsonRoot = jsonRoots.get(access.rootIdentifier);
  if (jsonRoot) {
    const base = bindings.find((b) => b.name === jsonRoot.root);
    if (base) {
      return { root: base.name, callId: base.callId, convention: "fetch-json", prefix: `${jsonRoot.root}.json()`, viaAliasPath: [], viaRest: false };
    }
  }
  // Alias chain, bounded.
  const visited = new Set<string>([access.rootIdentifier]);
  let current = access.rootIdentifier;
  let viaAliasPath: string[] = [];
  let viaRest = false;
  for (let depth = 0; depth < 8; depth++) {
    const alias = aliases.find((a) => a.name === current && scopeContains(analysis, a.scopeId, access.scopeId));
    if (!alias) break;
    if (alias.rest) {
      viaRest = true;
      // A rest binding holds unknown remaining properties; the path is opaque.
      return alias.rootCallId
        ? { root: alias.resolvedRoot!, callId: alias.rootCallId, convention: alias.convention ?? "unknown", prefix: `...${alias.name}`, viaAliasPath: [], viaRest: true }
        : null;
    }
    viaAliasPath = [...alias.path, ...viaAliasPath];
    const nextName = alias.resolvedRoot ?? headIdentifier(alias.sourceText);
    if (nextName === null || visited.has(nextName)) break;
    visited.add(nextName);
    const directBinding = bindings.find((b) => b.name === nextName && scopeContains(analysis, b.scopeId, access.scopeId));
    if (directBinding) {
      return {
        root: directBinding.name,
        callId: directBinding.callId,
        convention: directBinding.convention,
        prefix: alias.name,
        viaAliasPath,
        viaRest
      };
    }
    const nextJson = jsonRoots.get(nextName);
    if (nextJson) {
      const base = bindings.find((b) => b.name === nextJson.root);
      if (base) {
        return {
          root: base.name,
          callId: base.callId,
          convention: "fetch-json",
          prefix: alias.name,
          viaAliasPath,
          viaRest
        };
      }
    }
    current = nextName;
  }
  return null;
}

function headIdentifier(text: string): string | null {
  const match = /^([A-Za-z_$][\w$]*)/.exec(text.trim());
  return match ? match[1] : null;
}

function scopeContains(analysis: FileAnalysis, ancestorId: string, descendantId: string): boolean {
  if (ancestorId === descendantId) return true;
  let current: string | undefined = descendantId;
  const byId = new Map(analysis.scopes.map((s) => [s.id, s]));
  while (current) {
    const scope: Scope | undefined = byId.get(current);
    if (!scope) return false;
    if (scope.id === ancestorId) return true;
    current = scope.parent;
  }
  return false;
}

function callLine(analysis: FileAnalysis, callId: string): number {
  const call = analysis.calls.find((c) => c.id === callId);
  return call ? call.range.startLine + 1 : 0;
}
