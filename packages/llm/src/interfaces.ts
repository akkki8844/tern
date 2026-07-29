
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmResponse {
  content: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface LlmAdapter {
  complete(messages: LlmMessage[]): Promise<LlmResponse>;
}
