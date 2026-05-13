import { exec } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const authPath = join(appRoot, ".data/auth.json");

export interface ChatAuthCallbacks {
  onStatus: (message: string) => void;
  onPrompt: (message: string) => Promise<string>;
}

export function createChatAuthStorage(): AuthStorage {
  return AuthStorage.create(authPath);
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${command} "${url}"`);
}

export async function loginChatGpt(callbacks: ChatAuthCallbacks): Promise<void> {
  let manualCodeResolve: ((code: string) => void) | undefined;
  const manualCodePromise = new Promise<string>((resolve) => {
    manualCodeResolve = resolve;
  });

  const oauthCallbacks: OAuthLoginCallbacks = {
    onAuth: (info) => {
      callbacks.onStatus(`${info.instructions ?? "Open this URL to log in:"}\n${info.url}`);
      openBrowser(info.url);
      void callbacks
        .onPrompt("Paste redirect URL below, or complete login in browser:")
        .then((value) => {
          if (value && manualCodeResolve) manualCodeResolve(value);
        });
    },
    onPrompt: (prompt) => callbacks.onPrompt(prompt.message),
    onProgress: callbacks.onStatus,
    onManualCodeInput: () => manualCodePromise,
  };

  await createChatAuthStorage().login("openai-codex", oauthCallbacks);
}

export async function loginProviderApiKey(providerId: string, apiKey: string): Promise<void> {
  const key = apiKey.trim();
  if (!key) throw new Error("API key cannot be empty.");
  createChatAuthStorage().set(providerId, { type: "api_key", key });
}

export async function logoutProvider(providerId: string): Promise<void> {
  createChatAuthStorage().logout(providerId);
}
