import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxError, SecurityError, loadConfig } from "@capibara/shared";
import { ProcessSandboxRunner, verifyRepository } from "./sandbox.js";
import { buildSandboxEnv, runProcess } from "./process-executor.js";

const config = loadConfig({ env: { DATABASE_URL: "postgresql://u:p@localhost:5432/capibara", SANDBOX_TIMEOUT_MS: "10000" } })
  .sandbox;

describe("runProcess", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "capibara-exec-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs a command and captures output", async () => {
    const result = await runProcess("node", ["-e", "console.log(40+2)"], dir, {
      timeoutMs: 10_000,
      env: buildSandboxEnv(),
      maxOutputBytes: 1_000
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /42/);
    assert.equal(result.timedOut, false);
  });

  it("does not use a shell: metacharacters are passed through as inert argv, never executed", async () => {
    const marker = join(dir, "pwned.txt");
    const result = await runProcess("node", ["-e", "console.log(process.argv.slice(1).join('|'))", `; touch ${marker}`], dir, {
      timeoutMs: 10_000,
      env: buildSandboxEnv(),
      maxOutputBytes: 5_000
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /; touch/);
    assert.equal(existsSync(marker), false, "the shell fragment must not have been executed");
  });

  it("rejects an injected command string", async () => {
    await assert.rejects(
      runProcess("node -e 'console.log(1)'", [], dir, {
        timeoutMs: 5_000,
        env: buildSandboxEnv(),
        maxOutputBytes: 1_000
      }),
      SecurityError
    );
  });

  it("reports a non-zero exit code", async () => {
    const result = await runProcess("node", ["-e", "process.exit(3)"], dir, {
      timeoutMs: 10_000,
      env: buildSandboxEnv(),
      maxOutputBytes: 1_000
    });
    assert.equal(result.exitCode, 3);
  });

  it("kills a hanging command at the timeout", async () => {
    const result = await runProcess("node", ["-e", "setInterval(()=>{},1000)"], dir, {
      timeoutMs: 300,
      killGraceMs: 200,
      env: buildSandboxEnv(),
      maxOutputBytes: 1_000
    });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
  });

  it("bounds output so a runaway process cannot exhaust memory", async () => {
    const result = await runProcess("node", ["-e", "for(let i=0;i<20000;i++)console.log('x'.repeat(100))"], dir, {
      timeoutMs: 20_000,
      env: buildSandboxEnv(),
      maxOutputBytes: 5_000
    });
    assert.ok(result.stdout.length < 6_000, `stdout was ${result.stdout.length} bytes`);
    assert.match(result.stdout, /output truncated/);
  });

  it("redacts credentials that a build prints", async () => {
    const result = await runProcess(
      "node",
      ["-e", "console.log('token ghp_abcdefghijklmnopqrstuvwxyz0123456789')"],
      dir,
      { timeoutMs: 10_000, env: buildSandboxEnv(), maxOutputBytes: 5_000 }
    );
    assert.ok(!result.stdout.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
    assert.match(result.stdout, /REDACTED/);
  });

  it("gives the child a minimal environment with no Capibara credentials", async () => {
    process.env.CAPIBARA_TEST_FAKE_SECRET = "super-secret-value";
    try {
      const result = await runProcess("node", ["-e", "console.log(JSON.stringify(Object.keys(process.env).sort()))"], dir, {
        timeoutMs: 10_000,
        env: buildSandboxEnv(),
        maxOutputBytes: 10_000
      });
      const keys = JSON.parse(result.stdout.trim()) as string[];
      assert.ok(!keys.includes("CAPIBARA_TEST_FAKE_SECRET"));
      assert.ok(!keys.includes("DATABASE_URL"));
      assert.ok(!keys.includes("GITHUB_PRIVATE_KEY"));
      assert.ok(keys.includes("PATH"));
      assert.ok(keys.includes("CI"));
    } finally {
      delete process.env.CAPIBARA_TEST_FAKE_SECRET;
    }
  });

  it("disables npm lifecycle scripts in the sandbox environment", () => {
    assert.equal(buildSandboxEnv().npm_config_ignore_scripts, "true");
  });

  it("fails cleanly when the binary does not exist", async () => {
    await assert.rejects(
      runProcess("definitely-not-a-real-binary", [], dir, {
        timeoutMs: 5_000,
        env: buildSandboxEnv(),
        maxOutputBytes: 100
      }),
      SandboxError
    );
  });
});

describe("verifyRepository", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "capibara-verify-"));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuses a repository path outside the owning workspace", async () => {
    const runner = new ProcessSandboxRunner(config);
    await assert.rejects(
      verifyRepository(runner, { workspaceRoot: join(root, "ws"), repoPath: "/etc" }),
      SandboxError
    );
  });

  it("reports failure when a step fails and does not run later steps", async () => {
    const repo = join(root, "failing");
    await mkdir(repo, { recursive: true });
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ name: "f", version: "1.0.0", scripts: { build: "node -e \"process.exit(1)\"", test: "node -e 0" } })
    );

    const runner = new ProcessSandboxRunner(config);
    const report = await verifyRepository(runner, { workspaceRoot: root, repoPath: repo, timeoutMs: 60_000 });

    assert.equal(report.passed, false);
    assert.ok(report.steps.length >= 1);
    assert.ok(!report.steps.some((step) => step.label === "test"), "test must not run after build fails");
  });

  it("refuses to verify a checkout without a manifest instead of reporting success", async () => {
    const repo = join(root, "empty");
    await mkdir(repo, { recursive: true });
    const runner = new ProcessSandboxRunner(config);
    await assert.rejects(
      verifyRepository(runner, { workspaceRoot: root, repoPath: repo, timeoutMs: 60_000 }),
      (error: unknown) => {
        assert.ok(error instanceof SandboxError);
        assert.equal(error.code, "SANDBOX_NO_MANIFEST");
        return true;
      }
    );
  });
});
