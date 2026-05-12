import { getModel, stream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import type { ChatMessageView } from "../shared/types";
import { getChatGptApiKey, type ChatGptAuthCallbacks } from "../auth/chatgpt-auth";

const model = getModel("openai-codex", "gpt-5.5");

export class ChatClient {
  private context: Context = {
    systemPrompt: "You are a helpful assistant.",
    messages: [],
  };

  constructor(private readonly authCallbacks: ChatGptAuthCallbacks) {}

  private getAssistantText(message: AssistantMessage): string {
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  async sendMessage(text: string, onDelta: (text: string) => void): Promise<ChatMessageView> {
    this.context.messages.push({ role: "user", content: text, timestamp: Date.now() });

    const apiKey = await getChatGptApiKey(this.authCallbacks);
    const response = stream(model, this.context, {
      apiKey,
      sessionId: crypto.randomUUID(),
      transport: "auto",
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
