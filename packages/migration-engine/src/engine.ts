
    import { readFile } from "fs/promises";
    import { BreakingChange, AffectedUsage, MigrationPatch, getConfig, getLogger } from "@tern/shared";
    import { MigrationInstruction } from "@tern/openapi";
    import { LlmAdapter, MockLlmAdapter } from "@tern/llm";
    import { MigrationEngine, Rule, TransformResult } from "./interfaces";
    import { DefaultPatchValidator } from "./validator";
    const logger = getLogger("migration-engine");

    export class DefaultMigrationEngine implements MigrationEngine {
      private validator = new DefaultPatchValidator();
      private llm: LlmAdapter;
      private instructions: Map<string, MigrationInstruction> = new Map();
      private stats = { rulesApplied: 0, llmInvocations: 0, failedRules: 0 };

      constructor(llm?: LlmAdapter) {
        this.llm = llm || (getConfig().FIREWORKS_API_KEY ? new (require("@tern/llm").FireworksAdapter)() : new MockLlmAdapter());
      }

      async generatePatches(repoPath: string, changes: BreakingChange[], usages: AffectedUsage[], instructions?: MigrationInstruction[]): Promise<MigrationPatch[]> {
        if (instructions) {
          for (const i of instructions) this.instructions.set(i.description, i);
        }
        const patches: MigrationPatch[] = [];
        const byFile = this.groupByFile(usages);
        for (const [filePath, fileUsages] of byFile.entries()) {
          const fullPath = `${repoPath}/${filePath}`;
          const content = await this.readFileSafe(fullPath);
          if (content === null) continue;
          const result = await this.transformFile(filePath, content, fileUsages, changes);
          if (result.content !== content) {
            const patch = this.createPatch(filePath, content, result.content, fileUsages, changes, result);
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
        }
        return this.rankPatches(patches);
      }

      getStats(): { rulesApplied: number; llmInvocations: number; failedRules: number } {
        return { ...this.stats };
      }

      private async transformFile(filePath: string, content: string, usages: AffectedUsage[], changes: BreakingChange[]): Promise<TransformResult> {
        let result: TransformResult = { content, confidence: 1, appliedRules: [], failedRules: [] };
        const sorted = [...usages].sort((a, b) => b.line - a.line);
        for (const usage of sorted) {
          const change = changes.find(c => c.id === usage.breakingChangeId);
          if (!change) continue;
          const instruction = this.instructions.get(change.description);
          const rule = this.getRule(change.type);
          if (rule) {
            const modified = rule.apply(change, usage, result.content, instruction);
            if (modified !== null && modified !== result.content) {
              result.content = modified;
              result.appliedRules.push(rule.type);
              this.stats.rulesApplied += 1;
              continue;
            }
          }
          if (usage.confidence === "low" || !rule) {
            const modified = await this.llmFallback(change, usage, result.content);
            if (modified !== null && modified !== result.content) {
              result.content = modified;
              result.appliedRules.push("llm");
              this.stats.llmInvocations += 1;
            } else {
              result.failedRules.push(change.type);
              this.stats.failedRules += 1;
            }
          }
        }
        result.confidence = this.computeConfidence(result);
        return result;
      }

      private getRule(type: string): Rule | undefined {
        const rules: Record<string, Rule> = {
          "request-field-renamed": { type: "request-field-renamed", apply: this.renameFieldRule },
          "response-field-renamed": { type: "response-field-renamed", apply: this.renameFieldRule },
          "request-field-removed": { type: "request-field-removed", apply: this.removeFieldRule },
          "response-field-removed": { type: "response-field-removed", apply: this.removeFieldRule },
          "path-parameter-renamed": { type: "path-parameter-renamed", apply: this.renameParamRule },
          "sdk-method-renamed": { type: "sdk-method-renamed", apply: this.renameMethodRule },
          "sdk-import-renamed": { type: "sdk-import-renamed", apply: this.renameImportRule },
          "operation-id-removed": { type: "operation-id-removed", apply: this.renameMethodRule },
          "required-parameter-added": { type: "required-parameter-added", apply: this.addRequiredFieldRule },
          "enum-value-removed": { type: "enum-value-removed", apply: this.enumValueRule },
          "type-changed": { type: "type-changed", apply: this.typeChangedRule },
          "general": { type: "general", apply: this.generalRule },
        };
        return rules[type];
      }

      private renameFieldRule(change: BreakingChange, usage: AffectedUsage, content: string, instruction?: MigrationInstruction): string | null {
        const mappings = instruction?.mappings || this.extractMappings(change.description);
        let result = content;
        for (const { old, new: newName } of mappings) {
          if (old && newName && old !== newName) {
            result = this.safeReplace(result, old, newName);
          }
        }
        return result === content ? null : result;
      }

      private renameParamRule(change: BreakingChange, usage: AffectedUsage, content: string, instruction?: MigrationInstruction): string | null {
        const mappings = instruction?.mappings || this.extractMappings(change.description);
        let result = content;
        for (const { old, new: newName } of mappings) {
          if (old && newName && old !== newName) {
            result = this.safeReplace(result, old, newName);
          }
        }
        return result === content ? null : result;
      }

      private renameMethodRule(change: BreakingChange, usage: AffectedUsage, content: string, instruction?: MigrationInstruction): string | null {
        const mappings = instruction?.mappings || this.extractMappings(change.description);
        let result = content;
        for (const { old, new: newName } of mappings) {
          if (old && newName && old !== newName) {
            result = this.safeReplace(result, old, newName);
          }
        }
        return result === content ? null : result;
      }

      private renameImportRule(change: BreakingChange, usage: AffectedUsage, content: string, instruction?: MigrationInstruction): string | null {
        const mappings = instruction?.mappings || this.extractMappings(change.description);
        let result = content;
        for (const { old, new: newName } of mappings) {
          if (old && newName) {
            result = this.safeReplace(result, old, newName);
          }
        }
        return result === content ? null : result;
      }

      private removeFieldRule(change: BreakingChange, usage: AffectedUsage, content: string): string | null {
        const names = this.extractNamesFromDescription(change.description);
        let result = content;
        for (const name of names) {
          result = this.removeField(result, name);
        }
        return result === content ? null : result;
      }

      private addRequiredFieldRule(change: BreakingChange, usage: AffectedUsage, content: string, instruction?: MigrationInstruction): string | null {
        const fields = instruction?.mappings.filter(m => m.kind === "parameter" || m.kind === "requestBody" || m.kind === "field").map(m => m.new) || this.extractNamesFromDescription(change.description);
        return null; // Adding required fields safely is hard; defer to LLM or manual
      }

      private enumValueRule(change: BreakingChange, usage: AffectedUsage, content: string): string | null {
        return null; // Enum value removal usually requires context; defer to LLM
      }

      private typeChangedRule(change: BreakingChange, usage: AffectedUsage, content: string): string | null {
        return null; // Type changes are risky; defer to LLM
      }

      private generalRule(change: BreakingChange, usage: AffectedUsage, content: string, instruction?: MigrationInstruction): string | null {
        if (change.path === "servers") {
          const mappings = instruction?.mappings || this.extractMappings(change.description);
          let result = content;
          for (const { old, new: newName } of mappings) {
            if (old && newName && old !== newName) {
              result = this.safeReplace(result, old, newName);
            }
          }
          return result === content ? null : result;
        }
        return null;
      }

      private async llmFallback(change: BreakingChange, usage: AffectedUsage, content: string): Promise<string | null> {
        try {
          this.stats.llmInvocations += 1;
          const response = await this.llm.complete([
            { role: "system", content: "You are a precise code migration assistant. Rewrite ONLY the affected code to be compatible with the new API. Do not change unrelated code. Do not add secrets or dependencies. Return only the complete replacement code for the file." },
            { role: "user", content: `Breaking change: ${change.description}

Affected code snippet:
${usage.snippet}

Context:
${usage.contextBefore}
${usage.snippet}
${usage.contextAfter}

File so far:
${content}

Rewrite only the affected portion to be compatible with the new API. Return the complete file content.` }
          ]);
          const newContent = response.content.trim();
          if (!newContent) return null;
          if (newContent.startsWith("```") && newContent.endsWith("```")) {
            return newContent.replace(/```[a-z]*
?/g, "").replace(/```\s*$/, "");
          }
          return newContent;
        } catch (err) {
          logger.error({ err, changeId: change.id }, "llm fallback failed");
          return null;
        }
      }

      private safeReplace(content: string, old: string, newName: string): string {
        // Only replace whole identifiers to avoid partial matches
        const regex = new RegExp(`\b${old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\b`, "g");
        return content.replace(regex, newName);
      }

      private removeField(content: string, field: string): string {
        const regex = new RegExp(`\s*,?\s*\b${field}\s*[:=]\s*[^,}]+`, "g");
        return content.replace(regex, "");
      }

      private async readFileSafe(path: string): Promise<string | null> {
        try { return await readFile(path, "utf8"); } catch { return null; }
      }

      private groupByFile(usages: AffectedUsage[]): Map<string, AffectedUsage[]> {
        const map = new Map<string, AffectedUsage[]>();
        for (const u of usages) {
          const arr = map.get(u.file) || [];
          arr.push(u);
          map.set(u.file, arr);
        }
        return map;
      }

      private createPatch(filePath: string, original: string, modified: string, usages: AffectedUsage[], changes: BreakingChange[], result: TransformResult): MigrationPatch & { validationWarnings: string[] } {
        const diff = this.generateUnifiedDiff(original, modified, filePath);
        const changeIds = usages.map(u => u.breakingChangeId);
        const descriptions = changes.filter(c => changeIds.includes(c.id)).map(c => c.description).join("; ");
        return {
          id: crypto.randomUUID(),
          filePath,
          original,
          modified,
          description: `Migrate ${filePath} for: ${descriptions}`,
          breakingChangeId: changeIds[0],
          validationStatus: "pending",
          validationErrors: [],
          validationWarnings: [],
          diff,
          lineCountChanged: Math.abs(modified.split("\n").length - original.split("\n").length),
          confidence: result.confidence,
          appliedRules: result.appliedRules
        };
      }

      private generateUnifiedDiff(original: string, modified: string, filePath: string): string {
        const origLines = original.split("\n");
        const modLines = modified.split("\n");
        const diff: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
        let i = 0, j = 0;
        while (i < origLines.length || j < modLines.length) {
          if (i < origLines.length && j < modLines.length && origLines[i] === modLines[j]) {
            diff.push(` ${origLines[i]}`);
            i++; j++;
          } else if (j < modLines.length) {
            diff.push(`+${modLines[j]}`);
            j++;
          } else if (i < origLines.length) {
            diff.push(`-${origLines[i]}`);
            i++;
          }
        }
        return diff.join("\n");
      }

      private extractMappings(description: string): Array<{ old: string; new: string; kind: string }> {
        const matches = description.match(/\b`?([a-zA-Z_][a-zA-Z0-9_]*)`?\b/g);
        if (!matches || matches.length < 2) return [];
        const unique = [...new Set(matches.map(m => m.replace(/`/g, "")))].filter(m => m.length > 1);
        const mappings: Array<{ old: string; new: string; kind: string }> = [];
        for (let i = 0; i < unique.length - 1; i++) {
          mappings.push({ old: unique[i], new: unique[i + 1], kind: "inferred" });
        }
        return mappings;
      }

      private extractNamesFromDescription(description: string): string[] {
        const matches = description.match(/\b`?([a-zA-Z_][a-zA-Z0-9_]*)`?\b/g);
        if (!matches) return [];
        return [...new Set(matches.map(m => m.replace(/`/g, "")))].filter(m => m.length > 1);
      }

      private computeConfidence(result: TransformResult): number {
        if (result.failedRules.length === 0) return 0.95;
        const ratio = result.appliedRules.length / (result.appliedRules.length + result.failedRules.length);
        return Math.max(0.3, ratio * 0.95);
      }

      private rankPatches(patches: MigrationPatch[]): MigrationPatch[] {
        return patches.sort((a, b) => {
          const confA = (a as any).confidence || 0;
          const confB = (b as any).confidence || 0;
          return confB - confA;
        });
      }
    }
