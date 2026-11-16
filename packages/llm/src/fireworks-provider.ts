import { z } from "zod";
import {
  AIProviderError,
  getLogger,
  internalMessageOf,
  redactSecrets,
  sleep,
  backoffDelay,
  type AIConfig,
  type AIMigrationRequest,
  type AIMigrationResponse,
  type AIProvider
} from "@tern/shared";

const logger = getLogger("ai-fireworks");

const SYSTEM_PROMPT = [
  "You are a code migration assistant embedded in an automated pipeline.",
  "You receive ONE excerpt from ONE source file plus a description of a breaking API change.",
  "Return search/replace edits that make the excerpt compatible with the new API.",
  "",
  "Hard rules:",
  "- `search` must be text copied verbatim from the excerpt.",
  "- Change only what the breaking change requires. Never refactor unrelated code.",
  "- Never add dependencies, imports of child_process/vm/eval, credentials, or configuration.",
  "- If you cannot make a safe, minimal edit, return an empty edits array.",
  "",
  'Respond with JSON only: {"edits":[{"search":"...","replace":"...","reason":"..."}],"confidence":0.0}'
].join("\n");

/** Shape Tern requires from the model. Anything else is a malformed response. */
const responseSchema = z.object({
  edits: z
    .array(
      z.object({
        search: z.string().min(1).max(20_000),
        replace: z.string().max(20_000),
        reason: z.string().max(1_000).optional().default("")
      })
    )
    .max(20),
  confidence: z.number().min(0).max(1).optional().default(0)
});

const chatCompletionSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }).optional(),
        finish_reason: z.string().nullable().optional()
      })
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional()
    })
    .optional()
});

export interface FireworksProviderOptions {
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests so retry behaviour can be verified without real delays. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Fireworks AI provider.
 *
 * Guarantees:
 *  - the API key comes from validated configuration, is wrapped in `Secret`, and is
 *    only ever placed in the Authorization header — never logged, never in an error
 *  - every request has a hard timeout backed by AbortController
 *  - 429 / 5xx / network failures are retried with exponential backoff and honour
 *    `Retry-After`; 4xx client errors are not retried
 *  - the response body is validated against a schema; malformed JSON, missing
 *    choices, or edits that are not present in the excerpt are rejected
 *  - the provider returns *proposed* edits only. It never writes files. The caller
 *    must run every edit through patch validation before it can become a patch.
 */
export class FireworksAIProvider implements AIProvider {
  readonly name = "fireworks";
  readonly isReal = true;

  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(
    private readonly config: AIConfig,
    options: FireworksProviderOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = options.sleepImpl ?? ((ms) => sleep(ms));
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  async suggestMigration(request: AIMigrationRequest, signal?: AbortSignal): Promise<AIMigrationResponse> {
    if (!this.config.enabled) {
      throw new AIProviderError("The AI provider is not configured", {
        code: "AI_NOT_CONFIGURED",
        publicMessage: "AI-assisted migration is not enabled."
      });
    }

    const userPrompt = renderPrompt(request);
    if (userPrompt.length > this.config.maxPromptChars) {
      throw new AIProviderError("Prompt exceeds the configured character budget", {
        code: "AI_PROMPT_TOO_LARGE",
        details: { length: userPrompt.length, limit: this.config.maxPromptChars }
      });
    }

    let lastError: AIProviderError | undefined;
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      try {
        const raw = await this.requestCompletion(userPrompt, signal);
        return this.parseResponse(raw, request);
      } catch (error) {
        const providerError = asProviderError(error);
        lastError = providerError;
        if (!providerError.retryable || attempt === this.config.maxAttempts) throw providerError;

        const retryAfterMs = Number(providerError.details.retryAfterMs ?? 0);
        const delayMs = retryAfterMs > 0 ? retryAfterMs : backoffDelay(attempt, { baseDelayMs: 500, maxDelayMs: 20_000 });
        logger.warn("retrying AI request", {
          attempt,
          maxAttempts: this.config.maxAttempts,
          delayMs,
          code: providerError.code
        });
        await this.sleepImpl(delayMs);
      }
    }
    throw lastError ?? new AIProviderError("AI request failed", { code: "AI_REQUEST_FAILED" });
  }

  private async requestCompletion(userPrompt: string, signal?: AbortSignal): Promise<{ body: unknown; model: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey.reveal()}`,
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt }
          ],
          temperature: 0,
          max_tokens: 2_048,
          response_format: { type: "json_object" }
        }),
        signal: controller.signal
      });

      if (!response.ok) throw await this.httpError(response);

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new AIProviderError("AI provider returned a non-JSON body", {
          code: "AI_RESPONSE_NOT_JSON",
          retryable: true,
          cause: error
        });
      }
      return { body, model: this.config.model };
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw new AIProviderError(`AI request timed out after ${this.config.timeoutMs}ms`, {
          code: "AI_TIMEOUT",
          retryable: true,
          details: { timeoutMs: this.config.timeoutMs }
        });
      }
      if (signal?.aborted) {
        throw new AIProviderError("AI request was cancelled", { code: "AI_CANCELLED", retryable: false });
      }
      if (error instanceof AIProviderError) throw error;
      throw new AIProviderError("AI provider request failed", {
        code: "AI_NETWORK_ERROR",
        retryable: true,
        cause: error,
        details: { reason: redactSecrets(internalMessageOf(error)) }
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private async httpError(response: Response): Promise<AIProviderError> {
    // Bodies can echo request content; redact before it reaches diagnostics.
    const text = redactSecrets((await response.text().catch(() => "")).slice(0, 500));
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));

    if (response.status === 429) {
      return new AIProviderError("AI provider rate limit exceeded", {
        code: "AI_RATE_LIMITED",
        retryable: true,
        details: { status: 429, retryAfterMs, body: text },
        publicMessage: "The AI provider is rate limiting Tern. The migration will be retried."
      });
    }
    if (response.status === 401 || response.status === 403) {
      return new AIProviderError("AI provider rejected the credentials", {
        code: "AI_UNAUTHORIZED",
        retryable: false,
        details: { status: response.status },
        publicMessage: "AI-assisted migration is misconfigured."
      });
    }
    return new AIProviderError(`AI provider returned HTTP ${response.status}`, {
      code: `AI_HTTP_${response.status}`,
      retryable: response.status >= 500,
      details: { status: response.status, body: text, retryAfterMs }
    });
  }

  private parseResponse(raw: { body: unknown; model: string }, request: AIMigrationRequest): AIMigrationResponse {
    const envelope = chatCompletionSchema.safeParse(raw.body);
    if (!envelope.success) {
      throw new AIProviderError("AI provider returned an unexpected response envelope", {
        code: "AI_RESPONSE_MALFORMED",
        retryable: true,
        details: { issues: envelope.error.issues.map((i) => i.path.join(".")).slice(0, 5) }
      });
    }

    const content = envelope.data.choices[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new AIProviderError("AI provider returned an empty completion", {
        code: "AI_RESPONSE_EMPTY",
        retryable: true
      });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripCodeFence(content));
    } catch {
      throw new AIProviderError("AI completion was not valid JSON", {
        code: "AI_RESPONSE_NOT_JSON",
        retryable: true
      });
    }

    const parsed = responseSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new AIProviderError("AI completion did not match the required schema", {
        code: "AI_RESPONSE_SCHEMA_INVALID",
        retryable: true,
        details: { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 5) }
      });
    }

    // Structural validation: an edit that cannot be located in the excerpt, or that
    // changes nothing, is a hallucination and is dropped rather than trusted.
    const edits = parsed.data.edits.filter((edit) => {
      if (edit.search === edit.replace) return false;
      if (!request.excerpt.includes(edit.search)) {
        logger.warn("dropping AI edit whose search text is absent from the excerpt", {
          file: request.usage.file,
          searchLength: edit.search.length
        });
        return false;
      }
      return true;
    });

    logger.info("AI migration suggestion received", {
      file: request.usage.file,
      proposed: parsed.data.edits.length,
      accepted: edits.length,
      model: envelope.data.model ?? raw.model,
      totalTokens: envelope.data.usage?.total_tokens
    });

    return {
      edits,
      confidence: parsed.data.confidence,
      model: envelope.data.model ?? raw.model,
      usage: envelope.data.usage
        ? {
            promptTokens: envelope.data.usage.prompt_tokens ?? 0,
            completionTokens: envelope.data.usage.completion_tokens ?? 0,
            totalTokens: envelope.data.usage.total_tokens ?? 0
          }
        : undefined
    };
  }
}

export function renderPrompt(request: AIMigrationRequest): string {
  return [
    "# Breaking change",
    `type: ${request.breakingChange.type}`,
    `description: ${request.breakingChange.description}`,
    `endpoint: ${request.breakingChange.method ?? ""} ${request.breakingChange.path}`,
    request.breakingChange.operationId ? `operationId: ${request.breakingChange.operationId}` : "",
    request.breakingChange.migrationHint ? `hint: ${request.breakingChange.migrationHint}` : "",
    "",
    "# Affected call site",
    `file: ${request.usage.file}`,
    `line: ${request.usage.line}`,
    `symbol: ${request.usage.functionName}`,
    "",
    `# Excerpt (${request.language}, starting at line ${request.excerptStartLine})`,
    "```",
    request.excerpt,
    "```"
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

function parseRetryAfter(header: string | null): number {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 60_000));
  return 0;
}

function asProviderError(error: unknown): AIProviderError {
  if (error instanceof AIProviderError) return error;
  return new AIProviderError("AI provider request failed", {
    code: "AI_REQUEST_FAILED",
    retryable: false,
    cause: error
  });
}
