/**
 * Scanner resource limits.
 *
 * Static analysis must be safe on hostile or pathological repositories. Every
 * bound here exists to keep a scan deterministic in cost and unable to exhaust
 * memory, time or the filesystem. All limits are overridable per scan.
 */
export interface ScannerLimits {
  /** Maximum number of files that may be discovered for one scan. */
  readonly maxFiles: number;
  /** Maximum size of a single source file that will be parsed. */
  readonly maxFileBytes: number;
  /** Maximum directory depth walked during discovery. */
  readonly maxDirectoryDepth: number;
  /** Maximum size of a single symlink chain followed inside the root. */
  readonly maxSymlinkHops: number;
  /** Maximum number of import resolution attempts per scan. */
  readonly maxResolutions: number;
  /** Maximum chain length followed through re-exports (`export ... from`). */
  readonly maxReExportDepth: number;
  /** Maximum depth of the transitive wrapper/caller expansion. */
  readonly maxWrapperChainDepth: number;
  /** Maximum steps followed when reconstructing a string value. */
  readonly maxValueResolutionSteps: number;
  /** Maximum depth of property paths extracted from object literals. */
  readonly maxObjectPropertyDepth: number;
  /** Maximum nodes visited while analysing one file. */
  readonly maxNodesPerFile: number;
  /** Maximum number of recorded parse-error files kept in the result. */
  readonly maxReportedParseErrors: number;
  /** Maximum number of usages produced for one scan. */
  readonly maxUsages: number;
}

export const DEFAULT_SCANNER_LIMITS: ScannerLimits = {
  maxFiles: 20_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxDirectoryDepth: 64,
  maxSymlinkHops: 8,
  maxResolutions: 200_000,
  maxReExportDepth: 8,
  maxWrapperChainDepth: 4,
  maxValueResolutionSteps: 16,
  maxObjectPropertyDepth: 12,
  maxNodesPerFile: 2_000_000,
  maxReportedParseErrors: 200,
  maxUsages: 50_000
};
