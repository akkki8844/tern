
import { BreakingChange, AffectedUsage } from "@tern/shared";
import { MigrationInstruction } from "@tern/openapi";

export interface MigrationEngine {
  generatePatches(repoPath: string, changes: BreakingChange[], usages: AffectedUsage[], instructions?: MigrationInstruction[]): Promise<MigrationPatch[]>;
}

export interface MigrationPatch {
  id: string;
  filePath: string;
  original: string;
  modified: string;
  description: string;
  breakingChangeId: string;
  validationStatus: "pending" | "valid" | "invalid";
  validationErrors: string[];
  validationWarnings?: string[];
  diff: string;
  lineCountChanged: number;
  confidence?: number;
  appliedRules?: string[];
}

export interface PatchValidator {
  validate(patch: MigrationPatch): { valid: boolean; errors: string[]; warnings: string[] };
}


export interface TransformResult {
  content: string;
  confidence: number;
  appliedRules: string[];
  failedRules: string[];
}
