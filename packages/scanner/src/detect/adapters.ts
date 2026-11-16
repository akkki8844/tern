/**
 * Built-in usage adapters. See adapter.ts for the contract.
 *
 * Precision rules enforced here:
 * - The FetchAdapter only fires on `fetch` that resolves to the *global* — a
 *   local variable or import named `fetch` shadows it and is not reported.
 * - The AxiosAdapter only fires when the root binding resolves (through the
 *   symbol table) to the `axios` package import or to a variable initialised
 *   from `axios.create(...)`.
 * - The GenericHttpClientAdapter requires URL-shaped first-argument evidence;
 *   `map.get(key)` never matches because `key` is not a reconstructable path.
 * - HTTP methods are read from the source (method segment or config literal);
 *   nothing is inferred from function names alone.
 */
import type { CallRecord, Evidence, ObjectLiteralRecord } from "../model/types.js";
import { type DetectionContext, evidence, type HttpCallDetection, type UsageAdapter } from "./adapter.js";
import type { SymbolResolver } from "../symbols/resolve.js";
import { type PathPattern, evaluateArgument, looksLikeHttpPath, stripUrlOrigin, toPathPattern } from "../values/eval.js";

export interface FullDetectionContext extends DetectionContext {
  readonly file: string;
  readonly resolver: SymbolResolver;
  readonly maxSteps: number;
}

const AXIOS_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "request"]);

function evalPathArg(
  ctx: FullDetectionContext,
  call: CallRecord,
  argIndex: number
): { path: PathPattern | undefined; evidence: Evidence[] } {
  const arg = call.args[argIndex];
  if (!arg) return { path: undefined, evidence: [] };
  const evaluated = evaluateArgument(arg, {
    file: ctx.file,
    scopeId: call.scopeId,
    resolver: ctx.resolver,
    maxSteps: ctx.maxSteps
  });
  const pattern = toPathPattern(evaluated);
  if (pattern === null || !looksLikeHttpPath(pattern)) {
    return {
      path: undefined,
      evidence: [evidence("path-not-static", "first argument is not a statically reconstructable path", "UNKNOWN")]
    };
  }
  const stripped = stripUrlOrigin(pattern);
  const ev: Evidence[] = [];
  if (pattern !== stripped) {
    ev.push(evidence("url-origin-stripped", "absolute URL: scheme and authority discarded, path used for matching", "HIGH"));
  }
  if (!pattern.complete) {
    ev.push(evidence("path-partially-resolved", `path reconstructed with unresolved parts: ${pattern.display}`, "MEDIUM"));
  } else {
    ev.push(evidence("path-literal", `path statically reconstructed as ${stripped.display}`, "HIGH"));
  }
  if (pattern.queryStripped) {
    ev.push(evidence("query-stripped", "query string ignored for path matching", "HIGH"));
  }
  return { path: stripped, evidence: ev };
}

/** `method: "GET"` from an object record; `undefined` when absent/dynamic. */
function methodFromConfig(config: ObjectLiteralRecord | undefined, fallback?: { method: string; why: string }): { method?: string; evidence: Evidence[] } {
  if (!config) {
    return fallback
      ? { method: fallback.method, evidence: [evidence("method-default", fallback.why, "HIGH")] }
      : { evidence: [] };
  }
  const methodProperty = config.properties.find((p) => p.path.length === 1 && p.path[0] === "method");
  if (!methodProperty) {
    return fallback
      ? { method: fallback.method, evidence: [evidence("method-default", fallback.why, "HIGH")] }
      : { evidence: [] };
  }
  if (methodProperty.valueKind === "literal" && methodProperty.literalValue !== undefined) {
    const upper = methodProperty.literalValue.toUpperCase();
    if (HTTP_METHOD_SET.has(upper)) {
      return { method: upper, evidence: [evidence("method-literal", `config method literal is ${upper}`, "HIGH")] };
    }
    return { evidence: [evidence("method-invalid", `config method literal ${methodProperty.literalValue} is not an HTTP method`, "UNKNOWN")] };
  }
  return { evidence: [evidence("method-dynamic", "config `method` is not a literal; method unknown", "UNKNOWN")] };
}

const HTTP_METHOD_SET = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"]);

function argObject(ctx: FullDetectionContext, call: CallRecord, index: number): ObjectLiteralRecord | undefined {
  const arg = call.args[index];
  if (arg && arg.kind === "object") return ctx.objectById(arg.objectId);
  return undefined;
}

function nestedObjectById(ctx: FullDetectionContext, parent: ObjectLiteralRecord, property: string): ObjectLiteralRecord | undefined {
  const prop = parent.properties.find((p) => p.path.length === 1 && p.path[0] === property && p.nestedObjectId !== undefined);
  if (!prop) return undefined;
  return ctx.objectById(prop.nestedObjectId!);
}

// ---------------------------------------------------------------------------
// 1. Fetch
// ---------------------------------------------------------------------------

export class FetchAdapter implements UsageAdapter {
  readonly name = "fetch";

  detect(call: CallRecord, ctx: FullDetectionContext): HttpCallDetection | null {
    const rootName = call.rootIdentifier ?? call.callee[0]?.text;
    if (rootName === undefined) return null;
    const isMemberFetch = call.callee.length === 1 && call.callee[0].text === "fetch" && call.rootIdentifier !== undefined;
    // Global fetch: identifier `fetch(...)` or `something.fetch(...)`.
    if (call.callee.length > 1) return null;
    if (call.callee[0] !== undefined && call.callee[0].computed) return null;
    const headText = isMemberFetch ? "fetch" : rootName;
    if (headText !== "fetch") return null;
    if (!ctx.isGlobalIdentifier(ctx.file, call.scopeId, isMemberFetch ? call.rootIdentifier! : "fetch")) return null;

    const pathResult = evalPathArg(ctx, call, 0);
    const configObject = argObject(ctx, call, 1);
    const method = methodFromConfig(configObject, {
      method: "GET",
      why: "fetch() without a config `method` defaults to GET"
    });
    let bodyObject: ObjectLiteralRecord | undefined;
    if (configObject) {
      bodyObject = nestedObjectById(ctx, configObject, "body");
      // `fetch(url, { method, body })` where body is the object itself is not a
      // body object (it would be a FormData/ReadableStream in real code) — only
      // JSON.stringify bodies are structural.
    }
    return {
      adapter: this.name,
      kind: "fetch-call",
      method: method.method,
      methodEvidence: method.evidence,
      path: pathResult.path,
      pathEvidence: pathResult.evidence,
      bodyObject,
      clientEvidence: [evidence("global-fetch", "`fetch` resolves to the global, not a local binding", "HIGH")],
      responseConvention: "fetch-json",
      range: call.range,
      symbol: "fetch"
    };
  }
}

// ---------------------------------------------------------------------------
// 2. Axios
// ---------------------------------------------------------------------------

export class AxiosAdapter implements UsageAdapter {
  readonly name = "axios";

  detect(call: CallRecord, ctx: FullDetectionContext): HttpCallDetection | null {
    const rootName = call.rootIdentifier;
    if (rootName === undefined) return null;
    const methodSeg = call.callee[0];
    const root = ctx.resolveRoot(ctx.file, call.scopeId, rootName);

    if (root.via === "external" && root.importSpecifier === "axios") {
      if (methodSeg !== undefined && !methodSeg.computed && AXIOS_METHODS.has(methodSeg.text)) {
        return this.axiosMethodCall(ctx, call, methodSeg.text.toUpperCase());
      }
      if (methodSeg === undefined) return this.axiosGenericCall(ctx, call);
      return null;
    }

    const init = ctx.instanceInit(ctx.file, call.scopeId, rootName);
    if (init && init.kind === "axios-create" && methodSeg !== undefined && !methodSeg.computed && AXIOS_METHODS.has(methodSeg.text)) {
      return this.instanceMethodCall(ctx, call, methodSeg.text.toUpperCase(), init.configObject);
    }
    return null;
  }


  private axiosMethodCall(ctx: FullDetectionContext, call: CallRecord, method: string): HttpCallDetection | null {
    const pathResult = evalPathArg(ctx, call, 0);
    // `axios.post(url, body, config?)` — body is the second argument object.
    const bodyArg = call.args[1];
    const bodyObject = bodyArg && bodyArg.kind === "object" ? ctx.objectById(bodyArg.objectId) : undefined;
    return {
      adapter: this.name,
      kind: "axios-call",
      method,
      methodEvidence: [evidence("method-literal", `axios.${method.toLowerCase()} call: method is ${method}`, "HIGH")],
      path: pathResult.path,
      pathEvidence: pathResult.evidence,
      bodyObject,
      clientEvidence: [evidence("axios-import", "callee resolves to the `axios` package import", "HIGH")],
      responseConvention: "axios-data",
      range: call.range,
      symbol: call.callee.map((s) => s.text).join(".")
    };
  }

  private axiosGenericCall(ctx: FullDetectionContext, call: CallRecord): HttpCallDetection | null {
    const first = call.args[0];
    // axios({ url, method, data })
    if (first && first.kind === "object") {
      const object = ctx.objectById(first.objectId);
      if (!object) return null;
      const urlProp = object.properties.find((p) => p.path.length === 1 && (p.path[0] === "url" || p.path[0] === "path"));
      if (!urlProp) return null;
      const method = methodFromConfig(object);
      let path: PathPattern | undefined;
      if (urlProp.valueKind === "literal" && urlProp.literalValue !== undefined) {
        const pattern = toPathPattern({
          segments: [{ kind: "literal", text: urlProp.literalValue }],
          anyHole: false,
          stepsUsed: 1
        });
        path = pattern ? stripUrlOrigin(pattern) : undefined;
      }
      return {
        adapter: this.name,
        kind: "axios-call",
        method: method.method,
        methodEvidence: method.evidence,
        path,
        pathEvidence: path !== undefined
          ? [evidence("path-literal", `request-object url property statically reconstructed as ${path?.display}`, "HIGH")]
          : [evidence("path-not-static", "request-object url is not a literal", "UNKNOWN")],
        bodyObject: nestedObjectById(ctx, object, "data"),
        clientEvidence: [evidence("axios-import", "callee resolves to the `axios` package import", "HIGH")],
        responseConvention: "axios-data",
        range: call.range,
        symbol: "axios"
      };
    }
    // axios(url, config)
    const pathResult = evalPathArg(ctx, call, 0);
    if (!pathResult.path) return null;
    const config = argObject(ctx, call, 1);
    const method = methodFromConfig(config);
    return {
      adapter: this.name,
      kind: "axios-call",
      method: method.method,
      methodEvidence: method.evidence,
      path: pathResult.path,
      pathEvidence: pathResult.evidence,
      bodyObject: config ? nestedObjectById(ctx, config, "data") : undefined,
      clientEvidence: [evidence("axios-import", "callee resolves to the `axios` package import", "HIGH")],
      responseConvention: "axios-data",
      range: call.range,
      symbol: "axios"
    };
  }

  private instanceMethodCall(ctx: FullDetectionContext, call: CallRecord, method: string, createConfig: ObjectLiteralRecord | undefined): HttpCallDetection | null {
    const pathResult = evalPathArg(ctx, call, 0);
    const bodyArg = call.args[1];
    const bodyObject = bodyArg && bodyArg.kind === "object" ? ctx.objectById(bodyArg.objectId) : undefined;
    const clientEvidence: Evidence[] = [
      evidence("axios-instance", "callee root is a variable initialised from `axios.create(...)`", "HIGH")
    ];
    const baseURL = createConfig?.properties.find((p) => p.path.length === 1 && p.path[0] === "baseURL");
    if (baseURL) {
      clientEvidence.push(evidence("instance-base-url", "instance baseURL not statically resolved; per-call path matched directly (base-path prefixes are absorbed by matching)", "HIGH"));
    }
    return {
      adapter: this.name,
      kind: "axios-call",
      method,
      methodEvidence: [evidence("method-literal", `instance .${method.toLowerCase()} call: method is ${method}`, "HIGH")],
      path: pathResult.path,
      pathEvidence: pathResult.evidence,
      bodyObject,
      clientEvidence,
      responseConvention: "axios-data",
      range: call.range,
      symbol: call.callee.map((s) => s.text).join(".")
    };
  }
}

// ---------------------------------------------------------------------------
// 3. Request object: request({ method, url })
// ---------------------------------------------------------------------------

export class RequestObjectAdapter implements UsageAdapter {
  readonly name = "request-object";

  detect(call: CallRecord, ctx: FullDetectionContext): HttpCallDetection | null {
    const first = call.args[0];
    if (!first || first.kind !== "object") return null;
    const object = ctx.objectById(first.objectId);
    if (!object) return null;
    const urlProp = object.properties.find((p) => p.path.length === 1 && (p.path[0] === "url" || p.path[0] === "path" || p.path[0] === "uri"));
    if (!urlProp) return null;
    const method = methodFromConfig(object);
    let path: PathPattern | undefined;
    const pathEvidence: Evidence[] = [];
    if (urlProp.valueKind === "literal" && urlProp.literalValue !== undefined) {
      const pattern = toPathPattern({
        segments: [{ kind: "literal", text: urlProp.literalValue }],
        anyHole: false,
        stepsUsed: 1
      });
      path = pattern ? stripUrlOrigin(pattern) : undefined;
      if (path) pathEvidence.push(evidence("path-literal", `request-object url statically reconstructed as ${path.display}`, "HIGH"));
    } else if (urlProp.valueKind === "template" && urlProp.templateValue !== undefined) {
      const evaluated = toPathPattern({
        segments: urlProp.templateValue.map((part) =>
          part.kind === "static" ? ({ kind: "literal", text: part.text } as const) : ({ kind: "hole", source: part.text } as const)
        ),
        anyHole: true,
        stepsUsed: 1
      });
      path = evaluated ? stripUrlOrigin(evaluated) : undefined;
      if (path) {
        pathEvidence.push(evidence("path-template", `request-object url template reconstructed as ${path.display}`, "MEDIUM"));
      }
    }
    if (path === undefined) {
      pathEvidence.push(evidence("path-not-static", "request-object url is not statically reconstructable", "UNKNOWN"));
    }
    return {
      adapter: this.name,
      kind: "request-object-call",
      method: method.method,
      methodEvidence: method.evidence,
      path,
      pathEvidence,
      bodyObject: nestedObjectById(ctx, object, "data") ?? nestedObjectById(ctx, object, "body"),
      clientEvidence: [evidence("request-object", "call argument is an object with a url/path property", "MEDIUM")],
      responseConvention: "unknown",
      range: call.range,
      symbol: call.callee.map((s) => s.text).join(".")
    };
  }
}

// ---------------------------------------------------------------------------
// 4. Generated client: imported operation functions
// ---------------------------------------------------------------------------

export class GeneratedClientAdapter implements UsageAdapter {
  readonly name = "generated-client";

  detect(call: CallRecord, ctx: FullDetectionContext): HttpCallDetection | null {
    const head = call.rootIdentifier;
    if (head === undefined) return null;
    if (call.callee.length !== 0) return null; // bare identifier calls only
    const root = ctx.resolveRoot(ctx.file, call.scopeId, head);
    if (root.via !== "import" && root.via !== "external") return null;
    if (isHttpMethod(head)) return null;
    const pathResult = evalPathArg(ctx, call, 0);
    // Body: first object argument, or config.data / config.body.
    const firstObj = argObject(ctx, call, 0);
    const configObj = argObject(ctx, call, 1);
    const bodyObject = firstObj ?? (configObj ? nestedObjectById(ctx, configObj, "body") ?? nestedObjectById(ctx, configObj, "data") : undefined);
    return {
      adapter: this.name,
      kind: "generated-client-call",
      method: undefined,
      methodEvidence: [evidence("method-from-operation", "method comes from the matched OpenAPI operation, not the call site", "MEDIUM")],
      path: pathResult.path,
      pathEvidence: pathResult.evidence,
      bodyObject,
      clientEvidence: [
        root.via === "import"
          ? evidence("symbol-resolved", `callee resolves to an import from ${root.importSpecifier}`, "HIGH")
          : evidence("external-symbol", `callee resolves to an external package symbol (${root.importSpecifier})`, "MEDIUM")
      ],
      responseConvention: "unknown",
      range: call.range,
      symbol: head
    };
  }
}

function isHttpMethod(text: string): boolean {
  return HTTP_METHOD_SET.has(text.toUpperCase());
}

// ---------------------------------------------------------------------------
// 5. SDK resource chains: client.users.getUser(...)
// ---------------------------------------------------------------------------

export class SdkResourceAdapter implements UsageAdapter {
  readonly name = "sdk-resource";

  detect(call: CallRecord, ctx: FullDetectionContext): HttpCallDetection | null {
    if (call.callee.length < 2) return null;
    const head = call.rootIdentifier;
    if (head === undefined) return null;
    const methodSegment = call.callee[call.callee.length - 1];
    if (methodSegment.computed) return null;
    if (isHttpMethod(methodSegment.text)) return null; // client.get(...) → generic adapter
    const root = ctx.resolveRoot(ctx.file, call.scopeId, head);
    // Precision guard: a resource chain on a *parameter* or a plain aliased
    // variable is not evidence of a client (`r.url.includes("/x")` must not
    // match). Only imports, unresolvable roots, and client-shaped locals
    // (constructed or literal objects) qualify.
    if (root.via === "local") {
      const variableClient =
        root.declarationKind === "variable" &&
        (root.initKind === "object-literal" ||
          (root.initKind === "call" && root.initText !== undefined && root.initText.startsWith("new ")));
      if (!variableClient) return null;
    }
    const clientEvidence: Evidence[] = [];
    if (root.via === "external") {
      clientEvidence.push(evidence("sdk-package", `root resolves to external package ${root.importSpecifier ?? head}`, "MEDIUM"));
    } else if (root.via === "import") {
      clientEvidence.push(evidence("sdk-internal", `root resolves to an internal module import (${root.importSpecifier})`, "HIGH"));
    } else if (root.via === "local") {
      clientEvidence.push(evidence("sdk-local-object", `root resolves to a local binding (${head})`, "MEDIUM"));
    } else {
      clientEvidence.push(evidence("sdk-unresolved-root", `root binding could not be resolved (${head})`, "UNKNOWN"));
    }
    const pathResult = evalPathArg(ctx, call, 0);
    const firstObj = argObject(ctx, call, 0);
    const configObj = argObject(ctx, call, 1);
    return {
      adapter: this.name,
      kind: "sdk-client-call",
      method: undefined,
      methodEvidence: [evidence("method-from-operation", "method comes from the matched OpenAPI operation", "MEDIUM")],
      path: pathResult.path,
      pathEvidence: pathResult.evidence,
      bodyObject: firstObj ?? (configObj ? nestedObjectById(ctx, configObj, "body") ?? nestedObjectById(ctx, configObj, "data") : undefined),
      clientEvidence,
      responseConvention: "unknown",
      range: call.range,
      symbol: [head, ...call.callee.map((seg) => seg.text)].join(".")
    };
  }
}

// ---------------------------------------------------------------------------
// 6. Generic HTTP client: client.get("/users")
// ---------------------------------------------------------------------------

export class GenericHttpClientAdapter implements UsageAdapter {
  readonly name = "generic-http-client";

  detect(call: CallRecord, ctx: FullDetectionContext): HttpCallDetection | null {
    const methodSeg = call.callee[0];
    if (call.rootIdentifier === undefined || call.callee.length !== 1 || methodSeg === undefined || methodSeg.computed) return null;
    if (!AXIOS_METHODS.has(methodSeg.text)) return null;
    const pathResult = evalPathArg(ctx, call, 0);
    if (!pathResult.path) {
      // Without URL-shaped evidence this is just a method-named call
      // (`map.get(key)`) — declining is the safe choice.
      return null;
    }
    const configObject = argObject(ctx, call, 1);
    const configMethod = methodFromConfig(configObject);
    const bodyObject =
      call.args[1] && call.args[1].kind === "object"
        ? ctx.objectById((call.args[1] as { objectId: string }).objectId)
        : undefined;
    return {
      adapter: this.name,
      kind: "http-client-call",
      method: configMethod.method ?? methodSeg.text.toUpperCase(),
      methodEvidence: [
        evidence("method-literal", `.${methodSeg.text}( call: method is ${methodSeg.text.toUpperCase()}`, "HIGH"),
        ...configMethod.evidence
      ],
      path: pathResult.path,
      pathEvidence: pathResult.evidence,
      bodyObject,
      clientEvidence: [evidence("generic-client", "method-named call with URL-shaped first argument", "MEDIUM")],
      responseConvention: "unknown",
      range: call.range,
      symbol: call.callee.map((s) => s.text).join(".")
    };
  }
}

export const BUILT_IN_ADAPTERS: UsageAdapter[] = [
  new FetchAdapter(),
  new AxiosAdapter(),
  new RequestObjectAdapter(),
  new GeneratedClientAdapter(),
  new SdkResourceAdapter(),
  new GenericHttpClientAdapter()
];
