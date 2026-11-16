import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AIProviderError, SecurityError, loadConfig, type AIMigrationRequest } from "@tern/shared";
import { FireworksAIProvider } from "./fireworks-provider.js";
import { buildMigrationContext } from "./context.js";
import { DemoAIProvider, DisabledAIProvider, createAIProvider } from "./factory.js";

const ENV = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/tern",
  FIREWORKS_API_KEY: "fw_testkey0000000000",
  FIREWORKS_MAX_ATTEMPTS: "3",
  FIREWORKS_TIMEOUT_MS: "1000"
};

function aiConfig(overrides: Record<string, string> = {}) {
  return loadConfig({ env: { ...ENV, ...overrides } }).ai;
}

const REQUEST: AIMigrationRequest = {
  breakingChange: {
    type: "sdk-method-renamed",
    description: "createCharge was renamed to createPayment",
    path: "/charges",
    method: "post",
    operationId: "createCharge",
    migrationHint: "rename the method"
  },
  usage: { file: "src/pay.ts", line: 3, column: 1, functionName: "createCharge", confidence: "high" },
  excerpt: "const client = new AcmePay();\n// pay\nawait client.createCharge({ amount: 1 });",
  excerptStartLine: 1,
  language: "typescript"
};

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });
}

function completion(content: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    model: "accounts/fireworks/models/test",
    choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
    ...extra
  };
}

const noSleep = async () => undefined;

describe("FireworksAIProvider", () => {
  it("sends a single bounded prompt and returns validated edits", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const provider = new FireworksAIProvider(aiConfig(), {
      sleepImpl: noSleep,
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init: init! };
        return jsonResponse(
          completion({
            edits: [{ search: "client.createCharge", replace: "client.createPayment", reason: "rename" }],
            confidence: 0.9
          })
        );
      }
    });

    const result = await provider.suggestMigration(REQUEST);
    assert.equal(result.edits.length, 1);
    assert.equal(result.edits[0].replace, "client.createPayment");
    assert.equal(result.confidence, 0.9);

    assert.ok(captured!.url.endsWith("/chat/completions"));
    const headers = captured!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer fw_testkey0000000000");
    const body = JSON.parse(String(captured!.init.body));
    assert.equal(body.temperature, 0);
    assert.equal(body.messages.length, 2);
    assert.ok(String(body.messages[1].content).includes("src/pay.ts"));
  });

  it("drops hallucinated edits whose search text is not in the excerpt", async () => {
    const provider = new FireworksAIProvider(aiConfig(), {
      sleepImpl: noSleep,
      fetchImpl: async () =>
        jsonResponse(
          completion({
            edits: [
              { search: "client.createCharge", replace: "client.createPayment", reason: "ok" },
              { search: "somethingNeverPresent()", replace: "evil()", reason: "hallucinated" },
              { search: "identical", replace: "identical", reason: "no-op" }
            ],
            confidence: 0.4
          })
        )
    });
    const result = await provider.suggestMigration(REQUEST);
    assert.equal(result.edits.length, 1);
  });

  it("rejects a malformed envelope", async () => {
    const provider = new FireworksAIProvider(aiConfig(), {
      sleepImpl: noSleep,
      fetchImpl: async () => jsonResponse({ nope: true })
    });
    await assert.rejects(provider.suggestMigration(REQUEST), (error: unknown) => {
      assert.ok(error instanceof AIProviderError);
      assert.equal(error.code, "AI_RESPONSE_MALFORMED");
      return true;
    });
  });

  it("rejects a completion that is not JSON", async () => {
    const provider = new FireworksAIProvider(aiConfig(), {
      sleepImpl: noSleep,
      fetchImpl: async () => jsonResponse(completion("I think you should rewrite the file."))
    });
    await assert.rejects(provider.suggestMigration(REQUEST), /AI completion was not valid JSON/);
  });

  it("rejects a completion that does not match the schema", async () => {
    const provider = new FireworksAIProvider(aiConfig(), {
      sleepImpl: noSleep,
      fetchImpl: async () => jsonResponse(completion({ edits: [{ search: 1, replace: null }] }))
    });
    await assert.rejects(provider.suggestMigration(REQUEST), (error: unknown) => {
      assert.equal((error as AIProviderError).code, "AI_RESPONSE_SCHEMA_INVALID");
      return true;
    });
  });

  it("rejects an empty completion", async () => {
    const provider = new FireworksAIProvider(aiConfig(), {
      sleepImpl: noSleep,
      fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "" } }] })
    });
    await assert.rejects(provider.suggestMigration(REQUEST), /empty completion/);
  });

  it("accepts a fenced JSON completion", async () => {
    const provider = new FireworksAIProvider(aiConfig(), {
      sleepImpl: noSleep,
      fetchImpl: async () =>
        jsonResponse(
          completion(
            '```json\n{"edits":[{"search":"client.createCharge","replace":"client.createPayment","reason":"r"}],"confidence":0.7}\n```'
          )
        )
    });
    const result = await provider.suggestMigration(REQUEST);
    assert.equal(result.edits.length, 1);
  });

  it("times out and reports a retryable timeout error", async () => {
    const provider = new FireworksAIProvider(aiConfig({ FIREWORKS_TIMEOUT_MS: "1000", FIREWORKS_MAX_ATTEMPTS: "1" }), {
      sleepImpl: noSleep,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        })
    });
    await assert.rejects(provider.suggestMigration(REQUEST), (error: unknown) => {
      assert.ok(error instanceof AIProviderError);
      assert.equal(error.code, "AI_TIMEOUT");
      assert.equal(error.retryable, true);
      return true;
    });
  });

  it("honours an external abort signal without reporting a timeout", async () => {
    const controller = new AbortController();
    const provider = new FireworksAIProvider(aiConfig(), {
      sleepImpl: noSleep,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          setTimeout(() => controller.abort(), 5);
        })
    });
    await assert.rejects(provider.suggestMigration(REQUEST, controller.signal), (error: unknown) => {
      assert.equal((error as AIProviderError).code, "AI_CANCELLED");
      return true;
    });
  });

  it("retries on 5xx and succeeds on a later attempt", async () => {
    let calls = 0;
    const provider = new FireworksAIProvider(aiConfig(), {
      sleepImpl: noSleep,
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) return jsonResponse({ error: "upstream" }, { status: 503 });
        return jsonResponse(
          completion({ edits: [{ search: "client.createCharge", replace: "client.createPayment", reason: "r" }] })
        );
      }
    });
    const result = await provider.suggestMigration(REQUEST);
    assert.equal(calls, 3);
    assert.equal(result.edits.length, 1);
  });

  it("stops after maxAttempts", async () => {
    let calls = 0;
    const provider = new FireworksAIProvider(aiConfig({ FIREWORKS_MAX_ATTEMPTS: "2" }), {
      sleepImpl: noSleep,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ error: "upstream" }, { status: 500 });
      }
    });
    await assert.rejects(provider.suggestMigration(REQUEST));
    assert.equal(calls, 2);
  });

  it("treats 429 as retryable and honours Retry-After", async () => {
    const delays: number[] = [];
    let calls = 0;
    const provider = new FireworksAIProvider(aiConfig(), {
      sleepImpl: async (ms) => {
        delays.push(ms);
      },
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({ error: "slow down" }, { status: 429, headers: { "retry-after": "2" } });
        return jsonResponse(completion({ edits: [] }));
      }
    });
    await provider.suggestMigration(REQUEST);
    assert.deepEqual(delays, [2000]);
  });

  it("does not retry authentication failures", async () => {
    let calls = 0;
    const provider = new FireworksAIProvider(aiConfig(), {
      sleepImpl: noSleep,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ error: "bad key" }, { status: 401 });
      }
    });
    await assert.rejects(provider.suggestMigration(REQUEST), (error: unknown) => {
      assert.equal((error as AIProviderError).code, "AI_UNAUTHORIZED");
      assert.equal((error as AIProviderError).retryable, false);
      return true;
    });
    assert.equal(calls, 1);
  });

  it("never puts the API key into an error, even when the body echoes it", async () => {
    const provider = new FireworksAIProvider(aiConfig({ FIREWORKS_MAX_ATTEMPTS: "1" }), {
      sleepImpl: noSleep,
      fetchImpl: async () =>
        new Response("invalid key: fw_testkey0000000000 rejected", {
          status: 400,
          headers: { "content-type": "text/plain" }
        })
    });
    await assert.rejects(provider.suggestMigration(REQUEST), (error: unknown) => {
      const serialised = JSON.stringify((error as AIProviderError).toLogJSON());
      assert.ok(!serialised.includes("fw_testkey0000000000"), serialised);
      return true;
    });
  });

  it("refuses prompts larger than the configured budget", async () => {
    const provider = new FireworksAIProvider(aiConfig({ FIREWORKS_MAX_PROMPT_CHARS: "1000" }), {
      sleepImpl: noSleep,
      fetchImpl: async () => {
        throw new Error("must not be called");
      }
    });
    await assert.rejects(
      provider.suggestMigration({ ...REQUEST, excerpt: "x".repeat(5_000) }),
      /Prompt exceeds the configured character budget/
    );
  });

  it("refuses to run when no API key is configured", async () => {
    const config = loadConfig({ env: { DATABASE_URL: ENV.DATABASE_URL } }).ai;
    const provider = new FireworksAIProvider(config, { fetchImpl: async () => jsonResponse({}) });
    assert.equal(provider.enabled, false);
    await assert.rejects(provider.suggestMigration(REQUEST), /not configured/);
  });
});

describe("buildMigrationContext", () => {
  const change = {
    id: "bc1",
    type: "sdk-method-renamed" as const,
    path: "/charges",
    description: "renamed",
    severity: "breaking" as const
  };

  function usage(file: string, line = 5) {
    return {
      id: "u1",
      file,
      line,
      column: 1,
      functionName: "createCharge",
      snippet: "",
      contextBefore: "",
      contextAfter: "",
      confidence: "high" as const,
      breakingChangeId: "bc1"
    };
  }

  const bigFile = Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join("\n");

  it("includes only a bounded window around the call site", () => {
    const context = buildMigrationContext({ breakingChange: change, usage: usage("src/pay.ts", 200), fileContent: bigFile });
    const lines = context.excerpt.split("\n");
    assert.equal(lines.length, 51);
    assert.equal(context.excerptStartLine, 175);
    assert.ok(context.excerpt.includes("line199"));
    assert.ok(!context.excerpt.includes("line0 ="));
  });

  it("refuses secret-bearing paths", () => {
    for (const file of [".env", "config/.env.production", "deploy/id_rsa", "secrets.json", ".git/config"]) {
      assert.throws(
        () => buildMigrationContext({ breakingChange: change, usage: usage(file), fileContent: "x" }),
        SecurityError,
        `expected refusal for ${file}`
      );
    }
  });

  it("refuses non-source files", () => {
    assert.throws(
      () => buildMigrationContext({ breakingChange: change, usage: usage("README.md"), fileContent: "x" }),
      SecurityError
    );
  });

  it("refuses paths that try to escape the repository", () => {
    assert.throws(
      () => buildMigrationContext({ breakingChange: change, usage: usage("../../etc/shadow.ts"), fileContent: "x" }),
      SecurityError
    );
  });

  it("redacts credentials that appear inside the source excerpt", () => {
    const content = ["const a = 1;", 'const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";', "const b = 2;"].join("\n");
    const context = buildMigrationContext({ breakingChange: change, usage: usage("src/pay.ts", 1), fileContent: content });
    assert.ok(!context.excerpt.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  });

  it("caps the excerpt length", () => {
    const wide = Array.from({ length: 60 }, () => "x".repeat(1_000)).join("\n");
    const context = buildMigrationContext({
      breakingChange: change,
      usage: usage("src/pay.ts", 30),
      fileContent: wide
    });
    assert.ok(context.excerpt.length <= 8_100);
  });

  it("detects the language from the file extension", () => {
    assert.equal(
      buildMigrationContext({ breakingChange: change, usage: usage("src/a.ts"), fileContent: "x" }).language,
      "typescript"
    );
    assert.equal(
      buildMigrationContext({ breakingChange: change, usage: usage("src/a.js"), fileContent: "x" }).language,
      "javascript"
    );
  });
});

describe("createAIProvider", () => {
  it("uses the demo provider in demo mode", () => {
    const provider = createAIProvider(loadConfig({ env: { DATABASE_URL: ENV.DATABASE_URL, TERN_MODE: "demo" } }));
    assert.equal(provider.name, "ai-demo");
    assert.equal(provider.isReal, false);
  });

  it("disables AI when no key is configured, and fails loudly if called", async () => {
    const provider = createAIProvider(loadConfig({ env: { DATABASE_URL: ENV.DATABASE_URL } }));
    assert.equal(provider.enabled, false);
    assert.ok(provider instanceof DisabledAIProvider);
    await assert.rejects(provider.suggestMigration(REQUEST), /AI fallback is disabled/);
  });

  it("uses Fireworks when a key is configured", () => {
    const provider = createAIProvider(loadConfig({ env: ENV }));
    assert.equal(provider.name, "fireworks");
    assert.equal(provider.isReal, true);
  });

  it("demo provider returns deterministic edits and never touches the network", async () => {
    const provider = new DemoAIProvider(new Map([["client.createCharge", "client.createPayment"]]));
    const result = await provider.suggestMigration(REQUEST);
    assert.equal(result.edits[0].replace, "client.createPayment");
    assert.equal(result.model, "demo");
  });
});
