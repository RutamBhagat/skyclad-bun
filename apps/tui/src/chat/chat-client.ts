import { getModel, getModels, stream, type AssistantMessage, type Context, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ChatMessageView } from "../shared/types";
import { getChatGptApiKey, type ChatGptAuthCallbacks } from "../auth/chatgpt-auth";
import { defaultModelId, readChatSettings, writeChatSettings } from "./chat-settings";

export class ChatClient {
  private context: Context = {
    systemPrompt: "You are a helpful assistant.",
    messages: [],
  };
  private modelId = defaultModelId;
  private reasoningLevel: ModelThinkingLevel = "medium";

  constructor(private readonly authCallbacks: ChatGptAuthCallbacks) {}

  async loadSettings(): Promise<void> {
    const settings = await readChatSettings();
    this.modelId = settings.modelId;
    this.reasoningLevel = settings.reasoningLevel;
  }

  getAvailableModels() {
    return getModels("openai-codex");
  }

  getModelId(): string {
    return this.modelId;
  }

  getReasoningLevel(): ModelThinkingLevel {
    return this.reasoningLevel;
  }

  async setModel(modelId: string, reasoningLevel: ModelThinkingLevel): Promise<void> {
    this.modelId = modelId;
    this.reasoningLevel = reasoningLevel;
    await writeChatSettings({ modelId, reasoningLevel });
  }

  private getAssistantText(message: AssistantMessage): string {
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  async sendMessage(text: string, onDelta: (text: string) => void): Promise<ChatMessageView> {
    this.context.messages.push({ role: "user", content: text, timestamp: Date.now() });

    const apiKey = await getChatGptApiKey(this.authCallbacks);
    const model = getModel("openai-codex", this.modelId as never);
    const response = stream(model, this.context, {
      apiKey,
      sessionId: crypto.randomUUID(),
      transport: "auto",
      reasoning: this.reasoningLevel === "off" ? undefined : this.reasoningLevel,
    });

    for await (const event of response) {
      if (event.type === "text_delta") onDelta(event.delta);
    }

    const assistantMessage = await response.result();
    this.context.messages.push(assistantMessage);

    return {
      role: "assistant",
      content: this.getAssistantText(assistantMessage),
    };
  }
}
