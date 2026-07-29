
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmResponse {
  content: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  model?: string;
}

export interface LlmAdapter {
  complete(messages: LlmMessage[]): Promise<LlmResponse>;
}

export interface StructuredDiffResponse {
  thinking: string;
  changes: Array<{
    filePath: string;
    search: string;
    replace: string;
    reason: string;
  }>;
}
