import { describe, expect, it } from "vitest";
import { runDemoMigration } from "@/lib/demo/flow";

describe("demo migration flow", () => {
  it("produces a PR simulation with passing checks", () => {
    const output = runDemoMigration();
    expect(output.analysis.breakingChanges.length).toBeGreaterThan(0);
    expect(output.pr.title).toContain("fix: migrate");
    expect(output.testResult.passed).toBe(true);
  });
});
