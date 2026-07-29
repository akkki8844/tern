
import { readFile } from "fs/promises";
import { join } from "path";
import { BreakingChange, AffectedUsage, MigrationPatch, getConfig, getLogger } from "@tern/shared";
import { MigrationInstruction } from "@tern/openapi";
import { LlmAdapter, MockLlmAdapter } from "@tern/llm";
import { MigrationEngine, TransformResult } from "./interfaces";
import { DefaultPatchValidator } from "./validator";
import { getRule } from "./rules";
import { generateUnifiedDiff } from "./diff";
const logger = getLogger("migration-engine");

export class DefaultMigrationEngine implements MigrationEngine {
  private validator = new DefaultPatchValidator();
  private llm: LlmAdapter;
  private instructions = new Map<string, MigrationInstruction>();
  private stats = { rulesApplied: 0, llmInvocations: 0, failedRules: 0 };

  constructor(llm?: LlmAdapter) {
    this.llm = llm || (getConfig().FIREWORKS_API_KEY ? new (require("@tern/llm").FireworksAdapter)() : new MockLlmAdapter());
  }

  async generatePatches(repoPath: string, changes: BreakingChange[], usages: AffectedUsage[], instructions?: MigrationInstruction[]): Promise<MigrationPatch[]> {
    if (instructions) {
      for (const i of instructions) this.instructions.set(i.description, i);
    }
    const patches: MigrationPatch[] = [];
    const byFile = groupByFile(usages);
    for (const [filePath, fileUsages] of byFile.entries()) {
      const fullPath = join(repoPath, filePath);
      const content = await readFile(fullPath, "utf8").catch(() => null);
      if (content === null) continue;
      const result = await this.transformFile(content, fileUsages, changes);
      if (result.content === content) continue;
      const patch = this.buildPatch(filePath, content, result, fileUsages, changes);
      const validation = this.validator.validate(patch);
      patch.validationStatus = validation.valid ? "valid" : "invalid";
      patch.validationErrors = validation.errors;
      patch.validationWarnings = validation.warnings;
      if (validation.valid) {
        patches.push(patch);
      } else {
        logger.warn({ filePath, errors: validation.errors }, "patch rejected by validator");
      }
    }
    return rankPatches(patches);
  }

  getStats() { return { ...this.stats }; }

  private async transformFile(content: string, usages: AffectedUsage[], changes: BreakingChange[]): Promise<TransformResult> {
    let result: TransformResult = { content, confidence: 1, appliedRules: [], failedRules: [] };
    const sorted = [...usages].sort((a, b) => b.line - a.line);
    for (const usage of sorted) {
      const change = changes.find(c => c.id === usage.breakingChangeId);
      if (!change) continue;
      const instruction = this.instructions.get(change.description);
      const rule = getRule(change.type);
      let modified: string | null = null;
      if (rule) {
        modified = rule.apply(change, usage, result.content, instruction);
        if (modified !== null && modified !== result.content) {
          result.content = modified;
          result.appliedRules.push(rule.type);
          this.stats.rulesApplied += 1;
          continue;
        }
      }
      // Only use LLM for high/medium confidence usages; low confidence is unsafe to auto-rewrite
      if ((usage.confidence === "high" || usage.confidence === "medium") && (!rule || modified === null)) {
        modified = await this.llmFallback(change, usage, result.content);
        if (modified !== null && modified !== result.content) {
          result.content = modified;
          result.appliedRules.push("llm");
          this.stats.llmInvocations += 1;
          continue;
        }
      }
      result.failedRules.push(change.type);
      this.stats.failedRules += 1;
    }
    result.confidence = computeConfidence(result);
    return result;
  }

  private async llmFallback(change: BreakingChange, usage: AffectedUsage, content: string): Promise<string | null> {
    try {
      const prompt = buildLlmPrompt(change, usage, content);
      const response = await this.llm.complete([
        { role: "system", content: "You are a precise code migration assistant. Rewrite ONLY the affected code to be compatible with the new API. Do not change unrelated code. Do not add secrets, dependencies, or configuration files. Return only the complete replacement code for the file." },
        { role: "user", content: prompt }
      ]);
      const trimmed = response.content.trim();
      if (!trimmed) return null;
      return stripCodeFences(trimmed);
    } catch (err) {
      logger.error({ err, changeId: change.id }, "llm fallback failed");
      return null;
    }
  }

  private buildPatch(filePath: string, original: string, result: TransformResult, usages: AffectedUsage[], changes: BreakingChange[]): MigrationPatch {
    const diff = generateUnifiedDiff(original, result.content, filePath);
    const changeIds = usages.map(u => u.breakingChangeId);
    const descriptions = changes.filter(c => changeIds.includes(c.id)).map(c => c.description).join("; ");
    return {
      id: crypto.randomUUID(),
      filePath,
      original,
      modified: result.content,
      description: `Migrate ${filePath} for: ${descriptions}`,
      breakingChangeId: changeIds[0],
      validationStatus: "pending",
      validationErrors: [],
      validationWarnings: [],
      diff,
      lineCountChanged: Math.abs(result.content.split("\n").length - original.split("\n").length),
      confidence: result.confidence,
      appliedRules: result.appliedRules
    };
  }
}

function buildLlmPrompt(change: BreakingChange, usage: AffectedUsage, content: string): string {
  return [
    `Breaking change: ${change.description}`,
    "",
    "Affected code snippet:",
    usage.snippet,
    "",
    "Context:",
    usage.contextBefore,
    usage.snippet,
    usage.contextAfter,
    "",
    "File so far:",
    content,
    "",
    "Rewrite only the affected portion to be compatible with the new API. Return the complete file content."
  ].join("\n");
}

function stripCodeFences(content: string): string {
  return content.replace(/^```[a-zA-Z0-9]*\n?/, "").replace(/\n?```\s*$/, "");
}

function computeConfidence(result: TransformResult): number {
  const total = result.appliedRules.length + result.failedRules.length;
  if (total === 0) return 1;
  const ratio = result.appliedRules.length / total;
  if (result.failedRules.length === 0 && !result.appliedRules.includes("llm")) return 0.99;
  return Math.max(0.3, ratio * 0.95);
}

function groupByFile(usages: AffectedUsage[]): Map<string, AffectedUsage[]> {
  const map = new Map<string, AffectedUsage[]>();
  for (const u of usages) {
    const arr = map.get(u.file) || [];
    arr.push(u);
    map.set(u.file, arr);
  }
  return map;
}

function rankPatches(patches: MigrationPatch[]): MigrationPatch[] {
  return [...patches].sort((a, b) => {
    const confA = (a as any).confidence || 0;
    const confB = (b as any).confidence || 0;
    return confB - confA;
  });
}
