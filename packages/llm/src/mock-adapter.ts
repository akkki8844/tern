
import { LlmAdapter, LlmMessage, LlmResponse, StructuredDiffResponse } from "./interfaces.js";

export class MockLlmAdapter implements LlmAdapter {
  async complete(messages: LlmMessage[]): Promise<LlmResponse> {
    const last = messages[messages.length - 1]?.content ?? "";
    const lower = last.toLowerCase();
    if (lower.includes("rename") && lower.includes("source") && lower.includes("payment_method")) {
      return { content: JSON.stringify({ thinking: "Rename field", changes: [{ filePath: "client.ts", search: "source", replace: "payment_method", reason: "Field renamed" }] }) };
    }
    if (lower.includes("rename") && lower.includes("status") && lower.includes("state")) {
      return { content: JSON.stringify({ thinking: "Rename field", changes: [{ filePath: "client.ts", search: "status", replace: "state", reason: "Field renamed" }] }) };
    }
    return { content: JSON.stringify({ thinking: "No safe migration available", changes: [] }) };
  }

  async completeStructuredDiff(messages: LlmMessage[]): Promise<StructuredDiffResponse> {
    const response = await this.complete(messages);
    const parsed = JSON.parse(response.content);
    return { thinking: parsed.thinking || "", changes: parsed.changes || [] };
  }
}
