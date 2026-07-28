import { describe, expect, it } from "vitest";
import { scanTypeScriptUsages } from "@/lib/scanner/typescript-usage-scanner";

describe("scanTypeScriptUsages", () => {
  it("finds affected endpoint usage", () => {
    const usages = scanTypeScriptUsages(
      [{ path: "src/app.ts", content: "fetch('/v1/charges/123')" }],
      [{ type: "removed_endpoint", severity: "high", endpoint: "/v1/charges", confidence: 1 }],
    );
    expect(usages.length).toBeGreaterThan(0);
    expect(usages[0].filePath).toBe("src/app.ts");
  });
});
