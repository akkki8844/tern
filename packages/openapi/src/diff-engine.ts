import type { BreakingChange } from "@tern/shared";
import type { MigrationInstruction, OpenApiDocument } from "./interfaces.js";
import { analyzeSpecChange, type DiffOptions, type SpecChangeAnalysis } from "./diff/engine.js";
import { toLegacyChanges } from "./diff/legacy.js";

/**
 * Legacy-shaped diff engine.
 *
 * The semantic engine (`analyzeSpecChange`) is the source of truth. This class keeps
 * the older `BreakingChange[]` + `MigrationInstruction[]` surface that the pipeline
 * and migration engine already consume, so upgrading the analysis did not require
 * rewriting the stages that depend on it.
 *
 * New code should prefer `analyzeSpecChange`, which carries direction, confidence,
 * rule identity and precise locations.
 */
export class DefaultDiffEngine {
  private instructions: MigrationInstruction[] = [];
  private analysis?: SpecChangeAnalysis;

  constructor(private readonly options: DiffOptions = {}) {}

  async diff(oldSpec: OpenApiDocument, newSpec: OpenApiDocument): Promise<BreakingChange[]> {
    const analysis = analyzeSpecChange(oldSpec, newSpec, this.options);
    const projected = toLegacyChanges(analysis);
    this.analysis = analysis;
    this.instructions = projected.instructions;
    return projected.changes;
  }

  getMigrationInstructions(): MigrationInstruction[] {
    return [...this.instructions];
  }

  /** The full semantic report for the most recent diff, if one has been run. */
  getAnalysis(): SpecChangeAnalysis | undefined {
    return this.analysis;
  }
}
