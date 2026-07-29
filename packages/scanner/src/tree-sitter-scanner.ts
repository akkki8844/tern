
import { readFile, readdir, stat } from "fs/promises";
import path from "path";
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import { BreakingChange, AffectedUsage } from "@tern/shared";
import { CodeScanner, ScanOptions, CallSite, ImportBinding, ScanBenchmark } from "./interfaces";

const DEFAULT_INCLUDE = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"];
const DEFAULT_EXCLUDE = ["node_modules", "dist", ".git", "coverage", "*.d.ts", "*.test.*", "*.spec.*"];
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

export class TreeSitterScanner implements CodeScanner {
  private parser: Parser;
  private bindingsByFile = new Map<string, Map<string, ImportBinding>>();
  private benchmark: ScanBenchmark = { filesScanned: 0, totalLines: 0, callSitesFound: 0, matchesFound: 0, durationMs: 0 };

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(TypeScript as unknown as Parser.Language);
  }

  async scan(repoPath: string, changes: BreakingChange[], options?: ScanOptions): Promise<AffectedUsage[]> {
    const start = performance.now();
    this.benchmark = { filesScanned: 0, totalLines: 0, callSitesFound: 0, matchesFound: 0, durationMs: 0 };
    const resolved = path.resolve(repoPath);
    const files = await this.collectFiles(resolved, options);
    const allSites: CallSite[] = [];
    for (const file of files) {
      const content = await this.readFileSafe(file);
      if (content === null) continue;
      this.benchmark.filesScanned += 1;
      this.benchmark.totalLines += content.split("\n").length;
      const bindings = this.extractImportBindings(file, content);
      this.bindingsByFile.set(file, bindings);
      const sites = this.extractCallSites(file, content, bindings);
      allSites.push(...sites);
      this.benchmark.callSitesFound += sites.length;
    }
    const usages = this.matchToBreakingChanges(allSites, changes, resolved);
    this.benchmark.matchesFound = usages.length;
    this.benchmark.durationMs = Math.round(performance.now() - start);
    return this.rankAndDeduplicate(usages);
  }

  getBenchmark(): ScanBenchmark { return { ...this.benchmark }; }

  private async collectFiles(dir: string, options?: ScanOptions): Promise<string[]> {
    const include = options?.include ?? DEFAULT_INCLUDE;
    const exclude = options?.exclude ?? DEFAULT_EXCLUDE;
    const maxFiles = options?.maxFiles ?? 10000;
    const files: string[] = [];
    await this.walk(dir, dir, files, include, exclude, maxFiles);
    return files;
  }

  private async walk(root: string, dir: string, files: string[], include: string[], exclude: string[], maxFiles: number): Promise<void> {
    if (files.length >= maxFiles) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(root, fullPath);
      if (exclude.some(p => this.matchesPattern(relPath, p))) continue;
      if (entry.isDirectory()) {
        if (exclude.some(p => entry.name === p || relPath === p)) continue;
        await this.walk(root, fullPath, files, include, exclude, maxFiles);
      } else if (entry.isFile()) {
        if (include.some(p => this.matchesPattern(relPath, p)) && !exclude.some(p => this.matchesPattern(relPath, p))) {
          const s = await stat(fullPath).catch(() => ({ size: 0 }));
          if (s.size > MAX_FILE_SIZE) continue;
          if (s.size === 0) continue;
          files.push(fullPath);
        }
      }
    }
  }

  private matchesPattern(filePath: string, pattern: string): boolean {
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$");
      return regex.test(filePath);
    }
    return filePath === pattern || filePath.startsWith(pattern + "/");
  }

  private async readFileSafe(file: string): Promise<string | null> {
    try {
      return await readFile(file, "utf8");
    } catch {
      return null;
    }
  }

  private extractImportBindings(file: string, content: string): Map<string, ImportBinding> {
    const tree = this.parser.parse(content);
    const bindings = new Map<string, ImportBinding>();
    const cursor = tree.walk();
    const visit = () => {
      const node = cursor.currentNode;
      if (node.type === "import_statement" || node.type === "import_declaration") {
        const source = this.extractImportSource(node, content);
        if (source) {
          this.extractBindings(node, content, source, bindings);
        }
      }
      if (cursor.gotoFirstChild()) {
        do { visit(); } while (cursor.gotoNextSibling());
        cursor.gotoParent();
      }
    };
    visit();
    return bindings;
  }

  private extractImportSource(node: Parser.SyntaxNode, content: string): string | undefined {
    const sourceNode = node.childForFieldName("source");
    if (sourceNode) {
      return sourceNode.text.replace(/['"]/g, "");
    }
    return undefined;
  }

  private extractBindings(node: Parser.SyntaxNode, content: string, source: string, bindings: Map<string, ImportBinding>): void {
    for (const child of node.children) {
      if (child.type === "identifier") {
        bindings.set(child.text, { name: child.text, source, isDefault: true, isNamespace: false, isRenamed: false, localName: child.text });
      } else if (child.type === "namespace_import") {
        const id = child.childForFieldName("name")?.text;
        if (id) bindings.set(id, { name: id, source, isDefault: false, isNamespace: true, isRenamed: false, localName: id });
      } else if (child.type === "named_imports") {
        for (const spec of child.children) {
          if (spec.type === "import_specifier") {
            const nameNode = spec.childForFieldName("name");
            const aliasNode = spec.childForFieldName("alias") || nameNode;
            const name = nameNode?.text;
            const alias = aliasNode?.text;
            if (name && alias) {
              bindings.set(alias, { name, source, isDefault: false, isNamespace: false, isRenamed: name !== alias, localName: alias, aliasMap: new Map([[name, alias]]) });
            }
          }
        }
      } else if (child.type === "import_clause") {
        for (const c of child.children) {
          if (c.type === "identifier") {
            bindings.set(c.text, { name: c.text, source, isDefault: true, isNamespace: false, isRenamed: false, localName: c.text });
          } else if (c.type === "named_imports") {
            this.extractBindings(c, content, source, bindings);
          } else if (c.type === "namespace_import") {
            const id = c.childForFieldName("name")?.text;
            if (id) bindings.set(id, { name: id, source, isDefault: false, isNamespace: true, isRenamed: false, localName: id });
          }
        }
      }
    }
  }

  private extractCallSites(file: string, content: string, bindings: Map<string, ImportBinding>): CallSite[] {
    const tree = this.parser.parse(content);
    const sites: CallSite[] = [];
    const lines = content.split("\n");
    const cursor = tree.walk();
    const visit = () => {
      const node = cursor.currentNode;
      if (node.type === "call_expression") {
        const site = this.classifyCallSite(file, content, lines, node, bindings);
        if (site) sites.push(site);
      }
      if (cursor.gotoFirstChild()) {
        do { visit(); } while (cursor.gotoNextSibling());
        cursor.gotoParent();
      }
    };
    visit();
    return sites;
  }

  private classifyCallSite(file: string, content: string, lines: string[], node: Parser.SyntaxNode, bindings: Map<string, ImportBinding>): CallSite | null {
    const fnNode = node.childForFieldName("function");
    if (!fnNode) return null;
    const name = this.resolveCallName(fnNode, bindings);
    const resolved = this.resolveFunctionName(fnNode, content);
    const line = node.startPosition.row;
    const snippet = lines[line] || "";
    const argumentNodes = this.extractArguments(node);
    const surroundingIdentifiers = this.extractIdentifiers(node, content);
    const destructuredFields = this.extractDestructuredFields(node, content);
    const objectSpreads = this.extractObjectSpreads(node, content);
    const optionalChains = this.extractOptionalChains(node, content);
    const genericWrappers = this.detectGenericWrappers(node, content);
    const importBinding = this.findBindingForCall(fnNode, bindings);
    const importPath = importBinding?.source;
    let pattern: CallSite["pattern"] = "http-helper";

    if (name === "fetch" || resolved.endsWith(".fetch") || resolved === "fetch") pattern = "fetch";
    else if (resolved === "axios" || resolved.startsWith("axios.")) pattern = "axios";
    else if (resolved.includes("axios.create") || resolved.endsWith("Api") || resolved.endsWith("Client")) pattern = "axios-instance";
    else if (importBinding && this.isSdkImport(importBinding.source)) pattern = "sdk";
    else if (this.isSdkMethodName(resolved, name, bindings)) pattern = "sdk-method";
    else if (!this.isHttpRelated(name, resolved, argumentNodes, snippet)) return null;

    const httpMethod = this.inferHttpMethod(name, resolved, snippet, argumentNodes);
    const pathPattern = this.inferPathPattern(snippet, argumentNodes);
    return {
      file, line: line + 1, column: node.startPosition.column + 1,
      functionName: name, resolvedName: resolved,
      importPath, importBinding,
      snippet, contextBefore: lines.slice(Math.max(0, line - 2), line).join("\n"),
      contextAfter: lines.slice(line + 1, line + 3).join("\n"),
      pattern, httpMethod, pathPattern, argumentNodes,
      surroundingIdentifiers, destructuredFields, objectSpreads, optionalChains, genericWrappers
    };
  }

  private resolveCallName(node: Parser.SyntaxNode, bindings: Map<string, ImportBinding>): string {
    const text = node.text;
    const parts = text.split(".");
    const first = parts[0];
    const binding = bindings.get(first);
    if (binding?.isNamespace && parts.length > 1) return parts[1];
    if (binding?.isRenamed && binding.aliasMap?.has(parts[1])) return binding.aliasMap.get(parts[1]) || parts[1];
    return text;
  }

  private resolveFunctionName(node: Parser.SyntaxNode, content: string): string {
    return node.text;
  }

  private findBindingForCall(node: Parser.SyntaxNode, bindings: Map<string, ImportBinding>): ImportBinding | undefined {
    const text = node.text;
    const first = text.split(".")[0];
    return bindings.get(first);
  }

  private isSdkImport(source: string): boolean {
    const sdkMarkers = ["sdk", "client", "api", "openapi", "acmepay", "stripe", "twilio", "sendgrid", "aws-sdk", "@"];
    return sdkMarkers.some(m => source.toLowerCase().includes(m));
  }

  private isSdkMethodName(resolved: string, name: string, bindings: Map<string, ImportBinding>): boolean {
    const sdkMarkers = ["create", "get", "list", "update", "delete", "charge", "payment", "customer", "account", "invoice", "subscription"];
    if (sdkMarkers.some(m => resolved.toLowerCase().includes(m)) && sdkMarkers.some(m => name.toLowerCase().includes(m))) return true;
    return false;
  }

  private isHttpRelated(name: string, resolved: string, args: { text: string }[], snippet: string): boolean {
    const httpMethods = ["get", "post", "put", "patch", "delete", "head", "options"];
    if (httpMethods.includes(name.toLowerCase())) return true;
    if (name === "fetch" || resolved.startsWith("http") || snippet.includes("http")) return true;
    if (args.some(a => /api\.|/v\d|http|endpoint|url/i.test(a.text))) return true;
    return false;
  }

  private inferHttpMethod(name: string, resolved: string, snippet: string, args: { text: string }[]): string | undefined {
    const lower = name.toLowerCase();
    const methodMap: Record<string, string> = {
      get: "GET", retrieve: "GET", list: "GET", find: "GET", fetch: "GET",
      post: "POST", create: "POST", add: "POST", submit: "POST",
      put: "PUT", update: "PUT", replace: "PUT",
      patch: "PATCH", modify: "PATCH",
      delete: "DELETE", remove: "DELETE", destroy: "DELETE"
    };
    for (const [key, method] of Object.entries(methodMap)) {
      if (lower === key || lower.endsWith(key)) return method;
    }
    const m = snippet.match(/method:\s*['"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"`]/i);
    if (m) return m[1].toUpperCase();
    const firstArg = args[0]?.text;
    if (firstArg && /method:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/i.test(firstArg)) {
      const mm = firstArg.match(/method:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/i);
      if (mm) return mm[1].toUpperCase();
    }
    return undefined;
  }

  private inferPathPattern(snippet: string, args: { text: string }[]): string | undefined {
    const matches = snippet.match(/['"`](\/[a-zA-Z0-9_\-{}./]+)['"`]/);
    if (matches) return matches[1];
    const firstArg = args[0]?.text;
    if (firstArg) {
      const m = firstArg.match(/['"`](\/[a-zA-Z0-9_\-{}./]+)['"`]/);
      if (m) return m[1];
    }
    return undefined;
  }

  private extractArguments(node: Parser.SyntaxNode): { type: string; text: string; startLine: number; endLine: number }[] {
    const args = node.childForFieldName("arguments");
    if (!args) return [];
    return args.children.filter(c => !c.isNamed).map(c => ({
      type: c.type, text: c.text,
      startLine: c.startPosition.row, endLine: c.endPosition.row
    }));
  }

  private extractIdentifiers(node: Parser.SyntaxNode, content: string): string[] {
    const ids: string[] = [];
    const visit = (n: Parser.SyntaxNode) => {
      if (n.type === "identifier" || n.type === "property_identifier") ids.push(n.text);
      n.children.forEach(visit);
    };
    visit(node);
    return [...new Set(ids)];
  }

  private extractDestructuredFields(node: Parser.SyntaxNode, content: string): string[] {
    const fields: string[] = [];
    const visit = (n: Parser.SyntaxNode) => {
      if (n.type === "object_pattern") {
        n.children.forEach(c => {
          if (c.type === "shorthand_property_identifier" || c.type === "identifier") fields.push(c.text);
        });
      }
      n.children.forEach(visit);
    };
    visit(node);
    return [...new Set(fields)];
  }

  private extractObjectSpreads(node: Parser.SyntaxNode, content: string): string[] {
    const spreads: string[] = [];
    const visit = (n: Parser.SyntaxNode) => {
      if (n.type === "spread_element") {
        const expr = n.childForFieldName("expression");
        if (expr) spreads.push(expr.text);
      }
      n.children.forEach(visit);
    };
    visit(node);
    return spreads;
  }

  private extractOptionalChains(node: Parser.SyntaxNode, content: string): string[] {
    const chains: string[] = [];
    const visit = (n: Parser.SyntaxNode) => {
      if (n.type === "optional_chain") {
        const expr = n.previousSibling || n.parent;
        if (expr) chains.push(expr.text);
      }
      n.children.forEach(visit);
    };
    visit(node);
    return [...new Set(chains)];
  }

  private detectGenericWrappers(node: Parser.SyntaxNode, content: string): string[] {
    const wrappers: string[] = [];
    let parent = node.parent;
    while (parent) {
      if (["await_expression", "try_statement", "catch_clause", "arrow_function", "function_declaration", "call_expression"].includes(parent.type)) {
        wrappers.push(parent.type);
      }
      parent = parent.parent;
    }
    return [...new Set(wrappers)];
  }

  private matchToBreakingChanges(sites: CallSite[], changes: BreakingChange[], repoPath: string): AffectedUsage[] {
    const usages: AffectedUsage[] = [];
    const seen = new Set<string>();
    for (const site of sites) {
      const best = this.findBestMatch(site, changes);
      if (best) {
        const key = `${site.file}:${site.line}:${best.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        usages.push({
          id: crypto.randomUUID(),
          file: path.relative(repoPath, site.file),
          line: site.line,
          column: site.column,
          functionName: site.functionName,
          importPath: site.importPath,
          snippet: site.snippet,
          contextBefore: site.contextBefore,
          contextAfter: site.contextAfter,
          confidence: best.confidence,
          breakingChangeId: best.change.id,
          operationId: site.operationId || best.change.operationId,
          httpMethod: site.httpMethod || best.change.method,
          pathPattern: site.pathPattern || best.change.path
        });
      }
    }
    return usages;
  }

  private findBestMatch(site: CallSite, changes: BreakingChange[]): { change: BreakingChange; confidence: "high" | "medium" | "low" } | null {
    let best: { change: BreakingChange; score: number; confidence: "high" | "medium" | "low" } | null = null;
    for (const change of changes) {
      const score = this.scoreMatch(site, change);
      if (score >= 8) {
        if (!best || score > best.score) best = { change, score, confidence: "high" };
      } else if (score >= 4) {
        if (!best || score > best.score) best = { change, score, confidence: "medium" };
      } else if (score >= 2) {
        if (!best || score > best.score) best = { change, score, confidence: "low" };
      }
    }
    return best ? { change: best.change, confidence: best.confidence } : null;
  }

  private scoreMatch(site: CallSite, change: BreakingChange): number {
    let score = 0;
    if (change.operationId && (site.functionName.toLowerCase().includes(change.operationId.toLowerCase()) || site.resolvedName.toLowerCase().includes(change.operationId.toLowerCase()))) {
      score += 10;
    }
    if (change.path && (site.pathPattern === change.path || site.snippet.includes(change.path))) {
      score += 8;
    }
    if (change.path && change.path.split("/").filter(p => p.length > 1 && !p.startsWith("{")).some(part => {
      const re = new RegExp(`\b${part.replace(/[-/\]/g, "\\$&")}\b`, "i");
      return site.snippet.match(re) || site.surroundingIdentifiers.some(id => id.toLowerCase() === part.toLowerCase());
    })) {
      score += 4;
    }
    if (change.method && site.httpMethod && change.method.toUpperCase() === site.httpMethod.toUpperCase()) {
      score += 3;
    }
    const desc = change.description.toLowerCase();
    const words = desc.split(/\s+/).filter(w => w.length > 3);
    const matches = words.filter(word => site.snippet.toLowerCase().includes(word) || site.surroundingIdentifiers.some(id => id.toLowerCase().includes(word))).length;
    score += Math.min(matches, 3);
    if (site.destructuredFields.some(f => desc.includes(f.toLowerCase()))) score += 1;
    if (site.objectSpreads.some(s => desc.includes(s.toLowerCase()))) score += 1;
    if (site.importPath && change.operationId && site.importPath.toLowerCase().includes(change.operationId.toLowerCase())) score += 2;
    return score;
  }

  private rankAndDeduplicate(usages: AffectedUsage[]): AffectedUsage[] {
    return usages
      .sort((a, b) => {
        const confidenceOrder = { high: 0, medium: 1, low: 2 };
        if (confidenceOrder[a.confidence] !== confidenceOrder[b.confidence]) return confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
        return b.snippet.length - a.snippet.length;
      });
  }
}

export class SimpleRegexScanner implements CodeScanner {
  async scan(repoPath: string, changes: BreakingChange[], options?: ScanOptions): Promise<AffectedUsage[]> {
    return new TreeSitterScanner().scan(repoPath, changes, options);
  }
}
