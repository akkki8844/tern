import { describe, expect, it } from "vitest";
import { containsLikelySecret, redactLikelySecrets } from "@/lib/security/secret-redaction";

describe("secret redaction", () => {
  it("redacts likely token patterns", () => {
    const input = "token sk-123456789012345678901234";
    expect(containsLikelySecret(input)).toBe(true);
    expect(redactLikelySecrets(input)).toContain("[REDACTED_SECRET]");
  });
});
