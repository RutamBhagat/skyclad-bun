import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { getOAuthApiKey, type OAuthCredentials } from "@earendil-works/pi-ai/oauth";

const authFilePath = new URL("../../../.auth/oauth.json", import.meta.url);

type OAuthAuthFile = Partial<Record<"openai-codex", OAuthCredentials & { type: "oauth" }>>;

async function readAuthFile() {
  try {
    return JSON.parse(await readFile(authFilePath, "utf8")) as OAuthAuthFile;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function writeAuthFile(auth: OAuthAuthFile) {
  await mkdir(dirname(authFilePath.pathname), { recursive: true });
  await writeFile(authFilePath, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
}

export async function getOpenAICodexOAuthApiKey() {
  const auth = await readAuthFile();
  const result = await getOAuthApiKey("openai-codex", auth);

  if (!result) return undefined;

  auth["openai-codex"] = { type: "oauth", ...result.newCredentials };
  await writeAuthFile(auth);

  return result.apiKey;
}
