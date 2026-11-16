import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig, normalizePrivateKey, describeConfig, ENV_VARS } from "./config.js";
import { ConfigurationError } from "./errors.js";

const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",
  "KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQJAIJLixBy2qpFoS4DSmoEm",
  "o3qGy0t6z09AIJtH+5OeRV1be+N4cDYJKffGzDa88vQENZiRm0GRq6a+HPGQMd2k",
  "TQIhAKMSvzIBnni7ot/OSie2TmJLY4SwTQAevXysE2RbFDYdAiEBCUEaRQnMnbp7",
  "9mxDXDf6AU0cN/RPBjb9qSHDcWZHGzUCIG2Es59z8ugGrDY+pxLQnwfotadxd+Uy",
  "v/Ow5T0q5gIJAiEAyS4RaI9YG8EWx/2w0T67ZUVAw8eOMB6BIUg0Xcu+3okCIBOs",
  "/5OiPgoTdSy7bcF9IGpSE8ZgGKzgYQVZeN97YE00",
  "-----END RSA PRIVATE KEY-----"
].join("\n");

const BASE_ENV = {
  DATABASE_URL: "postgresql://capibara:capibara@localhost:5432/capibara",
  SESSION_SECRET: "x".repeat(40)
};

describe("configuration", () => {
  it("loads a minimal development configuration", () => {
    const config = loadConfig({ env: { DATABASE_URL: BASE_ENV.DATABASE_URL } });
    assert.equal(config.nodeEnv, "development");
    assert.equal(config.demoMode, false);
    assert.equal(config.githubApp.enabled, false);
    assert.equal(config.ai.enabled, false);
    assert.equal(config.worker.concurrency, 2);
  });

  it("fails with an actionable error when DATABASE_URL is missing", () => {
    assert.throws(
      () => loadConfig({ env: {} }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /DATABASE_URL is required/);
        assert.match(error.message, /docs\/environment\.md/);
        return true;
      }
    );
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    assert.throws(
      () => loadConfig({ env: { DATABASE_URL: "mysql://localhost/capibara" } }),
      /only supports PostgreSQL/
    );
  });

  it("requires the full GitHub App triple in production", () => {
    assert.throws(
      () => loadConfig({ env: { ...BASE_ENV, NODE_ENV: "production" } }),
      /GITHUB_APP_ID, GITHUB_PRIVATE_KEY and GITHUB_WEBHOOK_SECRET are required in production/
    );
  });

  it("allows production without GitHub App credentials in demo mode", () => {
    const config = loadConfig({ env: { ...BASE_ENV, NODE_ENV: "production", CAPIBARA_MODE: "demo" } });
    assert.equal(config.demoMode, true);
    assert.equal(config.githubApp.enabled, false);
  });

  it("treats a partially configured GitHub App as an error, not as disabled", () => {
    assert.throws(
      () => loadConfig({ env: { ...BASE_ENV, GITHUB_APP_ID: "123" } }),
      /GITHUB_PRIVATE_KEY is required/
    );
  });

  it("enables the GitHub App when all values are valid", () => {
    const config = loadConfig({
      env: {
        ...BASE_ENV,
        GITHUB_APP_ID: "123456",
        GITHUB_PRIVATE_KEY: PEM,
        GITHUB_WEBHOOK_SECRET: "0123456789abcdef"
      }
    });
    assert.equal(config.githubApp.enabled, true);
    assert.equal(config.githubApp.appId, "123456");
    assert.ok(config.githubApp.privateKey.reveal().includes("BEGIN RSA PRIVATE KEY"));
  });

  it("rejects a short webhook secret", () => {
    assert.throws(
      () =>
        loadConfig({
          env: { ...BASE_ENV, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: PEM, GITHUB_WEBHOOK_SECRET: "short" }
        }),
      /GITHUB_WEBHOOK_SECRET must be at least 16 characters/
    );
  });

  it("requires a session secret when OAuth is configured", () => {
    assert.throws(
      () =>
        loadConfig({
          env: { DATABASE_URL: BASE_ENV.DATABASE_URL, GITHUB_CLIENT_ID: "abc", GITHUB_CLIENT_SECRET: "def" }
        }),
      /SESSION_SECRET is required/
    );
  });

  it("validates integer ranges with the variable name in the message", () => {
    assert.throws(
      () => loadConfig({ env: { ...BASE_ENV, WORKER_CONCURRENCY: "0" } }),
      /WORKER_CONCURRENCY must be between 1 and 64/
    );
    assert.throws(
      () => loadConfig({ env: { ...BASE_ENV, WORKER_CONCURRENCY: "abc" } }),
      /WORKER_CONCURRENCY must be an integer/
    );
  });

  it("rejects a heartbeat interval that cannot renew the lease in time", () => {
    assert.throws(
      () =>
        loadConfig({
          env: { ...BASE_ENV, WORKER_LEASE_DURATION_MS: "20000", WORKER_HEARTBEAT_INTERVAL_MS: "30000" }
        }),
      /must be smaller than WORKER_LEASE_DURATION_MS/
    );
  });

  it("reports every problem at once", () => {
    try {
      loadConfig({ env: { WORKER_CONCURRENCY: "0" } });
      assert.fail("expected configuration to fail");
    } catch (error) {
      assert.ok(error instanceof ConfigurationError);
      // zod-level failures short-circuit; re-run with a valid int to see aggregation
    }
    try {
      loadConfig({ env: { GITHUB_APP_ID: "abc", ENCRYPTION_KEY: "tooshort" } });
      assert.fail("expected configuration to fail");
    } catch (error) {
      assert.ok(error instanceof ConfigurationError);
      assert.match(error.message, /5 problems/);
    }
  });

  it("never places secret values in the describeConfig summary", () => {
    const config = loadConfig({
      env: {
        ...BASE_ENV,
        GITHUB_APP_ID: "123456",
        GITHUB_PRIVATE_KEY: PEM,
        GITHUB_WEBHOOK_SECRET: "0123456789abcdef",
        FIREWORKS_API_KEY: "fw_supersecretvalue123456"
      }
    });
    const summary = JSON.stringify(describeConfig(config));
    assert.ok(!summary.includes("fw_supersecretvalue123456"));
    assert.ok(!summary.includes("0123456789abcdef"));
    assert.ok(!summary.includes("BEGIN RSA PRIVATE KEY"));
    assert.ok(!summary.includes("capibara:capibara@"));
    assert.ok(summary.includes('"enabled":true'));
  });

  it("never leaks a secret through interpolation or JSON", () => {
    const config = loadConfig({ env: { ...BASE_ENV, FIREWORKS_API_KEY: "fw_leakme000000000000" } });
    assert.equal(`${config.ai.apiKey}`, "[REDACTED]");
    assert.equal(JSON.stringify({ key: config.ai.apiKey }), '{"key":"[REDACTED]"}');
    assert.equal(String(config.ai.apiKey), "[REDACTED]");
    assert.equal(config.ai.apiKey.reveal(), "fw_leakme000000000000");
  });

  it("documents every variable it reads", () => {
    const documented = new Set(ENV_VARS.map((v) => v.name));
    for (const name of [
      "DATABASE_URL",
      "GITHUB_APP_ID",
      "GITHUB_PRIVATE_KEY",
      "GITHUB_WEBHOOK_SECRET",
      "FIREWORKS_API_KEY",
      "WORKER_CONCURRENCY",
      "WORKSPACE_ROOT",
      "SESSION_SECRET"
    ]) {
      assert.ok(documented.has(name), `${name} must be documented in ENV_VARS`);
    }
  });
});

describe("normalizePrivateKey", () => {
  it("accepts raw PEM", () => {
    assert.ok(normalizePrivateKey(PEM).startsWith("-----BEGIN RSA PRIVATE KEY-----"));
  });

  it("accepts PEM with literal newline escapes", () => {
    const escaped = PEM.replace(/\n/g, "\\n");
    assert.ok(normalizePrivateKey(escaped).includes("\n"));
  });

  it("accepts base64-encoded PEM", () => {
    const encoded = Buffer.from(PEM, "utf8").toString("base64");
    assert.ok(normalizePrivateKey(encoded).startsWith("-----BEGIN RSA PRIVATE KEY-----"));
  });

  it("rejects garbage without echoing the value", () => {
    assert.throws(
      () => normalizePrivateKey("hunter2-not-a-key"),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.ok(!error.message.includes("hunter2"));
        return true;
      }
    );
  });
});
