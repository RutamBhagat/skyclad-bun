import { Agent, type AgentEvent, type AgentMessage, type AgentState } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { env } from "@skyclad-bun/env/server";

const SYSTEM_PROMPT = `You are a helpful AI research assistant for arXiv papers.

Answer clearly and directly. Retrieval tools will be added server-side in the next migration step.`;

const DEFAULT_MODEL = getModel("anthropic", "claude-sonnet-4-5-20250929");

if (!DEFAULT_MODEL) {
  throw new Error("Default agent model not found.");
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
    tools: [],
  };
}

export function createAgent(sessionId: string, initialState?: Partial<AgentState>) {
  const agent = new Agent({
    initialState: {
      ...createDefaultAgentState(),
      ...initialState,
      tools: [],
    },
    sessionId,
    getApiKey(provider: string) {
      switch (provider) {
        case "anthropic":
          return env.ANTHROPIC_API_KEY;
        case "openai":
          return env.OPENAI_API_KEY;
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

export function getOrCreateAgent(sessionId: string, state?: Partial<AgentState>) {
  return getAgent(sessionId) ?? createAgent(sessionId, state);
}

export function getAgent(sessionId: string) {
  return activeAgents.get(sessionId);
}

export function abortAgent(sessionId: string) {
  activeAgents.get(sessionId)?.abort();
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
