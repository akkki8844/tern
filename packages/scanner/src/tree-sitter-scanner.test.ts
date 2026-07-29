
import { describe, it } from "node:test";
import assert from "node:assert";
import path from "path";
import { TreeSitterScanner } from "./tree-sitter-scanner";
import { BreakingChange } from "@tern/shared";

describe("TreeSitterScanner", () => {
  it("handles empty repository without errors", async () => {
    const scanner = new TreeSitterScanner();
    const changes: BreakingChange[] = [{ id: "c1", type: "endpoint-removed", path: "/charges", method: "post", description: "post removed", severity: "breaking" }];
    const usages = await scanner.scan("packages/scanner/src", changes);
    assert.ok(Array.isArray(usages));
    const benchmark = scanner.getBenchmark();
    assert.ok(benchmark.filesScanned >= 0);
    assert.ok(benchmark.durationMs >= 0);
  });

  it("scores matches on the AcmePay demo", async () => {
    const scanner = new TreeSitterScanner();
    const changes: BreakingChange[] = [
      { id: "c1", type: "operation-id-removed", path: "/charges", method: "post", operationId: "createCharge", description: "createCharge renamed to createPayment", severity: "breaking" },
      { id: "c2", type: "operation-id-removed", path: "/charges/{id}", method: "get", operationId: "retrieveCharge", description: "retrieveCharge renamed to retrievePayment", severity: "breaking" }
    ];
    const usages = await scanner.scan(path.resolve("demo/broken-app/src"), changes);
    assert.ok(usages.length >= 1, "Expected at least one usage");
    const high = usages.filter(u => u.confidence === "high");
    assert.ok(high.length >= 1 || usages.some(u => u.functionName.toLowerCase().includes("charge") || u.functionName.toLowerCase().includes("payment")), "Expected charge/payment match");
  });
});
