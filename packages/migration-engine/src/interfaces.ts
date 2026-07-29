
import { BreakingChange, AffectedUsage, MigrationPatch } from "@tern/shared";

export interface MigrationEngine {
  generatePatches(repoPath: string, changes: BreakingChange[], usages: AffectedUsage[]): Promise<MigrationPatch[]>;
}

export interface PatchValidator {
  validate(patch: MigrationPatch): { valid: boolean; errors: string[] };
}

export interface Rule {
  type: string;
  apply(change: BreakingChange, usage: AffectedUsage, fileContent: string): string | null;
}
