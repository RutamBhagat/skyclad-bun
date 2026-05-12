import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const settingsPath = join(appRoot, ".data/chat-settings.json");

export const defaultModelId = "gpt-5.4-mini";
export const defaultReasoningLevel: ModelThinkingLevel = "medium";

export interface ChatSettings {
  modelId: string;
  reasoningLevel: ModelThinkingLevel;
}

export async function readChatSettings(): Promise<ChatSettings> {
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Partial<ChatSettings>;
    return {
      modelId: settings.modelId ?? defaultModelId,
      reasoningLevel: settings.reasoningLevel ?? defaultReasoningLevel,
    };
  } catch {
    return { modelId: defaultModelId, reasoningLevel: defaultReasoningLevel };
  }
}

export async function writeChatSettings(settings: ChatSettings): Promise<void> {
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}
