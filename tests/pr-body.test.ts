import { describe, expect, it } from "vitest";
import { buildMigrationPrBody } from "@/lib/github/pr-body";

describe("buildMigrationPrBody", () => {
  it("includes mandatory warning", () => {
    const body = buildMigrationPrBody(
      "AcmePay",
      { commitSha: "sha", confidence: 0.8, breakingChanges: [], affectedUsages: [], patches: [] },
      "npm test",
      "passed",
      "http://localhost",
    );
    expect(body).toContain("Human developer review is required");
  });
});
