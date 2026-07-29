
import { getConfig, getLogger, withRetry } from "@tern/shared";
import { LlmAdapter, LlmMessage, LlmResponse } from "./interfaces";
const logger = getLogger("llm");

export class FireworksAdapter implements LlmAdapter {
  private config = getConfig();
  async complete(messages: LlmMessage[]): Promise<LlmResponse> {
    if (!this.config.FIREWORKS_API_KEY) throw new Error("FIREWORKS_API_KEY not configured");
    const response = await withRetry(() => fetch(this.config.FIREWORKS_BASE_URL + "/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.FIREWORKS_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.FIREWORKS_MODEL,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        temperature: 0.1,
        max_tokens: 4096
      })
    }), { maxAttempts: 3 });
    if (!response.ok) throw new Error(`Fireworks API error: ${response.status}`);
    const json = await response.json() as any;
    const content = json.choices?.[0]?.message?.content ?? "";
    logger.info({ usage: json.usage }, "llm completion");
    return { content, usage: json.usage };
  }
}
