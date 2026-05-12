import { mkdir, readFile, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getOAuthApiKey, loginOpenAICodex, type OAuthCredentials } from "@earendil-works/pi-ai/oauth";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const authPath = join(appRoot, ".data/chatgpt-auth.json");
const providerId = "openai-codex";

type OAuthCredential = { type: "oauth" } & OAuthCredentials;
type AuthFile = Record<string, OAuthCredential>;

async function readAuthFile(): Promise<AuthFile> {
  try {
    return JSON.parse(await readFile(authPath, "utf8")) as AuthFile;
  } catch {
    return {};
  }
}

async function writeAuthFile(auth: AuthFile): Promise<void> {
  await mkdir(dirname(authPath), { recursive: true });
  await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`);
}

export interface ChatGptAuthCallbacks {
  onStatus: (message: string) => void;
  onPrompt: (message: string) => Promise<string>;
}

function getOAuthCredentials(auth: AuthFile): Record<string, OAuthCredentials> {
  const credentials: Record<string, OAuthCredentials> = {};
  for (const [key, value] of Object.entries(auth)) {
    if (value.type === "oauth") credentials[key] = value;
  }
  return credentials;
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${command} "${url}"`);
}

export async function getChatGptApiKey(callbacks: ChatGptAuthCallbacks): Promise<string> {
  const auth = await readAuthFile();
  const existing = await getOAuthApiKey(providerId, getOAuthCredentials(auth));

  if (existing) {
    auth[providerId] = { type: "oauth", ...existing.newCredentials };
    await writeAuthFile(auth);
    return existing.apiKey;
  }

  throw new Error("Not logged in. Use /login to authenticate with ChatGPT Codex.");
}

export async function loginChatGpt(callbacks: ChatGptAuthCallbacks): Promise<string> {
  callbacks.onStatus("ChatGPT OAuth login required.");
  let manualCodeResolve: ((code: string) => void) | undefined;
  const manualCodePromise = new Promise<string>((resolve) => {
    manualCodeResolve = resolve;
  });

  const credentials = await loginOpenAICodex({
    onAuth: (info) => {
      callbacks.onStatus(`${info.instructions ?? "Open this URL to log in:"}\n${info.url}`);
      openBrowser(info.url);
      void callbacks.onPrompt("Paste redirect URL below, or complete login in browser:").then((value) => {
        if (value && manualCodeResolve) manualCodeResolve(value);
      });
    },
    onPrompt: (prompt) => callbacks.onPrompt(prompt.message),
    onProgress: callbacks.onStatus,
    onManualCodeInput: () => manualCodePromise,
  });

  const auth = await readAuthFile();
  auth[providerId] = { type: "oauth", ...credentials };
  await writeAuthFile(auth);
  return credentials.access;
}
