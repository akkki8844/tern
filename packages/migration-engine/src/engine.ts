
    import { readFile } from "fs/promises";
    import { BreakingChange, AffectedUsage, MigrationPatch, getConfig, getLogger } from "@tern/shared";
    import { LlmAdapter, MockLlmAdapter } from "@tern/llm";
    import { MigrationEngine, Rule } from "./interfaces";
    import { DefaultPatchValidator } from "./validator";
    const logger = getLogger("migration-engine");

    export class DefaultMigrationEngine implements MigrationEngine {
      private validator = new DefaultPatchValidator();
      private rules: Rule[];
      private llm: LlmAdapter;

      constructor(llm?: LlmAdapter) {
        this.llm = llm || (getConfig().FIREWORKS_API_KEY ? new (require("@tern/llm").FireworksAdapter)() : new MockLlmAdapter());
        this.rules = [
          { type: "request-field-renamed", apply: this.renameFieldRule },
          { type: "response-field-renamed", apply: this.renameFieldRule },
          { type: "path-parameter-renamed", apply: this.renameParamRule },
          { type: "sdk-method-renamed", apply: this.renameMethodRule },
          { type: "sdk-import-renamed", apply: this.renameImportRule },
        ];
      }

      async generatePatches(repoPath: string, changes: BreakingChange[], usages: AffectedUsage[]): Promise<MigrationPatch[]> {
        const patches: MigrationPatch[] = [];
        const seenFiles = new Map<string, string>();
        const byFile = this.groupByFile(usages);
        for (const [filePath, fileUsages] of byFile.entries()) {
          const fullPath = `${repoPath}/${filePath}`;
          let content = await this.readFileSafe(fullPath);
          if (content === null) continue;
          const original = content;
          for (const usage of fileUsages) {
            const change = changes.find(c => c.id === usage.breakingChangeId);
            if (!change) continue;
            const rule = this.rules.find(r => r.type === change.type);
            let modified: string | null = null;
            if (rule) {
              modified = rule.apply(change, usage, content);
            }
            if (modified === null && usage.confidence === "low") {
              modified = await this.llmFallback(change, usage, content);
            }
            if (modified !== null && modified !== content) {
              content = modified;
            }
          }
          if (content !== original) {
            const patch = this.createPatch(filePath, original, content, fileUsages, changes);
            const validation = this.validator.validate(patch);
            patch.validationStatus = validation.valid ? "valid" : "invalid";
            patch.validationErrors = validation.errors;
            patches.push(patch);
          }
        }
        return patches;
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

      private renameFieldRule(change: BreakingChange, usage: AffectedUsage, content: string): string | null {
        const names = this.extractNamesFromDescription(change.description);
        if (names.length < 2) return null;
        const [oldName, newName] = names;
        if (content.includes(oldName)) {
          return content.split(oldName).join(newName);
        }
        return null;
      }

      private renameParamRule(change: BreakingChange, usage: AffectedUsage, content: string): string | null {
        const names = this.extractNamesFromDescription(change.description);
        if (names.length < 2) return null;
        const [oldName, newName] = names;
        return content.replace(new RegExp(`\b${oldName}\b`, "g"), newName);
      }

      private renameMethodRule(change: BreakingChange, usage: AffectedUsage, content: string): string | null {
        const names = this.extractNamesFromDescription(change.description);
        if (names.length < 2) return null;
        const [oldName, newName] = names;
        return content.replace(new RegExp(`\b${oldName}\b`, "g"), newName);
      }

      private renameImportRule(change: BreakingChange, usage: AffectedUsage, content: string): string | null {
        const names = this.extractNamesFromDescription(change.description);
        if (names.length < 2) return null;
        const [oldName, newName] = names;
        return content.replace(oldName, newName);
      }

      private async llmFallback(change: BreakingChange, usage: AffectedUsage, content: string): Promise<string | null> {
        try {
          const response = await this.llm.complete([
            { role: "system", content: "You are a safe code migration assistant. Only rewrite the affected code. Do not add secrets or external dependencies." },
            { role: "user", content: `Breaking change: ${change.description}\n\nAffected code snippet:
${usage.snippet}\n\nContext:
${usage.contextBefore}\n${usage.snippet}\n${usage.contextAfter}\n\nRewrite only the snippet to be compatible with the new API. Return the complete replacement code only.` }
          ]);
          const newSnippet = response.content.trim();
          if (!newSnippet) return null;
          return content.replace(usage.snippet, newSnippet);
        } catch (err) {
          logger.error({ err, changeId: change.id }, "llm fallback failed");
          return null;
        }
      }

      private createPatch(filePath: string, original: string, modified: string, usages: AffectedUsage[], changes: BreakingChange[]): MigrationPatch {
        const diff = this.generateDiff(original, modified);
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
          diff,
          lineCountChanged: Math.abs(modified.split("\n").length - original.split("\n").length)
        };
      }

      private generateDiff(original: string, modified: string): string {
        const origLines = original.split("\n");
        const modLines = modified.split("\n");
        const diff: string[] = ["--- a/original", "+++ b/modified"];
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

      private extractNamesFromDescription(description: string): string[] {
        const matches = description.match(/\b`?([a-zA-Z_][a-zA-Z0-9_]*)`?\b/g);
        if (!matches) return [];
        return matches.map(m => m.replace(/`/g, "")).filter((v, i, a) => a.indexOf(v) === i);
      }
    }
