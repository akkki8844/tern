// Raw document types (an OpenAPI 3.x document as written).
export * from "./interfaces.js";

// Loading and structural validation.
export { DefaultSpecLoader, loadFromString, resolveSpecPath, type LoadOptions } from "./spec-loader.js";
export { DefaultSpecValidator } from "./validator.js";
export { DEFAULT_LIMITS, type AnalysisLimits } from "./limits.js";

// Canonical model.
export * from "./model/canonical.js";
export { buildApiModel, canonicalJson, normalizeTypes, sortCanonically, type BuiltModel } from "./model/build.js";
export { classifyRef, escapePointerSegment, pointer, resolvePointer } from "./model/refs.js";

// Semantic diff.
export * from "./diff/changes.js";
export { RULE_CATALOG, RULE_IDS, getRule, severityFor, type RuleDefinition } from "./diff/rules.js";
export {
  analyzeSpecChange,
  analyzeModelChange,
  assertComparable,
  type ComponentUsage,
  type DiffOptions,
  type SpecChangeAnalysis
} from "./diff/engine.js";
export { toLegacyChanges, describeChange, type LegacyProjection } from "./diff/legacy.js";
export { compareTypeSets, compareNumericRange, compareLengthRange, compareItemsRange, enumDelta } from "./diff/compat.js";

// Reporting.
export { formatChangeReport, toReportJson, type RenderOptions } from "./report.js";

// Legacy surface retained for the pipeline and migration engine.
export { DefaultDiffEngine } from "./diff-engine.js";
export { normalizeOperations, normalizeSchema, resolveSchema } from "./normalizer.js";
