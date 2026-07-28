import { describe, expect, it } from "vitest";
import { detectBreakingChanges } from "@/lib/openapi/diff";
import { oldSpec, newSpec } from "@/lib/demo/specs";

describe("detectBreakingChanges", () => {
  it("detects v1 breaking changes", () => {
    const changes = detectBreakingChanges(oldSpec, newSpec, { statusText: "state" });
    expect(changes.some((change) => change.type === "removed_endpoint")).toBe(true);
    expect(changes.some((change) => change.type === "added_required_request_parameter")).toBe(true);
    expect(changes.some((change) => change.type === "renamed_response_field")).toBe(true);
  });
});
