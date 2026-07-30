
import { getLogger, getConfig, withRetry, AuditLog, MetricsCollector, RepositoryRef, AnalysisId } from "@tern/shared";
import { DefaultSpecLoader, DefaultDiffEngine, DefaultSpecValidator } from "@tern/openapi";
import { TreeSitterScanner } from "@tern/scanner";
import { DefaultMigrationEngine } from "@tern/migration-engine";
import { DefaultSandboxRunner } from "@tern/sandbox";
import { MockGitHubService } from "@tern/github";
import { prisma } from "@tern/db";
const logger = getLogger("worker-orchestrator");

export interface AnalysisInput {
  analysisId: AnalysisId;
  repository: RepositoryRef;
  oldSpecPath: string;
  newSpecPath: string;
  baseCommitSha: string;
  headCommitSha: string;
}

export interface AnalysisResult {
  analysisId: AnalysisId;
  status: "completed" | "failed";
  breakingChangeCount: number;
  affectedUsageCount: number;
  validPatchCount: number;
  sandboxStatus?: string;
  pullRequestUrl?: string;
  error?: string;
}

export class AnalysisOrchestrator {
  private audit = new AuditLog();
  private metrics = new MetricsCollector();
  private loader = new DefaultSpecLoader();
  private differ = new DefaultDiffEngine();
  private validator = new DefaultSpecValidator();
  private scanner = new TreeSitterScanner();
  private migrator = new DefaultMigrationEngine();
  private sandbox = new DefaultSandboxRunner();
  private github = new MockGitHubService();

  async run(input: AnalysisInput): Promise<AnalysisResult> {
    const start = Date.now();
    logger.info("starting analysis", { analysisId: input.analysisId });
    this.audit.log("worker", "analysis.start", "Analysis", input.analysisId);
    try {
      const oldSpec = await this.loadSpec(input.oldSpecPath);
      const newSpec = await this.loadSpec(input.newSpecPath);
      const validationIssues = [...await this.validator.validate(oldSpec), ...await this.validator.validate(newSpec)];
      if (validationIssues.some(i => i.type === "error")) {
        throw new Error(`Spec validation failed: ${validationIssues.map(i => i.message).join(", ")}`);
      }
      const breakingChanges = await this.differ.diff(oldSpec, newSpec);
      logger.info("breaking changes detected", { count: breakingChanges.length });
      this.metrics.record("breaking_changes.detected", breakingChanges.length, { analysisId: input.analysisId });

      const repoPath = `demo/broken-app`; // In production, clone from GitHub
      const usages = await this.scanner.scan(repoPath, breakingChanges);
      logger.info("affected usages found", { count: usages.length });
      this.metrics.record("affected_usages.found", usages.length, { analysisId: input.analysisId });

      const patches = await this.migrator.generatePatches(repoPath, breakingChanges, usages);
      const validPatches = patches.filter(p => p.validationStatus === "valid");
      logger.info("patches generated", { total: patches.length, valid: validPatches.length });
      this.metrics.record("patches.generated", patches.length, { analysisId: input.analysisId });
      this.metrics.record("patches.valid", validPatches.length, { analysisId: input.analysisId });

      const sandboxResult = await this.sandbox.run(repoPath, "npm test", { timeoutMs: 120000 });
      this.metrics.record("sandbox.duration_ms", sandboxResult.durationMs, { analysisId: input.analysisId, status: sandboxResult.status });
      logger.info("sandbox run completed", { status: sandboxResult.status });

      let prUrl: string | undefined;
      if (validPatches.length > 0) {
        const files = Object.fromEntries(validPatches.map(p => [p.filePath, p.modified]));
        const branch = `tern/api-migration-${Date.now()}`;
        await this.github.createBranch(input.repository.installationId as unknown as number, input.repository.owner, input.repository.name, branch, input.headCommitSha);
        await this.github.createCommit(input.repository.installationId as unknown as number, input.repository.owner, input.repository.name, branch, "fix: migrate for breaking API change", files);
        const pr = await this.github.createPullRequest({
          installationId: input.repository.installationId as unknown as number,
          owner: input.repository.owner,
          repo: input.repository.name,
          title: "fix: migrate for breaking API change",
          body: this.generateReport(breakingChanges, validPatches, sandboxResult),
          head: branch,
          base: input.repository.defaultBranch
        });
        prUrl = pr.url;
      }

      this.audit.log("worker", "analysis.completed", "Analysis", input.analysisId, { durationMs: Date.now() - start, breakingChanges: breakingChanges.length, usages: usages.length, patches: validPatches.length });
      return {
        analysisId: input.analysisId,
        status: "completed",
        breakingChangeCount: breakingChanges.length,
        affectedUsageCount: usages.length,
        validPatchCount: validPatches.length,
        sandboxStatus: sandboxResult.status,
        pullRequestUrl: prUrl
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("analysis failed", { analysisId: input.analysisId, err: message });
      this.audit.log("worker", "analysis.failed", "Analysis", input.analysisId, { error: message });
      return { analysisId: input.analysisId, status: "failed", breakingChangeCount: 0, affectedUsageCount: 0, validPatchCount: 0, error: message };
    }
  }

  private async loadSpec(path: string) {
    return withRetry(() => this.loader.load(path), { maxAttempts: 3 });
  }

  private generateReport(changes: import("@tern/shared").BreakingChange[], patches: import("@tern/shared").MigrationPatch[], sandbox: import("@tern/shared").SandboxResult): string {
    const lines = [
      "## Tern API Migration",
      "",
      "### Breaking Changes",
      ...changes.map(c => `- **${c.type}**: ${c.description}`),
      "",
      "### Patches",
      ...patches.map(p => `- \`${p.filePath}\`: ${p.description}`),
      "",
      "### Sandbox Test Result",
      `- Status: ${sandbox.status}`,
      `- Duration: ${sandbox.durationMs}ms`,
      sandbox.testSummary ? `- Summary: ${sandbox.testSummary}` : ""
    ];
    return lines.join("\n");
  }
}
