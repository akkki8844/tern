
import { BreakingChange, AffectedUsage } from "@tern/shared";
import { ParsedCallSite } from "./call-site-extractor.js";
import path from "path";

export function matchCallSites(sites: ParsedCallSite[], changes: BreakingChange[], repoPath: string): AffectedUsage[] {
  const usages: AffectedUsage[] = [];
  const seen = new Set<string>();
  for (const site of sites) {
    const best = findBestMatch(site, changes);
    if (!best) continue;
    const key = `${site.file}:${site.line}:${best.change.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    usages.push({
      id: crypto.randomUUID(),
      file: path.relative(repoPath, site.file),
      line: site.line, column: site.column,
      functionName: site.functionName,
      importPath: site.importPath,
      snippet: site.snippet,
      contextBefore: site.contextBefore,
      contextAfter: site.contextAfter,
      confidence: best.confidence,
      breakingChangeId: best.change.id,
      operationId: best.change.operationId,
      httpMethod: site.httpMethod || best.change.method,
      pathPattern: site.pathPattern || best.change.path
    });
  }
  return usages;
}

function findBestMatch(site: ParsedCallSite, changes: BreakingChange[]): { change: BreakingChange; confidence: "high" | "medium" | "low" } | null {
  let best: { change: BreakingChange; score: number; confidence: "high" | "medium" | "low" } | null = null;
  for (const change of changes) {
    const score = scoreMatch(site, change);
    const confidence = score >= 8 ? "high" : score >= 4 ? "medium" : score >= 2 ? "low" : null;
    if (!confidence) continue;
    if (!best || score > best.score) best = { change, score, confidence };
  }
  return best ? { change: best.change, confidence: best.confidence } : null;
}

function scoreMatch(site: ParsedCallSite, change: BreakingChange): number {
  let score = 0;
  const searchText = `${site.functionName} ${site.resolvedName} ${site.snippet} ${site.argumentText} ${site.surroundingIdentifiers.join(" ")}`.toLowerCase();
  const desc = change.description.toLowerCase();
  if (change.operationId) {
    const opId = change.operationId.toLowerCase();
    if (site.functionName.toLowerCase() === opId || site.functionName.toLowerCase().includes(opId)) score += 10;
    else if (site.resolvedName.toLowerCase().includes(opId)) score += 8;
    else if (searchText.includes(opId)) score += 4;
  }
  if (change.path) {
    const path = change.path.toLowerCase();
    if (site.pathPattern === change.path) score += 8;
    else if (site.pathPattern && path.endsWith(site.pathPattern.toLowerCase())) score += 5;
    else if (searchText.includes(path)) score += 4;
    else {
      const pathParts = change.path.split("/").filter(p => p.length > 2 && !p.startsWith("{"));
      const matched = pathParts.filter(part => searchText.includes(part.toLowerCase())).length;
      score += Math.min(matched * 2, 6);
    }
  }
  if (change.method && site.httpMethod && change.method.toUpperCase() === site.httpMethod.toUpperCase()) score += 3;
  const words = desc.split(/\s+/).filter(w => w.length > 3);
  const matchedWords = words.filter(w => searchText.includes(w)).length;
  score += Math.min(matchedWords, 3);
  if (site.destructuredFields.some(f => desc.includes(f.toLowerCase()))) score += 1;
  if (site.objectSpreads.some(s => desc.includes(s.toLowerCase()))) score += 1;
  if (site.importPath && change.operationId && site.importPath.toLowerCase().includes(change.operationId.toLowerCase())) score += 2;
  if (site.nestedMemberAccess.some(m => desc.includes(m.toLowerCase()))) score += 1;
  return score;
}
