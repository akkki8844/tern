import Parser from "tree-sitter";
import TS from "tree-sitter-typescript";
import type { AffectedUsage, BreakingChange } from "@/lib/types";

const parser = new Parser();
parser.setLanguage((TS as { typescript: unknown }).typescript as never);

type SourceFile = { path: string; content: string };

export function scanTypeScriptUsages(files: SourceFile[], breakingChanges: BreakingChange[]): AffectedUsage[] {
  const results: AffectedUsage[] = [];
  const rawTargets = breakingChanges.flatMap((change) => [change.endpoint, change.oldValue, change.newValue, change.operationId].filter(Boolean)) as string[];
  const targets = [...new Set(rawTargets.flatMap((target) => [target, target.replace(/\{[^}]+\}/g, ""), target.replace(/\{([^}]+)\}/g, "${$1}")]))].filter(Boolean);

  for (const file of files) {
    const tree = parser.parse(file.content);
    const lines = file.content.split("\n");

    tree.rootNode.descendantsOfType(["call_expression", "import_statement", "member_expression", "subscript_expression", "pair"]).forEach((node) => {
      const text = node.text;
      if (!targets.some((target) => target && text.includes(target))) return;
      if (![".ts", ".tsx"].some((suffix) => file.path.endsWith(suffix))) return;

      const line = node.startPosition.row + 1;
      results.push({
        filePath: file.path,
        line,
        snippet: lines[line - 1]?.trim() ?? text,
        matchedSymbol: targets.find((target) => text.includes(target)) ?? "unknown",
        confidence: text.includes("fetch") || text.includes("axios") ? 0.92 : 0.78,
      });
    });
  }

  return dedupeUsages(results);
}

function dedupeUsages(usages: AffectedUsage[]): AffectedUsage[] {
  const seen = new Set<string>();
  return usages.filter((usage) => {
    const key = `${usage.filePath}:${usage.line}:${usage.matchedSymbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
