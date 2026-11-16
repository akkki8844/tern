/**
 * RepositoryScanner — the orchestrating engine.
 *
 * Pipeline: discovery → parsing → file analysis → module graph → symbol
 * resolution → adapter-based usage detection → operation matching →
 * conditional-change refinement → response-flow analysis → type-evidence
 * analysis → wrapper-chain expansion → affected-usage graph.
 *
 * Guarantees:
 * - never executes repository code, never installs anything, never calls an LLM;
 * - never modifies files — analysis only;
 * - deterministic: stable ids, sorted outputs, no clock/random in results
 *   (timings are reported separately and excluded from all ids);
 * - every usage carries evidence and a confidence; uncertainty is explicit.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ApiChange, SpecChangeAnalysis } from "@tern/openapi";
import { DEFAULT_SCANNER_LIMITS, type ScannerLimits } from "../limits.js";
import { discoverRepository, exclusionCounts, isWithin } from "../discovery/discover.js";
import type { Evidence, SourceFile } from "../model/types.js";
import type { FileAnalysis } from "../ast/analyze.js";
import { FileAnalyzer } from "../ast/analyze.js";
import { ParseCache, parseFile } from "../parse/parser.js";
import { readTsConfigPaths, type TsConfigPaths } from "../modules/tsconfig.js";
import { ModuleResolver } from "../modules/resolver.js";
import { DefaultSymbolResolver, type SymbolResolver } from "../symbols/resolve.js";
import type { DetectedUsage, RepositoryScan, UsageGraph, UsageKind } from "../model/usage.js";
import type { Confidence, Severity } from "../model/types.js";
import { OperationIndex } from "../operations/index.js";
import { BUILT_IN_ADAPTERS, type FullDetectionContext } from "../detect/adapters.js";
import type { HttpCallDetection } from "../detect/adapter.js";
import {
  changeAppliesToRequest,
  changeAppliesToResponse,
  collectBodyFacts,
  findCandidates,
  usageConfidence
} from "../detect/match.js";
import { analyzeResponseFlow } from "../detect/response.js";
import type { UsageAdapter } from "../detect/adapter.js";
import { evidence } from "../detect/adapter.js";

export interface RepositoryScannerOptions {
  readonly limits?: Partial<ScannerLimits>;
  readonly adapters?: ReadonlyArray<UsageAdapter>;
  readonly respectGitignore?: boolean;
  readonly include?: ReadonlyArray<string>;
  readonly exclude?: ReadonlyArray<string>;
}

interface CallUsagePlan {
  readonly file: string;
  readonly callId: string;
  readonly detection: HttpCallDetection;
  readonly candidates: ReturnType<typeof findCandidates>["candidates"];
  readonly outcome: ReturnType<typeof findCandidates>["outcome"];
  /** Response property paths consumed from THIS call's response. */
  readonly consumed: ReadonlyArray<ReadonlyArray<string>>;
  readonly consumptionTracked: boolean;
}

export class RepositoryScanner {
  private readonly limits: ScannerLimits;
  private readonly adapters: ReadonlyArray<UsageAdapter>;
  private readonly respectGitignore: boolean;
  private readonly include?: ReadonlyArray<string>;
  private readonly exclude?: ReadonlyArray<string>;
  /** Per-scan source lines, used for snippet extraction (cleared each scan). */
  private readonly snippets = new Map<string, Map<string, string>>();

  constructor(options: RepositoryScannerOptions = {}) {
    this.limits = { ...DEFAULT_SCANNER_LIMITS, ...options.limits };
    this.adapters = options.adapters ?? BUILT_IN_ADAPTERS;
    this.respectGitignore = options.respectGitignore ?? true;
    this.include = options.include;
    this.exclude = options.exclude;
  }

  async scan(rootAbsRaw: string, analysis: SpecChangeAnalysis): Promise<RepositoryScan> {
    const start = performance.now();
    const rootAbs = path.resolve(rootAbsRaw);
    const timing = { discoveryMs: 0, parsingMs: 0, resolutionMs: 0, detectionMs: 0, matchingMs: 0, totalMs: 0 };

    // -- discovery ----------------------------------------------------------
    const t0 = performance.now();
    const discovery = await discoverRepository(rootAbs, {
      limits: this.limits,
      respectGitignore: this.respectGitignore,
      include: this.include,
      exclude: this.exclude
    });
    timing.discoveryMs = performance.now() - t0;

    // -- parse + analyze ------------------------------------------------------
    const t1 = performance.now();
    const parseCache = new ParseCache();
    const files: SourceFile[] = [];
    const analyses: FileAnalysis[] = [];
    const parseFailures: Array<{ file: string; errors: string[] }> = [];
    this.snippets.clear();
    for (const discovered of discovery.files) {
      const abs = path.join(rootAbs, discovered.id);
      // Defense in depth: discovery already confines ids to the root, but the
      // read itself re-checks so a malformed id can never escape the workspace.
      if (!isWithin(rootAbs, path.resolve(abs))) {
        parseFailures.push({ file: discovered.id, errors: ["refused: path escapes the scan root"] });
        files.push({ ...discovered, parse: { refused: true, reason: "outside-root" } });
        continue;
      }
      const content = await readFile(abs, "utf8").catch(() => null);
      if (content === null) {
        parseFailures.push({ file: discovered.id, errors: ["file could not be read"] });
        files.push({ ...discovered, parse: { refused: true, reason: "unreadable" } });
        continue;
      }
      this.snippets.set(discovered.id, snippetTable(content));
      const key = `${discovered.id}#${discovered.hash.slice(0, 32)}`;
      const cached = parseCache.get(key);
      const parsed = cached ?? parseFile({ filePath: discovered.id, content, maxNodes: this.limits.maxNodesPerFile });
      if (parsed === null) {
        throw new Error("tree-sitter is unavailable; the AST engine cannot run");
      }
      parseCache.set(key, parsed);
      const analyzer = new FileAnalyzer(discovered.id, parsed.tree.rootNode, { maxObjectDepth: this.limits.maxObjectPropertyDepth });
      const fileAnalysis = analyzer.analyze();
      const parseOutcome = parsed.errors.length > 0
        ? {
            ok: false as const,
            partial: true,
            errors: parsed.errors.map((e) => ({ message: e.message, line: e.line, column: e.column }))
          }
        : { ok: true as const, nodeCount: parsed.nodeCount };
      files.push({ ...discovered, parse: parseOutcome });
      if (parsed.errors.length > 0) {
        parseFailures.push({
          file: discovered.id,
          errors: parsed.errors.slice(0, 5).map((e) => `${e.message} at line ${e.line}, column ${e.column}`)
        });
      }
      analyses.push(fileAnalysis);
    }
    timing.parsingMs = performance.now() - t1;

    // -- module graph + symbol resolution ------------------------------------
    const t2 = performance.now();
    const tsconfigByDir = await this.collectTsConfigs(rootAbs, discovery.files.map((f) => f.id));
    const tsconfigCache = new Map<string, TsConfigPaths | undefined>();
    const tsconfigFor = (file: string): TsConfigPaths | undefined => {
      const cached = tsconfigCache.get(file);
      if (cached !== undefined) return cached;
      const dir = path.posix.dirname(file);
      let best: { dir: string; config: TsConfigPaths } | undefined;
      for (const candidate of tsconfigByDir) {
        const covers = candidate.dir === "." || dir === candidate.dir || dir.startsWith(`${candidate.dir}/`);
        if (covers && (best === undefined || candidate.dir.length > best.dir.length)) best = candidate;
      }
      tsconfigCache.set(file, best?.config);
      return best?.config;
    };
    const firstFile = discovery.files[0]?.id ?? "";
    const moduleResolver = new ModuleResolver({
      rootAbs,
      tsconfig: tsconfigFor(firstFile),
      maxResolutions: this.limits.maxResolutions
    });
    const symbolResolver = new DefaultSymbolResolver(analyses, moduleResolver, {
      maxReExportDepth: this.limits.maxReExportDepth
    });
    timing.resolutionMs = performance.now() - t2;

    // -- detection ------------------------------------------------------------
    const t3 = performance.now();
    const index = OperationIndex.fromAnalysis(analysis);
    const detections = new Map<string, { file: string; detection: HttpCallDetection }>();
    for (const fileAnalysis of analyses) {
      const context = this.makeContext(fileAnalysis, symbolResolver);
      for (const call of fileAnalysis.calls) {
        for (const adapter of this.adapters) {
          const detected = adapter.detect(call, context);
          if (detected !== null) {
            detections.set(call.id, { file: fileAnalysis.file, detection: detected });
            break;
          }
        }
      }
    }
    timing.detectionMs = performance.now() - t3;

    // -- response flow ----------------------------------------------------------
    const t4 = performance.now();
    const trackedByFile = new Map<string, Map<string, { convention: "axios-data" | "fetch-json" | "unknown" }>>();
    for (const [callId, entry] of detections) {
      if (!trackedByFile.has(entry.file)) trackedByFile.set(entry.file, new Map());
      trackedByFile.get(entry.file)!.set(callId, { convention: entry.detection.responseConvention });
    }
    const flowByFile = new Map<string, ReturnType<typeof analyzeResponseFlow>>();
    for (const fileAnalysis of analyses) {
      const tracked = trackedByFile.get(fileAnalysis.file) ?? new Map();
      const flow = analyzeResponseFlow(fileAnalysis, tracked, symbolResolver);
      flowByFile.set(fileAnalysis.file, flow);
    }
    const metricsAcc = {
      refinedOut: 0,
      ambiguousMatches: 0,
      responseRootsTracked: 0,
      untrackedResponseFlows: 0,
      dynamicObjectSpreads: 0,
      truncatedWrapperChains: 0
    };
    for (const flow of flowByFile.values()) {
      metricsAcc.responseRootsTracked += flow.bindings.length;
      metricsAcc.untrackedResponseFlows += flow.untrackedFlows;
    }

    // -- matching + conditional refinement -------------------------------------
    const plans: CallUsagePlan[] = [];
    for (const fileAnalysis of analyses) {
      const flow = flowByFile.get(fileAnalysis.file)!;
      for (const call of fileAnalysis.calls) {
        const entry = detections.get(call.id);
        if (!entry) continue;
        const selection = findCandidates(entry.detection, index);
        if (selection.outcome === "ambiguous") metricsAcc.ambiguousMatches += selection.candidates.length;
        const bodyFacts = collectBodyFacts(entry.detection.bodyObject);
        if (bodyFacts.hasSpread) metricsAcc.dynamicObjectSpreads += 1;
        const callConsumed = flow.consumed
          .filter((c) => c.callId === call.id)
          .map((c) => c.path);
        plans.push({
          file: fileAnalysis.file,
          callId: call.id,
          detection: entry.detection,
          candidates: selection.candidates,
          outcome: selection.outcome,
          consumed: callConsumed,
          consumptionTracked: flow.bindings.some((b) => b.callId === call.id)
        });
      }
    }

    const usages: DetectedUsage[] = [];
    for (const plan of plans) {
      for (const candidate of plan.candidates) {
        const applicable: Array<{ change: ApiChange; evidence: Evidence[] }> = [];
        for (const change of candidate.entry.changes) {
          const verdict = this.changeApplies(change, plan);
          if (verdict.applicable) applicable.push({ change, evidence: [...verdict.evidence] });
          else metricsAcc.refinedOut += 1;
        }
        if (applicable.length === 0) continue;
        usages.push(
          this.buildUsage(plan, candidate, applicable, plan.candidates.length)
        );
      }
    }

    // -- type-evidence pass ------------------------------------------------------
    usages.push(...this.typedAccessUsages(analyses, symbolResolver, analysis, flowByFile));

    // -- wrapper chain expansion ---------------------------------------------------
    usages.push(...this.wrapperChainUsages(usages, analyses, symbolResolver, metricsAcc));
    timing.matchingMs = performance.now() - t4;
    timing.totalMs = performance.now() - start;

    // -- finalize --------------------------------------------------------------------
    const deduped = dedupeUsages(usages, this.limits.maxUsages);
    const graph = buildGraph(deduped, index);

    return {
      files,
      excluded: discovery.excluded,
      parseFailures,
      usages: deduped,
      graph,
      engine: "ast",
      limits: {
        fileLimitReached: discovery.fileLimitReached,
        usageLimitReached: deduped.length >= this.limits.maxUsages
      },
      timing: {
        discoveryMs: Math.round(timing.discoveryMs),
        parsingMs: Math.round(timing.parsingMs),
        resolutionMs: Math.round(timing.resolutionMs),
        detectionMs: Math.round(timing.detectionMs),
        matchingMs: Math.round(timing.matchingMs),
        totalMs: Math.round(timing.totalMs)
      },
      metrics: {
        discovery: {
          filesConsidered: discovery.files.length + discovery.excluded.length,
          filesIncluded: discovery.files.length,
          exclusions: exclusionCounts(discovery.excluded)
        },
        parsing: {
          filesParsedOk: files.filter((f) => "ok" in f.parse && f.parse.ok === true).length,
          filesWithParseErrors: files.filter((f) => "ok" in f.parse && f.parse.ok === false).length,
          filesRefused: files.filter((f) => "refused" in f.parse).length,
          reportedErrorFiles: parseFailures.map((f) => f.file).slice(0, this.limits.maxReportedParseErrors)
        },
        modules: {
          importsTotal: analyses.reduce((n, a) => n + a.imports.length, 0),
          importsResolvedInternal: countImports(analyses, moduleResolver, "internal"),
          importsExternal: countImports(analyses, moduleResolver, "external"),
          importsUnresolved: countImports(analyses, moduleResolver, "unresolved"),
          tsconfigPathsApplied: moduleResolver.appliedPathAliases
        },
        symbols: {
          declarations: analyses.reduce((n, a) => n + a.declarations.length, 0),
          referencesResolved: countReferences(analyses, symbolResolver, true),
          referencesUnresolved: countReferences(analyses, symbolResolver, false),
          shadowedBindings: countShadowed(analyses, symbolResolver)
        },
        usages: {
          callSitesConsidered: detections.size,
          directUsages: deduped.filter((u) => !u.indirect).length,
          indirectUsages: deduped.filter((u) => u.indirect).length,
          byConfidence: countConfidence(deduped),
          byKind: countKind(deduped)
        },
        matching: {
          operationsIndexed: index.size,
          changesConsidered: analysis.changes.filter((c) => c.severity !== "NON_BREAKING").length,
          operationsMatched: new Set(deduped.filter((u) => u.operation !== undefined).map((u) => `${u.operation!.method} ${u.operation!.path}`)).size,
          refinedOut: metricsAcc.refinedOut,
          ambiguousMatches: metricsAcc.ambiguousMatches
        },
        flow: {
          responseRootsTracked: metricsAcc.responseRootsTracked,
          untrackedResponseFlows: metricsAcc.untrackedResponseFlows,
          dynamicObjectSpreads: metricsAcc.dynamicObjectSpreads,
          truncatedWrapperChains: metricsAcc.truncatedWrapperChains
        }
      }
    };
  }

  // -------------------------------------------------------------------------

  private async collectTsConfigs(rootAbs: string, fileIds: ReadonlyArray<string>): Promise<Array<{ dir: string; config: TsConfigPaths }>> {
    const configFiles = fileIds.filter(
      (f) => f === "tsconfig.json" || f === "jsconfig.json" || f.endsWith("/tsconfig.json") || f.endsWith("/jsconfig.json")
    );
    const out: Array<{ dir: string; config: TsConfigPaths }> = [];
    for (const config of configFiles) {
      const parsed = await readTsConfigPaths(path.join(rootAbs, config), rootAbs);
      if (parsed.applied) {
        out.push({ dir: path.posix.dirname(config), config: parsed });
      }
    }
    return out;
  }

  private makeContext(analysis: FileAnalysis, symbolResolver: SymbolResolver): FullDetectionContext {
    const file = analysis.file;
    return {
      file,
      resolver: symbolResolver,
      maxSteps: this.limits.maxValueResolutionSteps,
      isGlobalIdentifier: (f, scopeId, name) => {
        if (f !== file) return false;
        return symbolResolver.resolveIdentifier(f, scopeId, name).via === "unresolved";
      },
      resolveRoot: (f, scopeId, name) => {
        const resolution = symbolResolver.resolveIdentifier(f, scopeId, name);
        return {
          via: resolution.via,
          importSpecifier: resolution.importSpecifier ?? resolution.declaration?.importOf?.specifier,
          declarationKind: resolution.declaration?.kind,
          initKind: resolution.declaration?.init?.kind,
          initText: resolution.declaration?.init?.kind === "call" ? resolution.declaration.init.calleeText : undefined
        };
      },
      objectById: (id) => analysis.objects.get(id),
      instanceInit: (f, scopeId, name) => {
        if (f !== file) return undefined;
        const resolution = symbolResolver.resolveIdentifier(f, scopeId, name);
        const decl = resolution.declaration;
        if (!decl || decl.init === undefined || decl.init.kind !== "call") return undefined;
        const callee = decl.init.calleeText;
        if (callee === "axios.create" || callee.endsWith(".axios.create")) {
          const objectId = decl.init.argObjectIds?.[0];
          return { kind: "axios-create", configObject: objectId ? analysis.objects.get(objectId) : undefined };
        }
        const newMatch = /^new\s+([A-Za-z_$][\w$]*)/.exec(callee);
        if (newMatch) return { kind: "new-expression", className: newMatch[1] };
        return undefined;
      }
    };
  }

  private changeApplies(
    change: ApiChange,
    plan: CallUsagePlan
  ): { applicable: boolean; evidence: ReadonlyArray<Evidence> } {
    const bodyFacts = collectBodyFacts(plan.detection.bodyObject);
    const consumed = plan.consumptionTracked ? plan.consumed : null;
    if (change.direction === "request") {
      return changeAppliesToRequest(change, bodyFacts);
    }
    if (change.direction === "response") {
      return changeAppliesToResponse(change, consumed);
    }
    // both / unknown: refine through either channel.
    const requestVerdict = changeAppliesToRequest(change, bodyFacts);
    if (requestVerdict.applicable) return requestVerdict;
    const responseVerdict = changeAppliesToResponse(change, consumed);
    if (responseVerdict.applicable) return responseVerdict;
    if (isPropertyLevel(change)) return { applicable: false, evidence: requestVerdict.evidence };
    return {
      applicable: true,
      evidence: [evidence("operation-change", `change ${change.rule} applies to the whole operation`, "HIGH")]
    };
  }

  private buildUsage(
    plan: CallUsagePlan,
    candidate: ReturnType<typeof findCandidates>["candidates"][number],
    applicable: Array<{ change: ApiChange; evidence: ReadonlyArray<Evidence> }>,
    candidateCount: number
  ): DetectedUsage {
    const changeIds = [...new Set(applicable.map((a) => a.change.id))].sort();
    const changeRules = [...new Set(applicable.map((a) => a.change.rule))].sort();
    const severity = worstSeverity(applicable.map((a) => a.change.severity));
    // nameEvidence embeds clientEvidence, so identical (kind, detail,
    // confidence) triples can arrive twice; the report stays clean by keeping
    // the first occurrence in deterministic order.
    const seenEvidence = new Set<string>();
    const evidenceItems: Evidence[] = [
      ...plan.detection.clientEvidence,
      ...plan.detection.methodEvidence,
      ...candidate.pathEvidence,
      ...candidate.nameEvidence,
      ...applicable.flatMap((a) => a.evidence)
    ].filter((e) => {
      const key = `${e.kind}|${e.detail}|${e.confidence}`;
      if (seenEvidence.has(key)) return false;
      seenEvidence.add(key);
      return true;
    });
    if (candidateCount > 1) {
      evidenceItems.push(
        evidence("ambiguous-match", `path and name evidence match ${candidateCount} operations; treat as a candidate set`, "LOW")
      );
    }
    const confidence = usageConfidence(evidenceItems);
    const snippet = this.snippetLine(plan.file, plan.detection.range.startLine);
    const operation = {
      path: candidate.entry.path,
      method: candidate.entry.method,
      ...(candidate.entry.operationId !== undefined ? { operationId: candidate.entry.operationId } : {})
    };
    const opText = `${operation.method} ${operation.path}`;
    const explanation =
      `${opText}${operation.operationId !== undefined ? ` (${operation.operationId})` : ""} is used here as ${plan.detection.kind} ` +
      `via the ${plan.detection.adapter} adapter; change(s) ${changeRules.join(", ")} apply: ` +
      applicable.map((a) => a.evidence.map((e) => e.detail).join("; ")).join(" | ");
    return {
      id: usageId(plan.file, plan.callId, plan.detection.symbol, `${operation.method} ${operation.path}`, changeIds),
      file: plan.file,
      range: plan.detection.range,
      line: plan.detection.range.startLine + 1,
      column: plan.detection.range.startColumn + 1,
      kind: plan.detection.kind as UsageKind,
      operation,
      ...(candidateCount > 1
        ? {
            operationCandidates: plan.candidates.map((c) => ({
              path: c.entry.path,
              method: c.entry.method,
              ...(c.entry.operationId !== undefined ? { operationId: c.entry.operationId } : {})
            }))
          }
        : {}),
      symbol: plan.detection.symbol,
      changeIds,
      changeRules,
      severity,
      confidence,
      evidence: evidenceItems,
      snippet,
      explanation,
      indirect: false
    };
  }

  // -- type-evidence pass ------------------------------------------------------

  private typedAccessUsages(
    analyses: ReadonlyArray<FileAnalysis>,
    symbolResolver: SymbolResolver,
    analysis: SpecChangeAnalysis,
    flowByFile: ReadonlyMap<string, ReturnType<typeof analyzeResponseFlow>>
  ): DetectedUsage[] {
    const componentChanges = new Map<string, ApiChange[]>();
    for (const change of analysis.changes) {
      if (change.severity === "NON_BREAKING") continue;
      const schema = change.location.componentSchema;
      if (schema === undefined) continue;
      const list = componentChanges.get(schema) ?? [];
      list.push(change);
      componentChanges.set(schema, list);
    }
    if (componentChanges.size === 0) return [];

    const usages: DetectedUsage[] = [];
    for (const fileAnalysis of analyses) {
      const flow = flowByFile.get(fileAnalysis.file);
      const bindingNames = new Set(flow?.bindings.map((b) => b.name) ?? []);
      for (const access of fileAnalysis.accesses) {
        if (bindingNames.has(access.rootIdentifier)) continue; // covered by flow analysis
        const resolution = symbolResolver.resolveIdentifier(fileAnalysis.file, access.scopeId, access.rootIdentifier);
        const decl = resolution.declaration;
        if (!decl || decl.typeAnnotation === undefined) continue;
        const typeName = extractTypeName(decl.typeAnnotation);
        if (typeName === null) continue;
        const changes = componentChanges.get(typeName);
        if (changes === undefined) continue;
        const consumedPath = access.segments.map((s) => s.text);
        const usedBy = analysis.componentUsage.find((u) => u.component === typeName);
        for (const change of changes) {
          const propertyPath =
            change.location.propertyPath ??
            (change.location.propertyName !== undefined ? [change.location.propertyName] : undefined);
          if (propertyPath === undefined || propertyPath.length === 0) continue;
          const prefixMatch =
            consumedPath.length >= propertyPath.length && propertyPath.every((seg, i) => consumedPath[i] === seg);
          if (!prefixMatch) continue;
          const opKey = usedBy?.usedBy[0]?.operationKey;
          const operation = operationFromKey(opKey ?? "");
          usages.push({
            id: usageId(
              fileAnalysis.file,
              `access#${access.range.startLine}:${access.range.startColumn}`,
              access.rootIdentifier,
              `type:${typeName}`,
              [change.id]
            ),
            file: fileAnalysis.file,
            range: access.range,
            line: access.range.startLine + 1,
            column: access.range.startColumn + 1,
            kind: "typed-property-access",
            ...(operation !== undefined ? { operation } : {}),
            symbol: `${access.rootIdentifier}.${consumedPath.join(".")}`,
            changeIds: [change.id],
            changeRules: [change.rule],
            severity: change.severity,
            confidence: "MEDIUM",
            evidence: [
              evidence("typed-binding", `variable '${access.rootIdentifier}' is annotated as ${decl.typeAnnotation}`, "HIGH"),
              evidence(
                "type-name-match",
                `annotation type ${typeName} matches changed component schema ${typeName} (name correspondence)`,
                "MEDIUM"
              ),
              evidence("property-access", `reads property '${consumedPath.join(".")}'`, "HIGH"),
              evidence("response-property-consumed", `this code reads the response property '${propertyPath.join(".")}'`, "HIGH")
            ],
            snippet: this.snippetLine(fileAnalysis.file, access.range.startLine),
            explanation: `type-evidence: '${access.rootIdentifier}' is typed ${decl.typeAnnotation}, which corresponds to changed component schema ${typeName}; this code reads '${consumedPath.join(".")}', affected by ${change.rule}.`,
            indirect: false
          });
        }
      }
    }
    return usages;
  }

  // -- wrapper chain expansion ----------------------------------------------------

  private wrapperChainUsages(
    seedUsages: ReadonlyArray<DetectedUsage>,
    analyses: ReadonlyArray<FileAnalysis>,
    symbolResolver: SymbolResolver,
    metrics: { truncatedWrapperChains: number }
  ): DetectedUsage[] {
    const produced: DetectedUsage[] = [];
    /** Best wrapper usage per (file, call anchor, change set): shortest chain wins. */
    const bestByKey = new Map<string, DetectedUsage>();
    interface QueueItem {
      usage: DetectedUsage;
      chain: string[];
      depth: number;
    }
    const queue: QueueItem[] = seedUsages
      .filter((u) => !u.indirect)
      .map((usage) => ({ usage, chain: [usage.file], depth: 0 }));

    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.depth >= this.limits.maxWrapperChainDepth) {
        metrics.truncatedWrapperChains += 1;
        continue;
      }
      const fileAnalysis = analyses.find((a) => a.file === item.usage.file);
      if (!fileAnalysis) continue;
      const usageLine = item.usage.line - 1;
      const enclosing = fileAnalysis.calls.find(
        (c) => c.range.startLine === usageLine && c.enclosingSymbolId !== undefined
      )?.enclosingSymbolId;
      if (enclosing === undefined) continue;
      const decl = fileAnalysis.declarations.find((d) => d.id === enclosing);
      if (!decl || !decl.exported) continue;

      for (const callerAnalysis of analyses) {
        for (const call of callerAnalysis.calls) {
          if (call.rootIdentifier === undefined) continue;
          const resolution = symbolResolver.resolveIdentifier(callerAnalysis.file, call.scopeId, call.rootIdentifier);
          // The caller must reference the SAME symbol (same declaration id) —
          // across an import or within the same file. Symbol identity, not the
          // crossing kind, is what makes the chain sound.
          if (resolution.via !== "import" && resolution.via !== "local") continue;
          if (resolution.declaration?.id !== decl.id) continue;
          const downgraded = downgradeConfidence(item.usage.confidence);
          const chain = [...item.chain, callerAnalysis.file];
          const key = `${callerAnalysis.file}|${call.id}|${[...item.usage.changeIds].sort().join(",")}`;
          const existingBest = bestByKey.get(key);
          if (existingBest !== undefined && existingBest.viaChain !== undefined && existingBest.viaChain.length <= chain.length) {
            continue; // an equal or shorter wrapper chain already recorded this call
          }
          const id = usageId(callerAnalysis.file, call.id, call.rootIdentifier, wrapperUsageKey(item.usage.id), item.usage.changeIds) + `w`;
          const wrapperEvidence: Evidence[] = [
            ...item.usage.evidence,
            evidence(
              "wrapper-chain",
              `calls exported ${decl.kind} '${decl.name}' from ${item.usage.file}, which performs the affected call`,
              "MEDIUM"
            ),
            ...(downgraded !== item.usage.confidence
              ? [evidence("chain-downgrade", `confidence downgraded one level per wrapper hop (hop ${item.depth + 1})`, "MEDIUM")]
              : [])
          ];
          const usage: DetectedUsage = {
            ...item.usage,
            id,
            file: callerAnalysis.file,
            range: call.range,
            line: call.range.startLine + 1,
            column: call.range.startColumn + 1,
            kind: "wrapper-caller",
            symbol: call.rootIdentifier,
            enclosingSymbol: call.enclosingFunctionName,
            confidence: downgraded,
            evidence: wrapperEvidence,
            explanation: `indirect: calls '${decl.name}' imported from ${item.usage.file}; that function performs ${
              item.usage.operation !== undefined ? `${item.usage.operation.method} ${item.usage.operation.path}` : "the affected call"
            }, so this caller is affected through the wrapper chain.`,
            indirect: true,
            viaChain: chain
          };
          bestByKey.set(key, usage);
          const existingIndex = produced.findIndex((p) => p.id === usage.id);
          if (existingIndex >= 0) produced[existingIndex] = usage;
          else produced.push(usage);
          queue.push({ usage, chain, depth: item.depth + 1 });
        }
      }
    }
    return produced;
  }

  private snippetLine(file: string, line: number): string {
    return this.snippets.get(file)?.get(String(line)) ?? "";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split source into a zero-based line table for deterministic snippets. */
function snippetTable(content: string): Map<string, string> {
  const lines = content.split("\n");
  const table = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) table.set(String(i), lines[i]);
  return table;
}

function isPropertyLevel(change: ApiChange): boolean {
  return change.location.propertyPath !== undefined || change.location.propertyName !== undefined;
}

function extractTypeName(annotation: string): string | null {
  const trimmed = annotation.trim();
  const simple = /^([A-Za-z_$][\w$]*)$/.exec(trimmed);
  if (simple) return simple[1];
  const promise = /^Promise<(.+)>$/.exec(trimmed);
  if (promise) return extractTypeName(promise[1]);
  const awaited = /^Awaited<(.+)>$/.exec(trimmed);
  if (awaited) return extractTypeName(awaited[1]);
  const paren = /^\((.+)\)$/.exec(trimmed);
  if (paren) return extractTypeName(paren[1]);
  return null;
}

function operationFromKey(key: string): { path: string; method: string } | undefined {
  const match = /^([A-Z]+) (.+)$/.exec(key);
  if (!match) return undefined;
  return { method: match[1], path: match[2] };
}

const SEVERITY_ORDER: Record<Severity, number> = { BREAKING: 0, CONDITIONAL: 1, UNKNOWN: 2, NON_BREAKING: 3 };

function worstSeverity(severities: ReadonlyArray<Severity>): Severity {
  let worst: Severity = "NON_BREAKING";
  for (const severity of severities) {
    if (SEVERITY_ORDER[severity] < SEVERITY_ORDER[worst]) worst = severity;
  }
  return worst;
}

function downgradeConfidence(confidence: Confidence): Confidence {
  switch (confidence) {
    case "HIGH":
      return "MEDIUM";
    case "MEDIUM":
      return "LOW";
    default:
      return "LOW";
  }
}

function wrapperUsageKey(seedId: string): string {
  return seedId;
}

function usageId(file: string, anchor: string, symbol: string, operationKey: string, changeIds: ReadonlyArray<string>): string {
  const hash = createHash("sha256")
    .update(`${file}|${anchor}|${symbol}|${operationKey}|${[...changeIds].sort().join(",")}`)
    .digest("hex")
    .slice(0, 16);
  return `usage_${hash}`;
}

function dedupeUsages(usages: DetectedUsage[], max: number): DetectedUsage[] {
  const byId = new Map<string, DetectedUsage>();
  for (const usage of usages) {
    if (!byId.has(usage.id)) byId.set(usage.id, usage);
  }
  // One usage per (site, operation, change set): a call detected directly AND
  // reached again through a wrapper chain reports the direct detection — the
  // wrapper pass exists to reach calls the direct pass cannot see, not to
  // double-report the ones it can.
  const bySite = new Map<string, DetectedUsage>();
  for (const usage of byId.values()) {
    const opKey = usage.operation ? `${usage.operation.method} ${usage.operation.path}` : "";
    const siteKey = `${usage.file}:${usage.line}:${usage.column}|${opKey}|${[...(usage.changeIds ?? [])].sort().join(",")}`;
    const existing = bySite.get(siteKey);
    if (existing === undefined) {
      bySite.set(siteKey, usage);
    } else if (existing.indirect && !usage.indirect) {
      bySite.set(siteKey, usage);
    }
  }
  const list = [...bySite.values()];
  list.sort(compareUsages);
  return list.length > max ? list.slice(0, max) : list;
}

function compareUsages(a: DetectedUsage, b: DetectedUsage): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.column !== b.column) return a.column - b.column;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function buildGraph(usages: ReadonlyArray<DetectedUsage>, index: OperationIndex): UsageGraph {
  const changeList = new Map<string, { rule: string; severity: Severity }>();
  for (const entry of index.all()) {
    for (const change of entry.changes) {
      if (!changeList.has(change.id)) {
        changeList.set(change.id, { rule: change.rule, severity: change.severity });
      }
    }
  }
  const changes = [...changeList.entries()]
    .map(([changeId, info]) => ({ changeId, rule: info.rule, severity: info.severity }))
    .sort((a, b) => (a.changeId < b.changeId ? -1 : a.changeId > b.changeId ? 1 : 0));

  const changeToOps = new Map<string, Set<string>>();
  for (const entry of index.all()) {
    for (const change of entry.changes) {
      if (!changeToOps.has(change.id)) changeToOps.set(change.id, new Set());
      changeToOps.get(change.id)!.add(entry.key);
    }
  }
  const opToUsages = new Map<string, string[]>();
  for (const usage of usages) {
    if (usage.operation === undefined) continue;
    const key = `${usage.operation.method} ${usage.operation.path}`;
    const list = opToUsages.get(key) ?? [];
    list.push(usage.id);
    opToUsages.set(key, list);
  }
  return {
    changes,
    operations: index
      .all()
      .map((entry) => ({
        key: entry.key,
        path: entry.path,
        method: entry.method,
        ...(entry.operationId !== undefined ? { operationId: entry.operationId } : {})
      })),
    changeToOperations: [...changeToOps.entries()]
      .map(([changeId, ops]) => ({ changeId, operationKeys: [...ops].sort() }))
      .sort((a, b) => (a.changeId < b.changeId ? -1 : a.changeId > b.changeId ? 1 : 0)),
    operationToUsages: [...opToUsages.entries()]
      .map(([operationKey, usageIds]) => ({ operationKey, usageIds: [...usageIds].sort() }))
      .sort((a, b) => (a.operationKey < b.operationKey ? -1 : a.operationKey > b.operationKey ? 1 : 0)),
    usageAncestry: usages.map((usage) => ({
      usageId: usage.id,
      symbol: usage.symbol,
      ...(usage.enclosingSymbol !== undefined ? { enclosingFunction: usage.enclosingSymbol } : {}),
      file: usage.file,
      ...(usage.viaChain !== undefined ? { importedBy: usage.viaChain } : {})
    }))
  };
}

function countImports(
  analyses: ReadonlyArray<FileAnalysis>,
  resolver: ModuleResolver,
  kind: "internal" | "external" | "unresolved"
): number {
  let count = 0;
  for (const analysis of analyses) {
    for (const imp of analysis.imports) {
      const resolved = resolver.resolve(imp.specifier, analysis.file);
      if (resolved.kind === kind) count += 1;
    }
  }
  return count;
}

function countReferences(analyses: ReadonlyArray<FileAnalysis>, resolver: SymbolResolver, resolved: boolean): number {
  let count = 0;
  for (const analysis of analyses) {
    for (const call of analysis.calls) {
      if (call.rootIdentifier === undefined) continue;
      const resolution = resolver.resolveIdentifier(analysis.file, call.scopeId, call.rootIdentifier);
      const isResolved = resolution.via === "local" || resolution.via === "import" || resolution.via === "reexport";
      if (isResolved === resolved) count += 1;
    }
  }
  return count;
}

function countShadowed(analyses: ReadonlyArray<FileAnalysis>, resolver: SymbolResolver): number {
  let count = 0;
  for (const analysis of analyses) {
    for (const call of analysis.calls) {
      if (call.rootIdentifier === undefined) continue;
      const resolution = resolver.resolveIdentifier(analysis.file, call.scopeId, call.rootIdentifier);
      if (resolution.shadowed) count += 1;
    }
  }
  return count;
}

function countConfidence(usages: ReadonlyArray<DetectedUsage>): Array<{ confidence: Confidence; count: number }> {
  const counts = new Map<Confidence, number>();
  for (const usage of usages) counts.set(usage.confidence, (counts.get(usage.confidence) ?? 0) + 1);
  const order: Confidence[] = ["HIGH", "MEDIUM", "LOW", "UNKNOWN"];
  return order.filter((c) => counts.has(c)).map((c) => ({ confidence: c, count: counts.get(c)! }));
}

function countKind(usages: ReadonlyArray<DetectedUsage>): Array<{ kind: UsageKind; count: number }> {
  const counts = new Map<UsageKind, number>();
  for (const usage of usages) counts.set(usage.kind, (counts.get(usage.kind) ?? 0) + 1);
  return [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}
