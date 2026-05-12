import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getModel, getModels, type AssistantMessage, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AuthStorage, createAgentSession, parseSkillBlock, SessionManager, SettingsManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ChatMessageView } from "../shared/types";
import { getChatGptApiKey, type ChatGptAuthCallbacks } from "../auth/chatgpt-auth";
import { defaultModelId, readChatSettings, writeChatSettings } from "./chat-settings";

const appSourceDir = dirname(fileURLToPath(import.meta.url));

export interface SkillInvocationView {
  name: string;
  content: string;
}

export interface ToolInvocationView {
  id: string;
  name: string;
  args?: any;
  result?: any;
  isError?: boolean;
  status: "start" | "end";
}

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
    await this.getSession();
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

  getLoadedResources(): { skills: string[]; extensions: string[] } {
    const skills = this.session.resourceLoader.getSkills().skills.map((skill: any) => skill.name);
    const extensions = this.session.resourceLoader.getExtensions().extensions.map((extension: any) => {
      if (extension.sourceInfo?.source?.startsWith("npm:")) return extension.sourceInfo.source.slice("npm:".length);
      const nodeModulesIndex = extension.path.split("/").lastIndexOf("node_modules");
      if (nodeModulesIndex >= 0) return extension.path.split("/").slice(nodeModulesIndex + 1, nodeModulesIndex + 3).join("/");
      return dirname(extension.path).split("/").at(-1) ?? extension.path;
    });
    return {
      skills: skills.sort((a: string, b: string) => a.localeCompare(b)),
      extensions: extensions.sort((a: string, b: string) => a.localeCompare(b)),
    };
  }

  getToolDefinition(name: string) {
    return this.session.getToolDefinition(name);
  }

  async bindExtensionUI(uiContext: ExtensionUIContext): Promise<void> {
    const session = await this.getSession();
    await session.bindExtensions({ uiContext });
  }

  private getRequestedSkillName(text: string): string | undefined {
    if (text.startsWith("/skill:")) return undefined;
    const normalized = text.toLowerCase();
    return this.session.resourceLoader.getSkills().skills.find((skill: any) => {
      const name = skill.name.toLowerCase();
      const terms = name.split("-");
      return normalized.includes(name) || terms.some((term: string) => term.length > 3 && normalized.includes(term));
    })?.name;
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
      const settings = JSON.parse(readFileSync(join(this.agentDir, "settings.json"), "utf8"));
      const result = await createAgentSession({
        cwd: this.appRoot,
        agentDir: this.agentDir,
        authStorage: this.authStorage,
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.inMemory(settings),
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

  private getMessageText(message: any): string {
    if (typeof message.content === "string") return message.content;
    return message.content
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text)
      .join("");
  }

  async sendMessage(
    text: string,
    onDelta: (text: string) => void,
    onSkillInvocation: (skill: SkillInvocationView) => void,
    onToolInvocation: (tool: ToolInvocationView) => void,
  ): Promise<ChatMessageView> {
    const apiKey = await getChatGptApiKey(this.authCallbacks);
    this.authStorage.setRuntimeApiKey("openai-codex", apiKey);
    const session = await this.getSession();
    const requestedSkillName = this.getRequestedSkillName(text);
    const promptText = requestedSkillName ? `/skill:${requestedSkillName} ${text}` : text;
    let assistantMessage: AssistantMessage | undefined;

    const unsubscribe = session.subscribe((event: any) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        onDelta(event.assistantMessageEvent.delta);
      }
      if (event.type === "tool_execution_start") {
        onToolInvocation({ id: event.toolCallId, name: event.toolName, args: event.args, status: "start" });
      }
      if (event.type === "tool_execution_end") {
        onToolInvocation({ id: event.toolCallId, name: event.toolName, result: event.result, isError: event.isError, status: "end" });
      }
      if (event.type === "message_end" && event.message.role === "user") {
        const skillBlock = parseSkillBlock(this.getMessageText(event.message));
        if (skillBlock) onSkillInvocation({ name: skillBlock.name, content: skillBlock.content });
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        assistantMessage = event.message;
      }
    });

    try {
      await session.prompt(promptText);
    } finally {
      unsubscribe();
    }

    return {
      role: "assistant",
      content: assistantMessage ? this.getAssistantText(assistantMessage) : "",
    };
  }
}
