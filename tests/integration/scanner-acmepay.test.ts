
import { describe, it } from "node:test";
import assert from "node:assert";
import { TreeSitterScanner } from "@tern/scanner";
import { BreakingChange } from "@tern/shared";
import path from "path";

describe("Integration: scanner on AcmePay demo", () => {
  it("finds axios instance and charge methods", async () => {
    const scanner = new TreeSitterScanner();
    const changes: BreakingChange[] = [
      { id: "c1", type: "operation-id-removed", path: "/charges", method: "post", operationId: "createCharge", description: "createCharge renamed to createPayment", severity: "breaking" },
      { id: "c2", type: "operation-id-removed", path: "/charges/{id}", method: "get", operationId: "retrieveCharge", description: "retrieveCharge renamed to retrievePayment", severity: "breaking" }
    ];
    const demoPath = path.resolve("demo/broken-app/src");
    const usages = await scanner.scan(demoPath, changes);
    assert.ok(usages.length > 0, "Expected at least one usage to match");
    const high = usages.filter(u => u.confidence === "high");
    assert.ok(high.length > 0, "Expected at least one high-confidence match");
  });
});
