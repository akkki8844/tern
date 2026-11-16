import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  OpenAPIError,
  PipelineError,
  ScannerError,
  assertSafeBranchName,
  fingerprint,
  isForbiddenPath,
  normalizeRelativePath,
  sha256Hex,
  type AffectedUsage,
  type BreakingChange,
  type GitHubPullRequestInfo,
  type MigrationPatch
} from "@capibara/shared";
import {
  DefaultDiffEngine,
  formatChangeReport,
  loadFromString,
  type MigrationInstruction,
  type SpecChangeAnalysis
} from "@capibara/openapi";
import {
  RepositoryScanner,
  SimpleRegexScanner,
  formatUsageReport,
  projectToLegacyUsages,
  emptyScan,
  treeSitterLoadable,
  type RepositoryScan
} from "@capibara/scanner";
import { DefaultMigrationEngine, DefaultPatchValidator } from "@capibara/migration-engine";
import { verifyRepository, type VerificationReport } from "@capibara/sandbox";
import { buildPullRequestReport } from "@capibara/github";
import type { Stage, StageContext } from "./stage.js";

/** Where Capibara looks for an OpenAPI document when the repository does not say. */
export const DEFAULT_SPEC_CANDIDATES = [
  "openapi.yaml",
  "openapi.yml",
  "openapi.json",
  "api/openapi.yaml",
  "api/openapi.yml",
  "api/openapi.json",
  "spec/openapi.yaml",
  "docs/openapi.yaml",
  "openapi/openapi.yaml"
];

export interface AnalysisInput {
  repository: {
    id: string;
    githubId: number;
    owner: string;
    name: string;
    defaultBranch: string;
    installationId: number;
  };
  baseRef: string;
  headRef: string;
  /** Repository-relative path of the OpenAPI document, when known. */
  specPath?: string;
}

export interface DiscoverOutput {
  checkoutPath: string;
  commitSha: string;
  specPath: string;
  baseSpec: string;
  headSpec: string;
}

export interface DiffOutput {
  changes: BreakingChange[];
  /**
   * Structured migration input produced by the semantic diff. Carries direction,
   * confidence, rule identity and precise locations for every change.
   */
  analysis: SpecChangeAnalysis;
  /** Deterministic per-change migration hints derived from the analysis. */
  instructions: MigrationInstruction[];
}

export interface ScanOutput extends DiffOutput {
  usages: AffectedUsage[];
  scanner: string;
  /** Full semantic repository scan: usages with evidence, graph and metrics. */
  scan: RepositoryScan;
}

export interface PlanOutput extends ScanOutput {
  /** Files that will be touched, after security filtering. */
  targetFiles: string[];
  skipped: Array<{ file: string; reason: string }>;
}

export interface MigrateOutput extends PlanOutput {
  patches: MigrationPatch[];
}

export interface ValidateOutput extends MigrateOutput {
  validPatches: MigrationPatch[];
  rejectedPatches: MigrationPatch[];
}

export interface TestOutput extends ValidateOutput {
  verification: VerificationReport | null;
}

export interface PublishOutput {
  pullRequest: GitHubPullRequestInfo | null;
  skippedReason?: string;
  branch?: string;
}

// ---------------------------------------------------------------------------
// DISCOVER
// ---------------------------------------------------------------------------

export const discoverStage: Stage<AnalysisInput, DiscoverOutput> = {
  name: "DISCOVER",
  description: "Check out the head commit and locate the OpenAPI document",

  async run(input, context) {
    const checkoutPath = context.workspace.resolve("repo");
    const checkout = await context.providers.repository.checkout(
      {
        installationId: input.repository.installationId,
        owner: input.repository.owner,
        repo: input.repository.name,
        ref: input.headRef
      },
      checkoutPath
    );
    await context.heartbeat();

    const specPath = await resolveSpecPath(checkoutPath, input.specPath);
    const headSpec = await readFile(join(checkoutPath, specPath), "utf8");

    const baseSpec = await context.providers.github.getFileContent(
      input.repository.installationId,
      input.repository.owner,
      input.repository.name,
      specPath,
      input.baseRef
    );

    if (baseSpec === null) {
      throw new OpenAPIError("The OpenAPI document does not exist at the base commit", {
        code: "OPENAPI_BASE_MISSING",
        details: { specPath, baseRef: input.baseRef },
        publicMessage: "Capibara could not find the previous version of the API specification."
      });
    }

    return { checkoutPath: checkout.path, commitSha: checkout.commitSha, specPath, baseSpec, headSpec };
  },

  summarise: (output) => ({ specPath: output.specPath, commitSha: output.commitSha })
};

async function resolveSpecPath(checkoutPath: string, declared?: string): Promise<string> {
  const candidates = declared ? [normalizeRelativePath(declared)] : DEFAULT_SPEC_CANDIDATES;
  for (const candidate of candidates) {
    try {
      await readFile(join(checkoutPath, candidate), "utf8");
      return candidate;
    } catch {
      continue;
    }
  }
  throw new OpenAPIError("No OpenAPI document found in the repository", {
    code: "OPENAPI_SPEC_NOT_FOUND",
    details: { searched: candidates },
    publicMessage: "Capibara could not find an OpenAPI specification in this repository."
  });
}

// ---------------------------------------------------------------------------
// DIFF
// ---------------------------------------------------------------------------

export const diffStage: Stage<DiscoverOutput, DiffOutput> = {
  name: "DIFF",
  description: "Compare the two specifications and identify breaking changes",

  async run(input, context) {
    const [baseDocument, headDocument] = await Promise.all([
      loadSpec(input.baseSpec, "base"),
      loadSpec(input.headSpec, "head")
    ]);

    const engine = new DefaultDiffEngine();
    const changes = await engine.diff(baseDocument, headDocument);
    const analysis = engine.getAnalysis()!;

    context.logger.info("semantic diff complete", {
      breaking: analysis.summary.breaking,
      conditional: analysis.summary.conditional,
      nonBreaking: analysis.summary.nonBreaking,
      unknown: analysis.summary.unknown,
      unsupportedConstructs: analysis.unsupported.length
    });

    return { changes, analysis, instructions: engine.getMigrationInstructions() };
  },

  summarise: (output) => ({
    breaking: output.analysis.summary.breaking,
    conditional: output.analysis.summary.conditional,
    nonBreaking: output.analysis.summary.nonBreaking,
    unknown: output.analysis.summary.unknown,
    rules: [...new Set(output.analysis.changes.map((c) => c.rule))].sort()
  })
};

async function loadSpec(content: string, which: "base" | "head") {
  try {
    return await loadFromString(content);
  } catch (error) {
    throw new OpenAPIError(`The ${which} OpenAPI document could not be parsed`, {
      code: "OPENAPI_PARSE_FAILED",
      cause: error,
      details: { which }
    });
  }
}

/** Stable identity for a change, used for de-duplication across runs. */
export function changeFingerprint(change: BreakingChange): string {
  return fingerprint(`${change.type}|${change.path}|${change.method ?? ""}|${change.operationId ?? ""}`);
}

// ---------------------------------------------------------------------------
// SCAN
// ---------------------------------------------------------------------------

export const scanStage: Stage<DiscoverOutput & DiffOutput, ScanOutput> = {
  name: "SCAN",
  description: "Find API usages in the repository that the semantic changes affect",

  async run(input, context) {
    if (input.changes.length === 0) {
      return { ...input, usages: [], scanner: "skipped", scan: emptyScan("ast", "no changes") };
    }

    try {
      if (treeSitterLoadable()) {
        // Primary engine: full AST pipeline over the Turn 2 semantic analysis.
        const scanner = new RepositoryScanner();
        const scan = await scanner.scan(input.checkoutPath, input.analysis);
        await context.heartbeat();
        return {
          ...input,
          usages: projectToLegacyUsages(scan, input.checkoutPath),
          scan,
          scanner: "ast-engine"
        };
      }
      // Degraded fallback: literal path evidence only, honest low confidence.
      context.logger.warn("tree-sitter is unavailable; falling back to the literal scanner (reduced recall, string-literal evidence only)");
      const fallback = new SimpleRegexScanner();
      const usages = await fallback.scan(input.checkoutPath, input.changes);
      await context.heartbeat();
      return { ...input, usages, scan: emptyScan("literal-fallback"), scanner: "literal-fallback" };
    } catch (error) {
      throw new ScannerError("Repository scan failed", { code: "SCANNER_FAILED", cause: error, retryable: false });
    }
  },

  summarise: (output) => ({
    usages: output.usages.length,
    files: new Set(output.usages.map((u) => u.file)).size,
    scanner: output.scanner,
    high: output.scan.usages.filter((u) => u.confidence === "HIGH").length,
    medium: output.scan.usages.filter((u) => u.confidence === "MEDIUM").length,
    low: output.scan.usages.filter((u) => u.confidence === "LOW").length,
    unknown: output.scan.usages.filter((u) => u.confidence === "UNKNOWN").length
  })
};

// ---------------------------------------------------------------------------
// PLAN
// ---------------------------------------------------------------------------

export const planStage: Stage<DiscoverOutput & ScanOutput, DiscoverOutput & PlanOutput> = {
  name: "PLAN",
  description: "Decide which files may be migrated and which must be left to a human",

  async run(input, context) {
    const targetFiles: string[] = [];
    const skipped: Array<{ file: string; reason: string }> = [];
    const seen = new Set<string>();

    for (const usage of input.usages) {
      const file = toRepoRelative(input.checkoutPath, usage.file);
      if (seen.has(file)) continue;
      seen.add(file);

      if (isForbiddenPath(file)) {
        skipped.push({ file, reason: "sensitive path" });
        continue;
      }
      if (file === input.specPath) {
        skipped.push({ file, reason: "the specification itself is never patched" });
        continue;
      }
      targetFiles.push(file);
    }

    if (skipped.length > 0) {
      context.logger.warn("some affected files will not be migrated", { skipped });
    }

    return { ...input, targetFiles, skipped };
  },

  summarise: (output) => ({ targetFiles: output.targetFiles.length, skipped: output.skipped.length })
};

function toRepoRelative(root: string, file: string): string {
  const rel = file.startsWith(root) ? relative(root, file) : file;
  return rel.replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// MIGRATE
// ---------------------------------------------------------------------------

export const migrateStage: Stage<DiscoverOutput & PlanOutput, DiscoverOutput & MigrateOutput> = {
  name: "MIGRATE",
  description: "Apply deterministic migration rules, with a bounded AI fallback",

  async run(input, context) {
    if (input.targetFiles.length === 0) return { ...input, patches: [] };

    const engine = new DefaultMigrationEngine(context.providers.ai);
    const usages = input.usages
      .map((usage) => ({ ...usage, file: toRepoRelative(input.checkoutPath, usage.file) }))
      .filter((usage) => input.targetFiles.includes(usage.file));

    // The diff stage produced typed migration instructions; passing them through is
    // what lets the engine apply a deterministic mapping instead of parsing prose.
    const patches = await engine.generatePatches(input.checkoutPath, input.changes, usages, input.instructions);
    await context.heartbeat();
    return { ...input, patches };
  },

  summarise: (output) => ({
    patches: output.patches.length,
    aiAssisted: output.patches.filter((p) => p.appliedRules?.includes("ai-fallback")).length
  })
};

// ---------------------------------------------------------------------------
// VALIDATE
// ---------------------------------------------------------------------------

export const validateStage: Stage<DiscoverOutput & MigrateOutput, DiscoverOutput & ValidateOutput> = {
  name: "VALIDATE",
  description: "Re-validate every patch before it is allowed anywhere near a commit",

  async run(input, context) {
    const validator = new DefaultPatchValidator();
    const validPatches: MigrationPatch[] = [];
    const rejectedPatches: MigrationPatch[] = [];

    for (const patch of input.patches) {
      const result = validator.validate(patch);
      const decided: MigrationPatch = {
        ...patch,
        validationStatus: result.valid ? "valid" : "invalid",
        validationErrors: result.errors,
        validationWarnings: result.warnings
      };
      if (result.valid) validPatches.push(decided);
      else {
        rejectedPatches.push(decided);
        context.logger.warn("patch rejected", { filePath: patch.filePath, errors: result.errors });
      }
    }

    return { ...input, patches: input.patches, validPatches, rejectedPatches };
  },

  summarise: (output) => ({ valid: output.validPatches.length, rejected: output.rejectedPatches.length })
};

// ---------------------------------------------------------------------------
// TEST
// ---------------------------------------------------------------------------

export const testStage: Stage<DiscoverOutput & ValidateOutput, DiscoverOutput & TestOutput> = {
  name: "TEST",
  description: "Apply the patches in the workspace and run install, build and tests",

  async run(input, context) {
    if (input.validPatches.length === 0) return { ...input, verification: null };

    for (const patch of input.validPatches) {
      await context.workspace.writeFile(join("repo", patch.filePath), patch.modified);
    }
    await context.heartbeat();

    const verification = await verifyRepository(context.providers.sandbox, {
      workspaceRoot: context.workspace.path,
      repoPath: input.checkoutPath,
      timeoutMs: context.config.sandbox.timeoutMs,
      signal: context.signal
    });

    return { ...input, verification };
  },

  summarise: (output) => ({
    executed: output.verification !== null,
    passed: output.verification?.passed ?? false,
    steps: output.verification?.steps.map((s) => ({ label: s.label, status: s.result.status })) ?? []
  })
};

// ---------------------------------------------------------------------------
// PUBLISH
// ---------------------------------------------------------------------------

export interface PublishOptions {
  /** When false, PUBLISH reports what it would do and performs no writes. */
  enabled: boolean;
  branchPrefix: string;
}

export function createPublishStage(options: PublishOptions): Stage<DiscoverOutput & TestOutput & { input: AnalysisInput }, PublishOutput> {
  return {
    name: "PUBLISH",
    description: "Open a draft pull request for human review",

    async run(data, context) {
      const { input } = data;

      if (data.validPatches.length === 0) {
        return { pullRequest: null, skippedReason: "no valid patches were produced" };
      }
      // A migration is never published unless the sandbox actually verified it.
      if (!data.verification || !data.verification.passed) {
        return {
          pullRequest: null,
          skippedReason: data.verification
            ? `verification failed at the "${failedStep(data.verification)}" step`
            : "verification did not run"
        };
      }
      if (!options.enabled) {
        return { pullRequest: null, skippedReason: "publishing is disabled for this run" };
      }

      const branch = assertSafeBranchName(
        `${options.branchPrefix}${sha256Hex(`${context.analysisRunId}`).slice(0, 12)}`
      );

      await context.providers.github.createBranch(
        input.repository.installationId,
        input.repository.owner,
        input.repository.name,
        branch,
        data.commitSha
      );

      await context.providers.github.commitFiles(
        input.repository.installationId,
        input.repository.owner,
        input.repository.name,
        branch,
        buildCommitMessage(data),
        data.validPatches.map((patch) => ({ path: patch.filePath, content: patch.modified }))
      );

      const report = buildPullRequestReport(
        data.changes,
        data.usages,
        data.validPatches,
        data.verification.steps.at(-1)?.result ?? {
          status: "passed",
          stdout: "",
          stderr: "",
          durationMs: 0,
          logs: []
        }
      );

      const pullRequest = await context.providers.github.createPullRequest({
        installationId: input.repository.installationId,
        owner: input.repository.owner,
        repo: input.repository.name,
        title: `Migrate API usage for ${data.specPath}`,
        body: renderPullRequestBody(report, data),
        head: branch,
        base: input.repository.defaultBranch,
        // Always a draft. A human decides whether this gets merged; Capibara never does.
        draft: true
      });

      return { pullRequest, branch };
    },

    summarise: (output) => ({
      published: output.pullRequest !== null,
      number: output.pullRequest?.number,
      skippedReason: output.skippedReason
    })
  };
}

function failedStep(report: VerificationReport): string {
  return report.steps.find((step) => step.result.status !== "passed")?.label ?? "unknown";
}

function buildCommitMessage(data: DiscoverOutput & TestOutput): string {
  const files = data.validPatches.length;
  return [
    `fix(api): migrate ${files} file${files === 1 ? "" : "s"} for breaking API changes`,
    "",
    ...data.changes.slice(0, 10).map((change) => `- ${change.description}`),
    "",
    "Generated by Capibara. Review required before merging."
  ].join("\n");
}

function renderPullRequestBody(report: ReturnType<typeof buildPullRequestReport>, data: DiscoverOutput & TestOutput & DiffOutput): string {
  return [
    "## Summary",
    report.executiveSummary,
    "",
    "## API changes",
    report.apiDiffSummary,
    "",
    "## Affected files",
    ...report.affectedFiles.map((file) => `- \`${file}\``),
    "",
    "## Detected API changes",
    "```",
    formatChangeReport(data.analysis, { maxPerGroup: 25 }),
    "```",
    "",
    "## Affected usages",
    "```",
    formatUsageReport(data.scan, { maxPerFile: 10, includeMetrics: true }),
    "```",
    "",
    "## Verification",
    ...(data.verification?.steps.map((step) => `- ${step.label}: **${step.result.status}**`) ?? ["- not executed"]),
    "",
    "## Manual review checklist",
    ...report.manualReviewChecklist.map((item) => `- [ ] ${item}`),
    "",
    ...(report.warnings.length > 0 ? ["## Warnings", ...report.warnings.map((w) => `- ${w}`), ""] : []),
    "---",
    "_Opened as a draft by Capibara. Capibara never merges pull requests._"
  ].join("\n");
}

export function assertStageContext(context: StageContext): void {
  if (!context.workspace) {
    throw new PipelineError("Pipeline context is missing a workspace", { code: "PIPELINE_CONTEXT_INVALID" });
  }
}
