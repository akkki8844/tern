import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readMigrationSql } from "./migrations.js";
import { isTransient } from "./sql.js";

describe("migrations", () => {
  it("ships at least one migration and exposes it in lexical order", async () => {
    const migrations = await readMigrationSql();
    assert.ok(migrations.length >= 1);
    const names = migrations.map((m) => m.name);
    assert.deepEqual(names, [...names].sort());
  });

  it("creates every table the application depends on", async () => {
    const sql = (await readMigrationSql()).map((m) => m.sql).join("\n");
    for (const table of [
      "User",
      "Session",
      "Installation",
      "Repository",
      "OpenApiSpec",
      "AnalysisRun",
      "StageRun",
      "BreakingChange",
      "AffectedUsage",
      "Migration",
      "Patch",
      "ValidationResult",
      "SandboxRun",
      "PullRequest",
      "Job",
      "WebhookEvent",
      "AuditLog"
    ]) {
      assert.ok(sql.includes(`CREATE TABLE "${table}"`), `missing table ${table}`);
    }
  });

  it("enforces webhook delivery uniqueness and job idempotency", async () => {
    const sql = (await readMigrationSql()).map((m) => m.sql).join("\n");
    assert.ok(sql.includes('CREATE UNIQUE INDEX "WebhookEvent_deliveryId_key"'));
    assert.ok(sql.includes('CREATE UNIQUE INDEX "Job_idempotencyKey_key"'));
    assert.ok(sql.includes('CREATE UNIQUE INDEX "AnalysisRun_idempotencyKey_key"'));
  });
});

describe("isTransient", () => {
  it("classifies connection failures as transient", () => {
    assert.equal(isTransient(new Error("Connection terminated unexpectedly")), true);
    assert.equal(isTransient(new Error("deadlock detected")), true);
  });

  it("classifies constraint violations as permanent", () => {
    assert.equal(isTransient(new Error('duplicate key value violates unique constraint "Job_idempotencyKey_key"')), false);
  });
});
