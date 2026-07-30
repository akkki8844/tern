
import Parser from "tree-sitter";
import { ImportBinding } from "./interfaces";

export interface ParsedCallSite {
  file: string;
  line: number;
  column: number;
  functionName: string;
  resolvedName: string;
  importBinding?: ImportBinding;
  importPath?: string;
  snippet: string;
  contextBefore: string;
  contextAfter: string;
  argumentText: string;
  pattern: "fetch" | "axios" | "axios-instance" | "sdk" | "sdk-method" | "http-helper";
  httpMethod?: string;
  pathPattern?: string;
  surroundingIdentifiers: string[];
  destructuredFields: string[];
  objectSpreads: string[];
  optionalChains: string[];
  nestedMemberAccess: string[];
  asyncWrapper: boolean;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];
const METHOD_HINTS = { get: "GET", retrieve: "GET", list: "GET", find: "GET", fetch: "GET", post: "POST", create: "POST", add: "POST", submit: "POST", put: "PUT", update: "PUT", replace: "PUT", patch: "PATCH", modify: "PATCH", delete: "DELETE", remove: "DELETE", destroy: "DELETE" };

export function extractCallSites(tree: Parser.Tree, file: string, content: string, bindings: Map<string, ImportBinding>): ParsedCallSite[] {
  const lines = content.split("\n");
  const sites: ParsedCallSite[] = [];
  const cursor = tree.walk();
  const visit = () => {
    const node = cursor.currentNode;
    if (node.type === "call_expression") {
      const site = classifyCallSite(node, file, content, lines, bindings);
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

function classifyCallSite(node: Parser.SyntaxNode, file: string, content: string, lines: string[], bindings: Map<string, ImportBinding>): ParsedCallSite | null {
  const fnNode = node.childForFieldName("function");
  if (!fnNode) return null;
  const resolvedName = fnNode.text;
  const importBinding = resolveBinding(fnNode, bindings);
  const name = resolveCallName(fnNode, bindings);
  if (!name) return null;
  const line = node.startPosition.row;
  const snippet = lines[line] || "";
  const argNode = node.childForFieldName("arguments");
  const argumentText = argNode?.text || "";
  const pattern = classifyPattern(name, resolvedName, importBinding);
  if (pattern === "http-helper" && !isHttpRelated(name, resolvedName, snippet, argumentText)) return null;
  return {
    file, line: line + 1, column: node.startPosition.column + 1,
    functionName: name, resolvedName,
    importBinding, importPath: importBinding?.source,
    snippet, contextBefore: lines.slice(Math.max(0, line - 2), line).join("\n"), contextAfter: lines.slice(line + 1, line + 3).join("\n"),
    argumentText, pattern,
    httpMethod: inferHttpMethod(name, resolvedName, snippet, argumentText),
    pathPattern: inferPathPattern(snippet, argumentText),
    surroundingIdentifiers: extractIdentifiers(node),
    destructuredFields: extractDestructuredFields(node),
    objectSpreads: extractObjectSpreads(node),
    optionalChains: extractOptionalChains(node),
    nestedMemberAccess: extractNestedMemberAccess(fnNode),
    asyncWrapper: hasAsyncWrapper(node)
  };
}

function resolveBinding(node: Parser.SyntaxNode, bindings: Map<string, ImportBinding>): ImportBinding | undefined {
  const first = node.text.split(".")[0];
  return bindings.get(first);
}

function resolveCallName(node: Parser.SyntaxNode, bindings: Map<string, ImportBinding>): string | null {
  const text = node.text;
  const parts = text.split(".");
  const binding = bindings.get(parts[0]);
  if (binding?.isNamespace && parts.length > 1) return parts[1];
  if (binding?.isRenamed && binding.aliasMap && parts[1] && binding.aliasMap.has(parts[1])) return binding.aliasMap.get(parts[1]) || parts[1];
  return text;
}

function classifyPattern(name: string, resolvedName: string, binding?: ImportBinding): ParsedCallSite["pattern"] {
  if (name === "fetch" || resolvedName.endsWith(".fetch")) return "fetch";
  if (resolvedName === "axios" || resolvedName.startsWith("axios.")) return "axios";
  if (resolvedName.includes("axios.create") || resolvedName.endsWith("Api") || resolvedName.endsWith("Client") || resolvedName.endsWith("Instance")) return "axios-instance";
  if (binding && isSdkImport(binding.source)) return "sdk";
  if (isSdkMethodName(resolvedName)) return "sdk-method";
  return "http-helper";
}

function isSdkImport(source: string): boolean {
  const sdkMarkers = ["sdk", "client", "api", "openapi", "acmepay", "stripe", "twilio", "sendgrid", "aws-sdk", "@/"];
  return sdkMarkers.some(m => source.toLowerCase().includes(m));
}

function isSdkMethodName(name: string): boolean {
  const lower = name.toLowerCase();
  const hints = ["create", "get", "list", "update", "delete", "charge", "payment", "customer", "account", "invoice", "subscription", "retrieve", "find", "post", "submit"];
  return hints.some(h => lower.includes(h));
}

function isHttpRelated(name: string, resolvedName: string, snippet: string, argumentText: string): boolean {
  if (HTTP_METHODS.includes(name.toLowerCase())) return true;
  if (resolvedName.toLowerCase() === "fetch" || snippet.includes("http") || snippet.includes("/api/") || snippet.includes("/v")) return true;
  if (/api\.|\/v\d|http|endpoint|url|baseurl/i.test(argumentText)) return true;
  return false;
}

function inferHttpMethod(name: string, resolvedName: string, snippet: string, argumentText: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, method] of Object.entries(METHOD_HINTS)) {
    if (lower === key || lower.endsWith(key)) return method;
  }
  const m = snippet.match(/method:\s*['"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)['"`]/i);
  if (m) return m[1].toUpperCase();
  const argM = argumentText.match(/method:\s*['"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)['"`]/i);
  if (argM) return argM[1].toUpperCase();
  return undefined;
}

function inferPathPattern(snippet: string, argumentText: string): string | undefined {
  const re = /['"`](\/[a-zA-Z0-9_\-{}./]+)['"`]/;
  const m = snippet.match(re) || argumentText.match(re);
  return m ? m[1] : undefined;
}

function extractIdentifiers(node: Parser.SyntaxNode): string[] {
  const ids = new Set<string>();
  const visit = (n: Parser.SyntaxNode) => {
    if (n.type === "identifier" || n.type === "property_identifier") ids.add(n.text);
    n.children.forEach(visit);
  };
  visit(node);
  return [...ids];
}

function extractDestructuredFields(node: Parser.SyntaxNode): string[] {
  const fields = new Set<string>();
  const visit = (n: Parser.SyntaxNode) => {
    if (n.type === "object_pattern") {
      n.children.forEach(c => {
        if (c.type === "shorthand_property_identifier" || c.type === "identifier" || c.type === "property_identifier") fields.add(c.text);
      });
    }
    n.children.forEach(visit);
  };
  visit(node);
  return [...fields];
}

function extractObjectSpreads(node: Parser.SyntaxNode): string[] {
  const spreads = new Set<string>();
  const visit = (n: Parser.SyntaxNode) => {
    if (n.type === "spread_element") {
      const expr = n.childForFieldName("expression");
      if (expr) spreads.add(expr.text);
    }
    n.children.forEach(visit);
  };
  visit(node);
  return [...spreads];
}

function extractOptionalChains(node: Parser.SyntaxNode): string[] {
  const chains = new Set<string>();
  const visit = (n: Parser.SyntaxNode) => {
    if (n.type === "optional_chain") {
      const expr = n.previousSibling;
      if (expr) chains.add(expr.text);
    }
    n.children.forEach(visit);
  };
  visit(node);
  return [...chains];
}

function extractNestedMemberAccess(node: Parser.SyntaxNode): string[] {
  const parts: string[] = [];
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (current.type === "member_expression" || current.type === "call_expression") {
      const property = current.childForFieldName("property");
      if (property) parts.unshift(property.text);
    }
    current = current.parent;
  }
  return parts;
}

function hasAsyncWrapper(node: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (current.type === "await_expression" || current.type === "async_function" || current.type === "arrow_function") return true;
    current = current.parent;
  }
  return false;
}
