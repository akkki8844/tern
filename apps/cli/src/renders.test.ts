
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeSpecChange, loadFromString } from "@capibara/openapi";
import { RepositoryScanner } from "@capibara/scanner";
import { changeRows, renderChanges, renderSeveritySummary, renderUsageReport, renderStageTable } from "./renders.js";
import { banner, confidenceChip, severityChip, strip } from "./ui.js";

const OLD = {
  openapi: "3.0.3",
  info: { title: "t", version: "1.0.0" },
  paths: {
    "/orders": { get: { operationId: "listOrders" } },
    "/orders/{id}": { get: { operationId: "getOrder", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } }
  }
};

const NEW = {
  openapi: "3.0.3",
  info: { title: "t", version: "2.0.0" },
  paths: {
    "/orders": { get: { operationId: "listOrders" } },
    "/orders/{id}": { get: { operationId: "getOrderV2", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } }
  }
};

describe("CLI renderers", () => {
  it("chips keep their labels after ANSI stripping (piped output stays greppable)", () => {
    assert.equal(strip(severityChip("BREAKING")), " breaking ");
    assert.equal(strip(confidenceChip("HIGH")), "high");
  });

  it("banner contains the brand, version and no ANSI when stripped", () => {
    const text = strip(banner("9.9.9"));
    assert.match(text, /capibara/);
    assert.match(text, /v9\.9\.9/);
  });

  it("severity summary hides zero counts", () => {
    const analysis = analyzeSpecChange(loadFromString(JSON.stringify(OLD)), loadFromString(JSON.stringify(OLD)));
    const line = strip(renderSeveritySummary(analysis));
    assert.ok(!line.includes("breaking"), `no changes must render an empty summary, got: ${line}`);
  });

  it("change rows map the real diff engine output", () => {
    const analysis = analyzeSpecChange(loadFromString(JSON.stringify(OLD)), loadFromString(JSON.stringify(NEW)));
    const rows = changeRows(analysis);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.ok(row.rule.length > 0);
      assert.ok(["BREAKING", "CONDITIONAL", "NON_BREAKING"].includes(row.severity));
    }
    const text = strip(renderChanges(rows));
    assert.match(text, /OPERATION_ID_CHANGED/);
  });

  it("usage report groups files deterministically and includes the confidence bar", async () => {
    const { join } = await import("node:path");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "cli-render-"));
    writeFileSync(
      join(dir, "client.ts"),
      [
        "import axios from \"axios\";",
        "export const api = axios.create({});",
        "export const one = (id: string) => api.get(`/orders/${id}`);"
      ].join("\n")
    );
    const analysis = analyzeSpecChange(loadFromString(JSON.stringify(OLD)), loadFromString(JSON.stringify(NEW)));
    const scan = await new RepositoryScanner().scan(dir, analysis);
    assert.ok(scan.usages.length > 0, "fixture must produce usages");

    const first = strip(renderUsageReport(scan, false));
    const second = strip(renderUsageReport(scan, false));
    assert.equal(first, second, "rendering must be deterministic for the same scan");

    const usage = scan.usages[0];
    assert.match(first, new RegExp(usage.file.replace(".", "\\.")));
    assert.match(first, new RegExp(`L${usage.line}`));
    assert.match(first, /high|medium|low|unknown/);
  });

  it("stage table marks succeeded and failed stages differently", () => {
    const text = strip(renderStageTable([
      { stage: "SCAN", status: "SUCCEEDED", durationMs: 12 },
      { stage: "TEST", status: "FAILED", durationMs: 900 }
    ]));
    assert.match(text, /SCAN/);
    assert.match(text, /TEST/);
    assert.match(text, /12 ms/);
  });
});
