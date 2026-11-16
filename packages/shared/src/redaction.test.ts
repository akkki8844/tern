import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { containsSecret, redactSecrets, redactValue } from "./redaction.js";
import { createTestLogger } from "./logger.js";
import { secret } from "./secret.js";

describe("redactSecrets", () => {
  const cases: Array<[string, string]> = [
    ["github classic token", "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["github fine grained token", "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz"],
    ["fireworks key", "FIREWORKS_API_KEY is fw_3ZqLmNoPqRsTuVwXyZ12"],
    ["openai style key", "sk-abcdefghijklmnopqrstuvwxyz01"],
    ["aws key id", "AKIAIOSFODNN7EXAMPLE"],
    ["jwt", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
    ["database url", "postgresql://capibara:sup3rs3cret@db.internal:5432/capibara"]
  ];

  for (const [name, input] of cases) {
    it(`redacts ${name}`, () => {
      const output = redactSecrets(input);
      assert.ok(output.includes("[REDACTED:"), `expected a redaction marker in: ${output}`);
      assert.ok(containsSecret(input));
    });
  }

  it("redacts private keys spanning multiple lines", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34Gkx\n-----END RSA PRIVATE KEY-----";
    const output = redactSecrets(`key: ${pem}`);
    assert.ok(!output.includes("MIIBOgIBAAJBAKj34Gkx"));
    assert.ok(output.includes("[REDACTED:PRIVATE_KEY]"));
  });

  it("redacts credential assignments", () => {
    const output = redactSecrets('const clientSecret = "abcd1234efgh";');
    assert.ok(!output.includes("abcd1234efgh"));
  });

  it("leaves ordinary source code untouched", () => {
    const source = "export function add(a: number, b: number) { return a + b; }";
    assert.equal(redactSecrets(source), source);
    assert.equal(containsSecret(source), false);
  });
});

describe("redactValue", () => {
  it("redacts values under sensitive keys regardless of content", () => {
    const output = redactValue({ installationToken: "plainvalue", nested: { apiKey: "abc" } }) as Record<string, unknown>;
    assert.equal(output.installationToken, "[REDACTED]");
    assert.equal((output.nested as Record<string, unknown>).apiKey, "[REDACTED]");
  });

  it("scans non-sensitive keys for credential patterns", () => {
    const output = redactValue({ note: "use ghp_abcdefghijklmnopqrstuvwxyz0123456789 to auth" }) as Record<string, string>;
    assert.ok(!output.note.includes("ghp_"));
  });

  it("handles cycles without throwing", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const output = redactValue(cyclic) as Record<string, unknown>;
    assert.equal(output.self, "[Circular]");
  });

  it("truncates very long strings so repository content cannot flood the logs", () => {
    const output = redactValue({ content: "a".repeat(10_000) }) as Record<string, string>;
    assert.ok(output.content.length < 4_100);
    assert.ok(output.content.endsWith("[truncated]"));
  });

  it("respects Secret.toJSON", () => {
    const output = redactValue({ key: secret("fw_realvalue0000", "FIREWORKS_API_KEY") }) as Record<string, unknown>;
    assert.equal(output.key, "[REDACTED]");
  });

  it("limits recursion depth", () => {
    let deep: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 12; i += 1) deep = { child: deep };
    const output = JSON.stringify(redactValue(deep));
    assert.ok(output.includes("[MaxDepth]"));
  });
});

describe("logger", () => {
  it("redacts context before writing", () => {
    const { logger, lines } = createTestLogger();
    logger.info("job claimed", { jobId: "j1", token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].jobId, "j1");
    assert.equal(lines[0].token, "[REDACTED]");
  });

  it("redacts secrets embedded in free-form context values", () => {
    const { logger, lines } = createTestLogger();
    logger.warn("provider error", { body: "unauthorized for fw_abcdefghijklmnop12" });
    assert.ok(!JSON.stringify(lines[0]).includes("fw_abcdefghijklmnop12"));
  });

  it("inherits child context", () => {
    const { logger, lines } = createTestLogger();
    logger.child({ analysisRunId: "run-1" }).info("stage started", { stage: "DIFF" });
    assert.equal(lines[0].analysisRunId, "run-1");
    assert.equal(lines[0].stage, "DIFF");
  });

  it("records duration and outcome for timed operations", async () => {
    const { logger, lines } = createTestLogger();
    await logger.time("stage", async () => "ok", { stage: "SCAN" });
    assert.equal(lines[0].outcome, "success");
    assert.equal(typeof lines[0].durationMs, "number");
  });

  it("logs failures without a stack trace payload", async () => {
    const { logger, lines } = createTestLogger();
    logger.failure("stage failed", new Error("boom"), { stage: "SCAN" });
    const serialised = JSON.stringify(lines[0]);
    assert.ok(serialised.includes("boom"));
    assert.ok(!serialised.includes("at Object."));
  });
});
