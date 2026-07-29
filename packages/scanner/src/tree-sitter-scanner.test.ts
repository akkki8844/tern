
import { describe, it } from "node:test";
import assert from "node:assert";
import { TreeSitterScanner } from "./tree-sitter-scanner";
import { BreakingChange } from "@tern/shared";

describe("TreeSitterScanner", () => {
  it("handles empty repository", async () => {
    const scanner = new TreeSitterScanner();
    const changes: BreakingChange[] = [{ id: "c1", type: "endpoint-removed", path: "/charges", method: "post", description: "post removed", severity: "breaking" }];
    const usages = await scanner.scan("packages/scanner/src", changes);
    assert.ok(Array.isArray(usages));
  });
});
