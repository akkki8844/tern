
import { describe, it } from "node:test";
import assert from "node:assert";
import { AnalysisOrchestrator } from "./orchestrator";
import { RepositoryRef } from "@tern/shared";

describe("AnalysisOrchestrator", () => {
  it("runs demo analysis end-to-end", async () => {
    const orchestrator = new AnalysisOrchestrator();
    const repo: RepositoryRef = { id: "repo:tern-demo:acmepay-demo" as unknown as RepositoryRef, owner: "tern-demo", name: "acmepay-demo", defaultBranch: "main", installationId: 123456 as unknown as import("@tern/shared").InstallationId, isPrivate: false, url: "https://github.com/tern-demo/acmepay-demo" } as RepositoryRef;
    const result = await orchestrator.run({
      analysisId: "analysis-test" as any,
      repository: repo,
      oldSpecPath: "demo/acmepay-openapi-old.yaml",
      newSpecPath: "demo/acmepay-openapi-new.yaml",
      baseCommitSha: "abc123",
      headCommitSha: "abc123"
    });
    assert.ok(result.breakingChangeCount > 0);
    assert.ok(result.affectedUsageCount >= 0);
    assert.ok(result.status === "completed" || result.status === "failed");
  });
});
