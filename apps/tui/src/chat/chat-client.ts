import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getModel, getModels, type AssistantMessage, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AuthStorage, createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChatMessageView } from "../shared/types";
import { getChatGptApiKey, type ChatGptAuthCallbacks } from "../auth/chatgpt-auth";
import { defaultModelId, readChatSettings, writeChatSettings } from "./chat-settings";

const appSourceDir = dirname(fileURLToPath(import.meta.url));

function findAppRoot(): string {
  const candidates = [process.cwd(), appSourceDir];

  for (const start of candidates) {
    let current = start;
    while (true) {
      if (existsSync(join(current, "package.json")) && existsSync(join(current, ".pi"))) {
        return current;
      }

      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  throw new Error("Could not find app root with package.json and .pi directory.");
}

export class ChatClient {
  private readonly appRoot = findAppRoot();
  private readonly agentDir = join(this.appRoot, ".pi");
  private readonly authStorage = AuthStorage.inMemory();
  private session: any;
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

    if (this.session) {
      this.session.setThinkingLevel(reasoningLevel);
      await this.session.setModel(getModel("openai-codex", modelId as never));
    }
  }

  private async getSession() {
    if (!this.session) {
      const result = await createAgentSession({
        cwd: this.appRoot,
        agentDir: this.agentDir,
        authStorage: this.authStorage,
        sessionManager: SessionManager.inMemory(),
        model: getModel("openai-codex", this.modelId as never),
        thinkingLevel: this.reasoningLevel,
      });
      this.session = result.session;
    }

    return this.session;
  }

  private getAssistantText(message: AssistantMessage): string {
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  async sendMessage(text: string, onDelta: (text: string) => void): Promise<ChatMessageView> {
    const apiKey = await getChatGptApiKey(this.authCallbacks);
    this.authStorage.setRuntimeApiKey("openai-codex", apiKey);
    const session = await this.getSession();
    let assistantMessage: AssistantMessage | undefined;

    const unsubscribe = session.subscribe((event: any) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        onDelta(event.assistantMessageEvent.delta);
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        assistantMessage = event.message;
      }
    });

    try {
      await session.prompt(text);
    } finally {
      unsubscribe();
    }

    return {
      role: "assistant",
      content: assistantMessage ? this.getAssistantText(assistantMessage) : "",
    };
  }
}
