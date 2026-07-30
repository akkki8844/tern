
import { getConfig, getLogger, withRetry } from "@tern/shared";
import { LlmAdapter, LlmMessage, LlmResponse, StructuredDiffResponse } from "./interfaces";
const logger = getLogger("llm");

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.05;

export class FireworksAdapter implements LlmAdapter {
  private config = getConfig();
  private totalTokens = 0;

  async complete(messages: LlmMessage[]): Promise<LlmResponse> {
    if (!this.config.FIREWORKS_API_KEY) throw new Error("FIREWORKS_API_KEY not configured");
    const trimmed = this.trimMessages(messages);
    const response = await withRetry(() => this.callApi(trimmed), { maxAttempts: 3, retryable: err => this.isRetryable(err) });
    this.totalTokens += response.usage?.totalTokens ?? 0;
    logger.info("llm completion", { totalTokens: this.totalTokens, model: response.model });
    return response;
  }

  async completeStructuredDiff(messages: LlmMessage[]): Promise<StructuredDiffResponse> {
    const response = await this.complete(messages);
    const parsed = this.parseStructuredDiff(response.content);
    this.validateStructuredDiff(parsed);
    return parsed;
  }

  getTotalTokens(): number { return this.totalTokens; }
  resetTokens(): void { this.totalTokens = 0; }

  private async callApi(messages: LlmMessage[]): Promise<LlmResponse> {
    const res = await fetch(`${this.config.FIREWORKS_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.FIREWORKS_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.FIREWORKS_MODEL,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        temperature: DEFAULT_TEMPERATURE,
        max_tokens: DEFAULT_MAX_TOKENS,
        response_format: { type: "json_object" }
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Fireworks API error ${res.status}: ${body}`);
    }
    const json = await res.json() as any;
    const content = json.choices?.[0]?.message?.content ?? "";
    return {
      content,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? 0
      },
      model: json.model
    };
  }

  private trimMessages(messages: LlmMessage[]): LlmMessage[] {
    return messages.map(m => ({ ...m, content: this.truncateContent(m.content, 12000) }));
  }

  private truncateContent(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    const lines = content.split("\n");
    let result = "";
    for (const line of lines) {
      if (result.length + line.length + 1 > maxChars) {
        result += "\n... [truncated]";
        break;
      }
      result += (result ? "\n" : "") + line;
    }
    return result;
  }

  private isRetryable(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /timeout|rate.?limit|503|502|429|504|500/i.test(message);
  }

  private parseStructuredDiff(content: string): StructuredDiffResponse {
    const cleaned = content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed.changes)) {
        return { thinking: parsed.thinking || "", changes: [] };
      }
      return {
        thinking: parsed.thinking || "",
        changes: parsed.changes.map((c: any) => ({
          filePath: String(c.filePath || ""),
          search: String(c.search || ""),
          replace: String(c.replace || ""),
          reason: String(c.reason || "")
        })).filter((c: any) => c.search && c.replace)
      };
    } catch {
      return { thinking: "", changes: [] };
    }
  }

  private validateStructuredDiff(diff: StructuredDiffResponse): void {
    const seen = new Set<string>();
    for (const change of diff.changes) {
      if (!change.search || !change.replace) throw new Error("Structured diff entry missing search or replace");
      if (change.search === change.replace) throw new Error("Structured diff entry has no change");
      const key = `${change.filePath}:${change.search.slice(0, 40)}`;
      if (seen.has(key)) throw new Error("Duplicate structured diff entry");
      seen.add(key);
    }
  }
}
