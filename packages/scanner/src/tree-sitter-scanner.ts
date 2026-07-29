
import { readFile, readdir } from "fs/promises";
import path from "path";
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import { BreakingChange, AffectedUsage } from "@tern/shared";
import { CodeScanner, SourceFile, CallSite } from "./interfaces";

export class TreeSitterScanner implements CodeScanner {
  private parser: Parser;
  private supportedExtensions = [".ts", ".tsx", ".js", ".jsx"];

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(TypeScript as unknown as Parser.Language);
  }

  async scan(repoPath: string, changes: BreakingChange[]): Promise<AffectedUsage[]> {
    const files = await this.collectFiles(repoPath);
    const sites: CallSite[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const fileSites = this.extractCallSites(file, content, changes);
      sites.push(...fileSites);
    }
    return this.matchToBreakingChanges(sites, changes, repoPath);
  }

  private async collectFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "dist", ".git", "coverage"].includes(entry.name)) continue;
        files.push(...await this.collectFiles(fullPath));
      } else if (this.supportedExtensions.some(ext => entry.name.endsWith(ext))) {
        files.push(fullPath);
      }
    }
    return files;
  }

  private extractCallSites(file: string, content: string, changes: BreakingChange[]): CallSite[] {
    const tree = this.parser.parse(content);
    const sites: CallSite[] = [];
    const cursor = tree.walk();
    const lines = content.split("\n");

    const visitNode = () => {
      const node = cursor.currentNode;
      if (node.type === "call_expression") {
        const name = this.getCallName(node);
        const line = node.startPosition.row;
        const column = node.startPosition.column;
        const importPath = this.findImportPath(node, content);
        const site = this.classifyCallSite(file, lines, name, node, line, column, importPath);
        if (site) sites.push(site);
      }
      if (cursor.gotoFirstChild()) {
        do { visitNode(); } while (cursor.gotoNextSibling());
        cursor.gotoParent();
      }
    };
    visitNode();
    return sites;
  }

  private getCallName(node: Parser.SyntaxNode): string {
    const fn = node.childForFieldName("function");
    if (!fn) return "";
    if (fn.type === "identifier") return fn.text;
    if (fn.type === "member_expression") return fn.text;
    if (fn.type === "property_identifier") return fn.text;
    return fn.text;
  }

  private findImportPath(node: Parser.SyntaxNode, content: string): string | undefined {
    const fn = node.childForFieldName("function");
    if (!fn) return undefined;
    const name = fn.text.split(".")[0];
    const importRegex = new RegExp(`import\\s+.*?\\b${name}\\b\\s+from\\s+['"]([^'"]+)['"]`, "m");
    const match = content.match(importRegex);
    return match ? match[1] : undefined;
  }

  private classifyCallSite(file: string, lines: string[], name: string, node: Parser.SyntaxNode, line: number, column: number, importPath?: string): CallSite | null {
    const snippet = lines[line] || "";
    const contextBefore = lines.slice(Math.max(0, line - 2), line).join("\n");
    const contextAfter = lines.slice(line + 1, line + 3).join("\n");

    if (name === "fetch" || name.endsWith(".fetch")) {
      return { file, line: line + 1, column: column + 1, functionName: "fetch", importPath, snippet, contextBefore, contextAfter, pattern: "fetch" };
    }
    if (name === "axios" || name.startsWith("axios.")) {
      return { file, line: line + 1, column: column + 1, functionName: "axios", importPath, snippet, contextBefore, contextAfter, pattern: "axios" };
    }
    if (importPath && (importPath.includes("acmepay") || importPath.includes("sdk") || importPath.includes("client"))) {
      return { file, line: line + 1, column: column + 1, functionName: name, importPath, snippet, contextBefore, contextAfter, pattern: "sdk" };
    }
    if (name && (name.includes("Charge") || name.includes("Payment") || name.includes("create") || name.includes("retrieve"))) {
      return { file, line: line + 1, column: column + 1, functionName: name, importPath, snippet, contextBefore, contextAfter, pattern: "method" };
    }
    return null;
  }

  private matchToBreakingChanges(sites: CallSite[], changes: BreakingChange[], repoPath: string): AffectedUsage[] {
    const usages: AffectedUsage[] = [];
    const opIds = new Set(changes.map(c => c.operationId).filter(Boolean));
    const paths = new Set(changes.map(c => c.path).filter(Boolean));

    for (const site of sites) {
      for (const change of changes) {
        const confidence = this.computeConfidence(site, change, opIds, paths);
        if (confidence) {
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
            confidence,
            breakingChangeId: change.id,
            operationId: site.operationId || change.operationId,
            httpMethod: site.httpMethod || change.method,
            pathPattern: site.pathPattern || change.path
          });
        }
      }
    }
    return usages;
  }

  private computeConfidence(site: CallSite, change: BreakingChange, opIds: Set<string | undefined>, paths: Set<string | undefined>): "high" | "medium" | "low" | null {
    if (change.operationId && site.functionName.toLowerCase().includes(change.operationId.toLowerCase())) return "high";
    if (change.path && (site.snippet.includes(change.path) || site.pathPattern === change.path)) return "high";
    if (change.method && site.httpMethod === change.method) return "medium";
    const text = site.snippet.toLowerCase();
    const desc = change.description.toLowerCase();
    let score = 0;
    if (change.operationId && text.includes(change.operationId.toLowerCase())) score += 2;
    if (change.path && change.path.split("/").some(part => part.length > 1 && text.includes(part.toLowerCase()))) score += 2;
    if (desc.split(" ").some(word => word.length > 3 && text.includes(word.toLowerCase()))) score += 1;
    if (score >= 3) return "medium";
    if (score >= 1) return "low";
    return null;
  }
}

export class SimpleRegexScanner implements CodeScanner {
  async scan(repoPath: string, changes: BreakingChange[]): Promise<AffectedUsage[]> {
    return new TreeSitterScanner().scan(repoPath, changes);
  }
}
