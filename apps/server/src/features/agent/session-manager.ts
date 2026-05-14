import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentState,
} from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { env } from "@skyclad-bun/env/server";

import { getOpenAICodexOAuthApiKey } from "./oauth-auth";
import { formatServerSkillsPrompt } from "./skills";
import { defaultServerTools } from "./tools";

const SYSTEM_PROMPT = `You are a helpful AI research assistant for arXiv papers.

${formatServerSkillsPrompt()}`;

const DEFAULT_MODEL = getModel("openai-codex", "gpt-5.4-mini");

if (!DEFAULT_MODEL) {
  throw new Error("Default agent model not found.");
}

function isAllowedModel(model: unknown) {
  const provider = (model as { provider?: unknown } | undefined)?.provider;
  return provider === "openai-codex" || provider === "google";
}

function sanitizeInitialState(initialState?: Partial<AgentState>) {
  if (!initialState) return undefined;
  if (!initialState.model || isAllowedModel(initialState.model))
    return initialState;

  return {
    ...initialState,
    model: DEFAULT_MODEL,
  };
}

type Listener = (event: AgentEvent) => void | Promise<void>;

export type PersistableAgentState = Pick<
  AgentState,
  "systemPrompt" | "model" | "thinkingLevel" | "messages"
>;

const activeAgents = new Map<string, Agent>();

export function createDefaultAgentState(): Partial<AgentState> {
  return {
    systemPrompt: SYSTEM_PROMPT,
    model: DEFAULT_MODEL,
    thinkingLevel: "off",
    messages: [],
    tools: defaultServerTools,
  };
}

export function createAgent(
  sessionId: string,
  initialState?: Partial<AgentState>,
) {
  const agent = new Agent({
    initialState: {
      ...createDefaultAgentState(),
      ...sanitizeInitialState(initialState),
      tools: defaultServerTools,
    },
    sessionId,
    async getApiKey(provider: string) {
      switch (provider) {
        case "openai-codex":
          return getOpenAICodexOAuthApiKey();
        case "google":
          return env.GOOGLE_API_KEY;
        default:
          return undefined;
      }
    },
    toolExecution: "parallel",
  });

  activeAgents.set(sessionId, agent);
  return agent;
}

export function getOrCreateAgent(
  sessionId: string,
  state?: Partial<AgentState>,
) {
  return getAgent(sessionId) ?? createAgent(sessionId, state);
}

export function getAgent(sessionId: string) {
  return activeAgents.get(sessionId);
}

export function abortAgent(sessionId: string) {
  activeAgents.get(sessionId)?.abort();
}

export function assertAllowedModel(model: unknown) {
  if (!isAllowedModel(model)) {
    throw new Error(
      "Only ChatGPT OAuth and Gemini API-key models are enabled.",
    );
  }
}

export function toPersistableState(agent: Agent): PersistableAgentState {
  return {
    systemPrompt: agent.state.systemPrompt,
    model: agent.state.model,
    thinkingLevel: agent.state.thinkingLevel,
    messages: agent.state.messages,
  };
}

export async function streamPrompt(
  agent: Agent,
  input: string | AgentMessage | AgentMessage[],
  onEvent: Listener,
) {
  const unsubscribe = agent.subscribe(onEvent);

  try {
    if (typeof input === "string") {
      await agent.prompt(input);
    } else {
      await agent.prompt(input);
    }
    await agent.waitForIdle();
  } finally {
    unsubscribe();
  }
}
