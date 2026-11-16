/**
 * Symbol resolution.
 *
 * Binds identifier references to declarations using the per-file scope trees
 * built by the AST analysis, then resolves declarations across modules through
 * the module graph's export tables.
 *
 * Guarantees:
 * - innermost scope wins: a parameter named `client` shadows an imported
 *   module-scope `client` — the scanner never reports the shadowed import;
 * - import bindings resolve through the module graph to the exporting
 *   declaration, following re-exports (`export { x } from`, `export *`) with a
 *   bounded depth; cycles terminate;
 * - unresolved references are explicit (`undefined` result plus reason from
 *   the caller) — the scanner never pretends a binding resolved.
 */
import type { FileAnalysis, DestructuringAlias } from "../ast/analyze.js";
import type { ImportRecord, ResolvedImport, SymbolDeclaration } from "../model/types.js";
import type { ModuleResolver } from "../modules/resolver.js";

export interface ResolvedImportTable {
  /** specifier -> resolution for one file's imports. */
  readonly bySpecifier: ReadonlyMap<string, ResolvedImport>;
}

export interface ModuleInfo {
  readonly file: string;
  readonly analysis: FileAnalysis;
  readonly imports: ResolvedImportTable;
  /** Exported name -> declaration in this module (or re-export source). */
  readonly exportTable: Map<string, ExportedSymbol>;
}

export interface ExportedSymbol {
  readonly kind: "local" | "reexport" | "star";
  /** Local declaration when kind === "local". */
  readonly declaration?: SymbolDeclaration;
  readonly fromModuleId?: string;
  readonly fromName?: string;
  readonly ambiguous?: boolean;
}

export interface SymbolResolver {
  /**
   * Resolve an identifier visible at `scopeId` in `file`. Returns the
   * declaration in the defining module, following imports and re-exports.
   */
  resolveIdentifier(file: string, scopeId: string, name: string): SymbolResolution;
}

export interface SymbolResolution {
  readonly declaration: SymbolDeclaration | undefined;
  /** The file that finally declares the symbol, when resolution succeeded. */
  readonly definedIn?: string;
  /** How the reference was bound. */
  readonly via: "local" | "import" | "reexport" | "unresolved" | "external";
  /** Import specifier the reference crossed, when bound via import. */
  readonly importSpecifier?: string;
  /** True when an inner declaration shadowed an outer/imported one. */
  readonly shadowed: boolean;
}

export class DefaultSymbolResolver implements SymbolResolver {
  private readonly modules = new Map<string, ModuleInfo>();
  private readonly identifierCache = new Map<string, SymbolResolution>();
  private reExportDepthWarnings = 0;

  constructor(
    analyses: ReadonlyArray<FileAnalysis>,
    private readonly resolveModule: ModuleResolver,
    private readonly limits: { maxReExportDepth: number }
  ) {
    for (const analysis of analyses) {
      const bySpecifier = new Map<string, ResolvedImport>();
      for (const imp of analysis.imports) {
        bySpecifier.set(imp.specifier, this.resolveModule.resolve(imp.specifier, analysis.file));
      }
      this.modules.set(analysis.file, {
        file: analysis.file,
        analysis,
        imports: { bySpecifier },
        exportTable: new Map()
      });
    }
    // Export tables are built in dependency order via lazy resolution with
    // cycle guards, so no topological sort is required.
    for (const info of this.modules.values()) {
      this.buildExportTable(info, new Set());
    }
  }

  modulesInfo(): ReadonlyMap<string, ModuleInfo> {
    return this.modules;
  }

  // -- export tables --------------------------------------------------------

  private buildExportTable(info: ModuleInfo, active: Set<string>): void {
    if (info.exportTable.size > 0 || active.has(info.file)) return;
    active.add(info.file);
    const table = info.exportTable;

    for (const exp of info.analysis.exports) {
      if (exp.name === "*") {
        if (!exp.fromSpecifier) continue;
        const target = this.modules.get(this.targetModuleId(info, exp.fromSpecifier));
        if (target) {
          this.buildExportTable(target, active);
          for (const [name, symbol] of target.exportTable) {
            if (name === "default") continue; // `export *` skips default
            const existing = table.get(name);
            if (existing) {
              // Conflicting star exports stay ambiguous — never guessed.
              table.set(name, { ...existing, ambiguous: true });
            } else {
              table.set(name, symbol.kind === "local"
                ? { kind: "reexport", declaration: symbol.declaration, fromModuleId: target.file }
                : symbol);
            }
          }
        }
        continue;
      }
      if (exp.fromSpecifier) {
        const targetModuleId = this.targetModuleId(info, exp.fromSpecifier);
        const target = this.modules.get(targetModuleId);
        if (target) {
          this.buildExportTable(target, active);
          const symbol = target.exportTable.get(exp.name);
          if (symbol) {
            table.set(exp.name, symbol.kind === "local"
              ? { kind: "reexport", declaration: symbol.declaration, fromModuleId: target.file }
              : symbol);
          } else if (symbol === undefined) {
            const local = target.analysis.declarations.find((d) => d.name === exp.name && d.exported);
            if (local) table.set(exp.name, { kind: "reexport", declaration: local, fromModuleId: target.file });
          }
        }
        continue;
      }
      const local = exp.localName
        ? info.analysis.declarations.find((d) => d.name === exp.localName && d.scopeId === `${info.file}#s`)
        : undefined;
      if (local) {
        table.set(exp.name, { kind: "local", declaration: local });
      } else if (exp.name === "default") {
        table.set("default", { kind: "local", declaration: undefined });
      } else {
        table.set(exp.name, { kind: "local", declaration: undefined });
      }
    }
    active.delete(info.file);
  }

  private targetModuleId(info: ModuleInfo, specifier: string): string {
    const resolved = info.imports.bySpecifier.get(specifier);
    if (resolved && resolved.kind === "internal") return resolved.moduleId;
    const direct = this.resolveModule.resolve(specifier, info.file);
    return direct.kind === "internal" ? direct.moduleId : "";
  }

  // -- reference binding ----------------------------------------------------

  resolveIdentifier(file: string, scopeId: string, name: string): SymbolResolution {
    const cacheKey = `${file}::${scopeId}::${name}`;
    const cached = this.identifierCache.get(cacheKey);
    if (cached) return cached;
    const result = this.resolveIdentifierUncached(file, scopeId, name);
    this.identifierCache.set(cacheKey, result);
    return result;
  }

  private resolveIdentifierUncached(file: string, scopeId: string, name: string): SymbolResolution {
    const info = this.modules.get(file);
    if (!info) return { declaration: undefined, via: "unresolved", shadowed: false };

    // 1. Walk the scope chain innermost-first. This is what makes shadowing
    //    correct: the parameter `client` wins over the imported `client`.
    //    Shadowing is reported only when the name is ALSO declared in a scope
    //    further out — resolving through enclosing function scopes is normal.
    let shadowed = false;
    let currentScopeId: string | undefined = scopeId;
    const visitedScopes: string[] = [];
    while (currentScopeId) {
      const scope = info.analysis.scopes.find((s) => s.id === currentScopeId);
      if (!scope) break;
      const decl = info.analysis.declarations.find((d) => d.scopeId === scope.id && d.name === name);
      if (decl) {
        shadowed = visitedScopes.some(
          (outer) => outer !== scope.id && info.analysis.declarations.some((d) => d.scopeId === outer && d.name === name)
        );
        if (decl.kind === "import") {
          return this.resolveImported(file, decl, shadowed);
        }
        return { declaration: decl, definedIn: file, via: "local", shadowed };
      }
      visitedScopes.push(scope.id);
      currentScopeId = scope.parent;
    }

    // 2. Implicit namespace members: `ns.util()` where ns is a namespace decl.
    return { declaration: undefined, via: "unresolved", shadowed: false };
  }

  private resolveImported(file: string, decl: SymbolDeclaration, shadowed: boolean): SymbolResolution {
    const importOf = decl.importOf;
    if (!importOf) return { declaration: decl, definedIn: file, via: "local", shadowed };
    const info = this.modules.get(file);
    if (!info) return { declaration: decl, definedIn: file, via: "unresolved", shadowed };
    const resolved = info.imports.bySpecifier.get(importOf.specifier);
    if (!resolved) return { declaration: decl, definedIn: file, via: "unresolved", shadowed, importSpecifier: importOf.specifier };
    if (resolved.kind === "external") {
      // External package symbols cannot be resolved further without executing
      // or typechecking; that boundary is explicit.
      return { declaration: decl, via: "external", shadowed, importSpecifier: importOf.specifier };
    }
    if (resolved.kind === "unresolved") {
      return { declaration: decl, via: "unresolved", shadowed, importSpecifier: importOf.specifier };
    }
    const target = this.modules.get(resolved.moduleId);
    if (!target) return { declaration: decl, via: "unresolved", shadowed, importSpecifier: importOf.specifier };
    return this.resolveExportedSymbol(target, importOf.importedName ?? "default", decl, importOf.specifier, shadowed, 0);
  }

  private resolveExportedSymbol(
    target: ModuleInfo,
    name: string,
    originalImport: SymbolDeclaration,
    importSpecifier: string,
    shadowed: boolean,
    depth: number,
    crossed: "import" | "reexport" = "import"
  ): SymbolResolution {
    if (depth > this.limits.maxReExportDepth) {
      this.reExportDepthWarnings += 1;
      return { declaration: originalImport, via: "unresolved", shadowed, importSpecifier };
    }
    const entry = target.exportTable.get(name);
    if (!entry) {
      // The module exists but does not export the name (or uses constructs we
      // do not model, e.g. computed exports). Explicitly unresolved.
      return { declaration: originalImport, via: "unresolved", shadowed, importSpecifier };
    }
    if (entry.ambiguous) {
      return { declaration: originalImport, via: "unresolved", shadowed, importSpecifier };
    }
    if (entry.kind === "local") {
      return {
        declaration: entry.declaration ?? originalImport,
        definedIn: entry.declaration ? target.file : undefined,
        via: entry.declaration ? crossed : "unresolved",
        shadowed,
        importSpecifier
      };
    }
    // Re-export: follow to the defining module, remembering the crossing.
    const next = entry.fromModuleId ? this.modules.get(entry.fromModuleId) : undefined;
    if (!next) return { declaration: originalImport, via: "unresolved", shadowed, importSpecifier };
    return this.resolveExportedSymbol(next, entry.fromName ?? name, originalImport, importSpecifier, shadowed, depth + 1, crossed === "import" ? "reexport" : crossed);
  }

  unresolvedReExports(): number {
    return this.reExportDepthWarnings;
  }

  // -- helpers for adapter context -------------------------------------------

  /** All declarations named `name` at module scope of `file` (import or local). */
  moduleScopeDeclarations(file: string, name: string): SymbolDeclaration[] {
    const info = this.modules.get(file);
    if (!info) return [];
    return info.analysis.declarations.filter((d) => d.scopeId === `${file}#s` && d.name === name);
  }

  /** Destructuring aliases of a file (response-flow inputs). */
  destructuringAliases(file: string): ReadonlyArray<DestructuringAlias> {
    return this.modules.get(file)?.analysis.destructuringAliases ?? [];
  }

  importRecord(file: string, specifier: string): ImportRecord | undefined {
    return this.modules.get(file)?.analysis.imports.find((i) => i.specifier === specifier);
  }
}
