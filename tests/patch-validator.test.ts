import { describe, expect, it } from "vitest";
import { validatePatch } from "@/lib/migration/patch-validator";

describe("validatePatch", () => {
  it("rejects unrelated files", () => {
    const result = validatePatch({ patch: "--- a/a.ts\n+++ b/b.ts\n+test", allowedFiles: ["a.ts"] });
    expect(result.valid).toBe(false);
  });

  it("accepts allowed patch", () => {
    const result = validatePatch({ patch: "--- a/a.ts\n+++ b/a.ts\n+test", allowedFiles: ["a.ts"] });
    expect(result.valid).toBe(true);
  });
});
