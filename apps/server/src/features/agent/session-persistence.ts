import { db, desc, eq } from "@skyclad-bun/db";
import { agentSessions } from "@skyclad-bun/db/schema/index";

import {
  getAgent,
  toPersistableState,
  type PersistableAgentState,
} from "./session-manager";

type AgentSessionRow = typeof agentSessions.$inferSelect;

type SessionUsageView = {
  cost: number;
  usingSubscription: boolean;
};

export async function listSessionSummaries() {
  return db
    .select({
      sessionId: agentSessions.id,
      title: agentSessions.title,
      createdAt: agentSessions.createdAt,
      updatedAt: agentSessions.updatedAt,
    })
    .from(agentSessions)
    .orderBy(desc(agentSessions.updatedAt));
}

export async function findSession(sessionId: string) {
  const rows = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);

  return rows[0];
}

export async function createSession(sessionId: string, state: PersistableAgentState) {
  const now = new Date();

  await db.insert(agentSessions).values({
    id: sessionId,
    title: "",
    state,
    createdAt: now,
    updatedAt: now,
  });

  return findSession(sessionId);
}

export async function deleteSession(sessionId: string) {
  await db.delete(agentSessions).where(eq(agentSessions.id, sessionId));
}

export function persistedState(row: AgentSessionRow) {
  return row.state as PersistableAgentState;
}

function sessionUsage(state: PersistableAgentState): SessionUsageView {
  let cost = 0;

  for (const message of state.messages) {
    if (message.role === "assistant") {
      cost += message.usage.cost.total;
    }
  }

  return {
    cost,
    usingSubscription: state.model?.provider === "openai-codex",
  };
}

export function snapshot(row: AgentSessionRow) {
  const agent = getAgent(row.id);
  const state = agent ? toPersistableState(agent) : persistedState(row);

  return {
    sessionId: row.id,
    title: row.title,
    state,
    isStreaming: agent?.state.isStreaming ?? false,
    usage: sessionUsage(state),
  };
}

function generateTitle(messages: Array<{ role?: string; content?: unknown }>) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) return "";

  const content = firstUserMessage.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((item): item is { type: "text"; text?: string } => item.type === "text")
            .map((item) => item.text || "")
            .join(" ")
        : "";

  const trimmed = text.trim();
  if (!trimmed) return "";

  const sentenceEnd = trimmed.search(/[.!?]/);
  if (sentenceEnd > 0 && sentenceEnd <= 50) {
    return trimmed.substring(0, sentenceEnd + 1);
  }

  return trimmed.length <= 50 ? trimmed : `${trimmed.substring(0, 47)}...`;
}

function shouldSaveSession(messages: Array<{ role?: string }>) {
  const hasUserMessage = messages.some((message) => message.role === "user");
  const hasAssistantMessage = messages.some((message) => message.role === "assistant");

  return hasUserMessage && hasAssistantMessage;
}

export async function persistAgentSession(sessionId: string, title: string, state: PersistableAgentState) {
  const now = new Date();

  await db
    .update(agentSessions)
    .set({
      title,
      state,
      updatedAt: now,
    })
    .where(eq(agentSessions.id, sessionId));

  return findSession(sessionId);
}

export async function persistPromptResult(row: AgentSessionRow) {
  const agent = getAgent(row.id);
  if (!agent) return row;

  const state = toPersistableState(agent);
  const messages = state.messages as Array<{ role?: string; content?: unknown }>;
  const title = row.title || (shouldSaveSession(messages) ? generateTitle(messages) : "");

  return (await persistAgentSession(row.id, title, state)) ?? row;
}
