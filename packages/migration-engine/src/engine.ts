
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BreakingChange,
  AffectedUsage,
  MigrationPatch,
  getLogger,
  internalMessageOf,
  type AIProvider
} from "@tern/shared";
import { MigrationInstruction } from "@tern/openapi";
import { DisabledAIProvider, buildMigrationContext } from "@tern/llm";
import { MigrationEngine, TransformResult } from "./interfaces.js";
import { DefaultPatchValidator } from "./validator.js";
import { getRule } from "./rules.js";
import { generateUnifiedDiff } from "./diff.js";
const logger = getLogger("migration-engine");

export class DefaultMigrationEngine implements MigrationEngine {
  private validator = new DefaultPatchValidator();
  private readonly ai: AIProvider;
  private stats = { rulesApplied: 0, llmInvocations: 0, failedRules: 0 };

  /**
   * The AI provider is injected. When none is supplied the engine is deterministic
   * only: it never invents an AI client, and it never silently degrades a failed
   * deterministic rule into an unvalidated rewrite.
   */
  constructor(ai: AIProvider = new DisabledAIProvider()) {
    this.ai = ai;
  }

  async generatePatches(repoPath: string, changes: BreakingChange[], usages: AffectedUsage[], instructions?: MigrationInstruction[]): Promise<MigrationPatch[]> {
    // Per-call state: the engine must be safe to reuse across analysis runs.
    const instructionMap = new Map<string, MigrationInstruction>();
    for (const instruction of instructions ?? []) instructionMap.set(instruction.description, instruction);
    const patches: MigrationPatch[] = [];
    const byFile = groupByFile(usages);
    for (const [filePath, fileUsages] of byFile.entries()) {
      const fullPath = join(repoPath, filePath);
      const content = await readFile(fullPath, "utf8").catch(() => null);
      if (content === null) continue;
      const result = await this.transformFile(content, fileUsages, changes, instructionMap, filePath);
      if (result.content === content) continue;
      const patch = this.buildPatch(filePath, content, result, fileUsages, changes);
      const validation = this.validator.validate(patch);
      patch.validationStatus = validation.valid ? "valid" : "invalid";
      patch.validationErrors = validation.errors;
      patch.validationWarnings = validation.warnings;
      if (validation.valid) {
        patches.push(patch);
      } else {
        logger.warn("patch rejected by validator", { filePath, errors: validation.errors });
      }
    }
    return rankPatches(patches);
  }

  getStats() { return { ...this.stats }; }

  private async transformFile(content: string, usages: AffectedUsage[], changes: BreakingChange[], instructionMap: Map<string, MigrationInstruction>, filePath: string): Promise<TransformResult> {
    const result: TransformResult = { content, confidence: 1, appliedRules: [], failedRules: [] };
    const sorted = [...usages].sort((a, b) => b.line - a.line);
    for (const usage of sorted) {
      const change = changes.find(c => c.id === usage.breakingChangeId);
      if (!change) continue;
      const instruction = instructionMap.get(change.description);
      const rule = getRule(change.type);
      let modified: string | null = null;
      if (rule) {
        modified = rule(change, usage, result.content, instruction);
        if (modified !== null && modified !== result.content) {
          result.content = modified;
          result.appliedRules.push(change.type);
          this.stats.rulesApplied += 1;
          continue;
        }
      }
      // Only use LLM for high/medium confidence usages; low confidence is unsafe to auto-rewrite
      if ((usage.confidence === "high" || usage.confidence === "medium") && (!rule || modified === null)) {
        modified = await this.aiFallback(change, usage, result.content, filePath);
        if (modified !== null && modified !== result.content) {
          result.content = modified;
          result.appliedRules.push("ai-fallback");
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

  /**
   * AI fallback.
   *
   * Constraints, in order of importance:
   *  - it runs only when a deterministic rule could not handle the change
   *  - it runs only for high/medium confidence usages
   *  - it sends a bounded excerpt of ONE file (see buildMigrationContext), never the
   *    repository, never the whole file
   *  - it applies verbatim search/replace edits; the model cannot rewrite the file
   *  - the resulting patch still goes through the same validator as every other patch
   */
  private async aiFallback(
    change: BreakingChange,
    usage: AffectedUsage,
    content: string,
    filePath: string
  ): Promise<string | null> {
    if (!this.ai.enabled) return null;
    try {
      const request = buildMigrationContext({
        breakingChange: change,
        usage: { ...usage, file: filePath },
        fileContent: content
      });
      const response = await this.ai.suggestMigration(request);
      if (response.edits.length === 0) return null;

      let next = content;
      let applied = 0;
      for (const edit of response.edits) {
        const index = next.indexOf(edit.search);
        if (index === -1) continue;
        next = next.slice(0, index) + edit.replace + next.slice(index + edit.search.length);
        applied += 1;
      }
      if (applied === 0) return null;
      logger.info("AI fallback proposed edits", { filePath, changeId: change.id, applied });
      return next;
    } catch (error) {
      logger.warn("AI fallback failed; keeping the deterministic result", {
        changeId: change.id,
        filePath,
        reason: internalMessageOf(error)
      });
      return null;
    }
  }

  private buildPatch(filePath: string, original: string, result: TransformResult, usages: AffectedUsage[], changes: BreakingChange[]): MigrationPatch {
    const diff = generateUnifiedDiff(original, result.content, filePath);
    const changeIds = usages.map(u => u.breakingChangeId);
    const descriptions = changes.filter(c => changeIds.includes(c.id)).map(c => c.description).join("; ");
    return {
      id: randomUUID(),
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

function computeConfidence(result: TransformResult): number {
  const total = result.appliedRules.length + result.failedRules.length;
  if (total === 0) return 1;
  const ratio = result.appliedRules.length / total;
  if (result.failedRules.length === 0 && !result.appliedRules.includes("ai-fallback")) return 0.99;
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
    const confA = a.confidence ?? 0;
    const confB = b.confidence ?? 0;
    return confB - confA;
  });
}
