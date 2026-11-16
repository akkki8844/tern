import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PipelineError, GitHubError, createTestLogger, loadConfig, type Workspace } from "@capibara/shared";
import { runStage, type Stage, type StageContext, type StageOutcome, type StageRecord } from "./stage.js";

const config = loadConfig({ env: { DATABASE_URL: "postgresql://u:p@localhost:5432/capibara" } });

function makeContext(overrides: Partial<StageContext> = {}): { context: StageContext; records: StageRecord[]; heartbeats: number[] } {
  const records: StageRecord[] = [];
  const heartbeats: number[] = [];
  const { logger } = createTestLogger();
  const workspace = {
    id: "ws",
    path: "/tmp/capibara-test-ws",
    resolve: (p: string) => `/tmp/capibara-test-ws/${p}`,
    readFile: async () => "",
    writeFile: async () => undefined,
    dispose: async () => undefined
  } as unknown as Workspace;

  const context: StageContext = {
    analysisRunId: "run-1",
    jobId: "job-1",
    correlationId: "corr-1",
    logger,
    config,
    workspace,
    providers: {} as StageContext["providers"],
    signal: new AbortController().signal,
    async heartbeat() {
      heartbeats.push(Date.now());
    },
    async recordStage(record) {
      records.push(record);
    },
    ...overrides
  };
  return { context, records, heartbeats };
}

const okStage: Stage<number, number> = {
  name: "DIFF",
  description: "double the input",
  run: async (input) => input * 2,
  summarise: (output) => ({ output })
};

describe("runStage", () => {
  it("runs the stage, records timing and returns the typed output", async () => {
    const { context, records } = makeContext();
    const outcomes: StageOutcome[] = [];
    const result = await runStage(okStage, 21, context, outcomes);

    assert.equal(result, 42);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].stage, "DIFF");
    assert.equal(outcomes[0].status, "SUCCEEDED");
    assert.equal(typeof outcomes[0].durationMs, "number");
    assert.deepEqual(outcomes[0].summary, { output: 42 });

    assert.deepEqual(records.map((r) => r.status), ["RUNNING", "SUCCEEDED"]);
    assert.deepEqual(records[1].output, { output: 42 });
  });

  it("converts any thrown value into a PipelineError naming the stage", async () => {
    const { context, records } = makeContext();
    const outcomes: StageOutcome[] = [];
    const failing: Stage<void, void> = {
      name: "SCAN",
      description: "always fails",
      run: async () => {
        throw new Error("tree-sitter exploded");
      }
    };

    await assert.rejects(runStage(failing, undefined, context, outcomes), (error: unknown) => {
      assert.ok(error instanceof PipelineError);
      assert.match(error.message, /Stage SCAN failed: tree-sitter exploded/);
      assert.equal(error.details.stage, "SCAN");
      return true;
    });

    assert.equal(outcomes[0].status, "FAILED");
    assert.equal(records.at(-1)?.status, "FAILED");
    assert.equal(records.at(-1)?.errorMessage, "tree-sitter exploded");
  });

  it("preserves the retryable flag of the underlying error", async () => {
    const { context } = makeContext();
    const outcomes: StageOutcome[] = [];
    const failing: Stage<void, void> = {
      name: "PUBLISH",
      description: "transient github failure",
      run: async () => {
        throw new GitHubError("502 from GitHub", { code: "GITHUB_HTTP_502", retryable: true });
      }
    };

    await assert.rejects(runStage(failing, undefined, context, outcomes), (error: unknown) => {
      assert.ok(error instanceof PipelineError);
      assert.equal(error.retryable, true);
      assert.equal(error.code, "GITHUB_HTTP_502");
      return true;
    });
  });

  it("refuses to start when the run has been cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { context, records } = makeContext({ signal: controller.signal });
    const outcomes: StageOutcome[] = [];
    let executed = false;

    const stage: Stage<void, void> = {
      name: "MIGRATE",
      description: "must not run",
      run: async () => {
        executed = true;
      }
    };

    await assert.rejects(runStage(stage, undefined, context, outcomes), /Pipeline cancelled before stage MIGRATE/);
    assert.equal(executed, false);
    assert.equal(outcomes[0].status, "CANCELLED");
    assert.equal(records[0].status, "CANCELLED");
  });

  it("gives the stage a logger bound to the stage name", async () => {
    const { logger, lines } = createTestLogger();
    const { context } = makeContext({ logger });
    const outcomes: StageOutcome[] = [];
    const stage: Stage<void, void> = {
      name: "PLAN",
      description: "logs something",
      run: async (_input, ctx) => {
        ctx.logger.info("inside the stage");
      }
    };
    await runStage(stage, undefined, context, outcomes);
    const inner = lines.find((line) => line.msg === "inside the stage");
    assert.equal(inner?.stage, "PLAN");
  });
});
