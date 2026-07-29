
import { LlmAdapter, LlmMessage, LlmResponse } from "./interfaces";

export class MockLlmAdapter implements LlmAdapter {
  async complete(messages: LlmMessage[]): Promise<LlmResponse> {
    const last = messages[messages.length - 1]?.content ?? "";
    if (last.includes("rename") || last.includes("source")) {
      return { content: "Rename `source` to `payment_method` and add `customer_id` when missing." };
    }
    return { content: "No safe migration available." };
  }
}
