
import { LlmAdapter, LlmMessage, LlmResponse, StructuredDiffResponse } from "./interfaces";

export class MockLlmAdapter implements LlmAdapter {
  private responses: Map<string, string> = new Map();

  constructor() {
    this.responses.set("rename", JSON.stringify({ thinking: "Rename field", changes: [{ filePath: "client.ts", search: "source", replace: "payment_method", reason: "Field renamed" }] }));
    this.responses.set("default", "No safe migration available from deterministic rules.");
  }

  async complete(messages: LlmMessage[]): Promise<LlmResponse> {
    const last = messages[messages.length - 1]?.content ?? "";
    const content = this.findResponse(last);
    return { content };
  }

  async completeStructuredDiff(messages: LlmMessage[]): Promise<StructuredDiffResponse> {
    const response = await this.complete(messages);
    return this.parseStructuredDiff(response.content);
  }

  private findResponse(content: string): string {
    const lower = content.toLowerCase();
    for (const [key, value] of this.responses.entries()) {
      if (lower.includes(key)) return value;
    }
    return this.responses.get("default")!;
  }

  private parseStructuredDiff(content: string): StructuredDiffResponse {
    try {
      const parsed = JSON.parse(content);
      return { thinking: parsed.thinking || "", changes: parsed.changes || [] };
    } catch {
      return { thinking: "", changes: [] };
    }
  }
}
