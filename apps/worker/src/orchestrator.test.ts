import { describe, it } from "node:test";
import assert from "node:assert";
import path from "path";
import { AnalysisOrchestrator } from "./orchestrator.js";
import { RepositoryRef, InstallationId, RepositoryId } from "@tern/shared";

const repoRoot = path.resolve("../../");

describe("AnalysisOrchestrator", () => {
  it("runs demo analysis end-to-end", async () => {
    const orchestrator = new AnalysisOrchestrator();
    const repo: RepositoryRef = { id: "repo:tern-demo:acmepay-demo" as unknown as RepositoryId, owner: "tern-demo", name: "acmepay-demo", defaultBranch: "main", installationId: 123456 as unknown as import("@tern/shared").InstallationId, isPrivate: false, url: "https://github.com/tern-demo/acmepay-demo" } as unknown as RepositoryRef;
    const result = await orchestrator.run({
      analysisId: "analysis-test" as any,
      repository: repo,
      oldSpecPath: path.join(repoRoot, "demo/acmepay-openapi-v1.yaml"),
      newSpecPath: path.join(repoRoot, "demo/acmepay-openapi-v2.yaml"),
      baseCommitSha: "abc123",
      headCommitSha: "abc123"
    });
    assert.ok(result.breakingChangeCount > 0);
    assert.ok(result.affectedUsageCount >= 0);
    assert.ok(result.status === "completed" || result.status === "failed");
  });
});
