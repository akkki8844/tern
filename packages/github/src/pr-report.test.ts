
import { describe, it } from "node:test";
import assert from "node:assert";
import { buildPullRequestReport, renderPullRequestBody } from "./pr-report";
import { BreakingChange, AffectedUsage, MigrationPatch, SandboxResult } from "@tern/shared";

describe("PullRequestReport", () => {
  it("renders a complete PR body with call sites table", () => {
    const changes: BreakingChange[] = [{ id: "c1", type: "request-field-renamed", path: "/charges", method: "post", operationId: "createCharge", description: "Rename source to payment_method", severity: "breaking" }];
    const usages: AffectedUsage[] = [{ id: "u1", file: "client.ts", line: 1, column: 1, functionName: "createCharge", snippet: "source: token", contextBefore: "", contextAfter: "", confidence: "high", breakingChangeId: "c1" }];
    const patches: MigrationPatch[] = [{ id: "p1", filePath: "client.ts", original: "source", modified: "payment_method", description: "Rename source", breakingChangeId: "c1", validationStatus: "valid", validationErrors: [], diff: "", lineCountChanged: 0, confidence: 0.95, appliedRules: ["request-field-renamed"] }];
    const sandbox: SandboxResult = { status: "passed", exitCode: 0, stdout: "", stderr: "", durationMs: 1000, testSummary: "3 passing", logs: [] };
    const report = buildPullRequestReport(changes, usages, patches, sandbox);
    const body = renderPullRequestBody(report);
    assert.ok(body.includes("Executive Summary"));
    assert.ok(body.includes("client.ts"));
    assert.ok(body.includes("Manual Review Checklist"));
    assert.ok(body.includes("3 passing"));
    assert.ok(body.includes("95%"));
    assert.ok(body.includes("| File | Function | Method | Confidence | Snippet |"));
    assert.ok(body.includes("Affected Call Sites"));
  });
});
