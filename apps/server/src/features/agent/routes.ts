import { db, eq } from "@skyclad-bun/db";
import { agentSessions } from "@skyclad-bun/db/schema/index";
import { Elysia, t } from "elysia";

import {
  abortAgent,
  createAgent,
  getAgent,
  getOrCreateAgent,
  streamPrompt,
  toPersistableState,
  type PersistableAgentState,
} from "./session-manager";

function encodeSse(data: unknown) {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

type AgentSessionRow = typeof agentSessions.$inferSelect;

async function findSession(sessionId: string) {
  const rows = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);

  return rows[0];
}

function persistedState(row: AgentSessionRow) {
  return row.state as PersistableAgentState;
}

function snapshot(row: AgentSessionRow) {
  const agent = getAgent(row.id);

  return {
    sessionId: row.id,
    title: row.title,
    state: agent ? toPersistableState(agent) : persistedState(row),
    isStreaming: agent?.state.isStreaming ?? false,
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

async function persistAgentSession(sessionId: string, title: string, state: PersistableAgentState) {
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

async function persistPromptResult(row: AgentSessionRow) {
  const agent = getAgent(row.id);
  if (!agent) return row;

  const state = toPersistableState(agent);
  const messages = state.messages as Array<{ role?: string; content?: unknown }>;
  const title = row.title || (shouldSaveSession(messages) ? generateTitle(messages) : "");

  return (await persistAgentSession(row.id, title, state)) ?? row;
}

export const agentRoutes = new Elysia({ prefix: "/api/agent" })
  .post("/sessions", async () => {
    const sessionId = crypto.randomUUID();
    const now = new Date();
    const agent = createAgent(sessionId);
    const state = toPersistableState(agent);

    await db.insert(agentSessions).values({
      id: sessionId,
      title: "",
      state,
      createdAt: now,
      updatedAt: now,
    });

    const row = await findSession(sessionId);
    return snapshot(row!);
  })
  .get("/sessions/:sessionId", async ({ params, set }) => {
    const row = await findSession(params.sessionId);
    if (!row) {
      set.status = 404;
      return { error: "session_not_found" };
    }

    getOrCreateAgent(params.sessionId, persistedState(row));
    return snapshot(row);
  })
  .post(
    "/sessions/:sessionId/prompt",
    async ({ params, body, set }) => {
      const row = await findSession(params.sessionId);
      if (!row) {
        set.status = 404;
        return { error: "session_not_found" };
      }

      const agent = getOrCreateAgent(params.sessionId, persistedState(row));

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            await streamPrompt(agent, body.message as any, async (event) => {
              controller.enqueue(encodeSse(event));
            });

            const savedRow = await persistPromptResult(row);
            controller.enqueue(encodeSse({ type: "snapshot", snapshot: snapshot(savedRow) }));
            controller.enqueue(encodeSse({ type: "done" }));
          } catch (error) {
            controller.enqueue(
              encodeSse({
                type: "server_error",
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          } finally {
            controller.close();
          }
        },
      });

      set.headers["content-type"] = "text/event-stream; charset=utf-8";
      set.headers["cache-control"] = "no-cache, no-transform";
      set.headers.connection = "keep-alive";

      return stream;
    },
    {
      body: t.Object({
        message: t.Any(),
      }),
    },
  )
  .post("/sessions/:sessionId/abort", async ({ params, set }) => {
    const row = await findSession(params.sessionId);
    if (!row) {
      set.status = 404;
      return { error: "session_not_found" };
    }

    abortAgent(params.sessionId);
    return { ok: true };
  })
  .patch(
    "/sessions/:sessionId/title",
    async ({ params, body, set }) => {
      const row = await findSession(params.sessionId);
      if (!row) {
        set.status = 404;
        return { error: "session_not_found" };
      }

      const savedRow = await persistAgentSession(params.sessionId, body.title.trim(), persistedState(row));
      return snapshot(savedRow!);
    },
    {
      body: t.Object({
        title: t.String(),
      }),
    },
  )
  .patch(
    "/sessions/:sessionId/state",
    async ({ params, body, set }) => {
      const row = await findSession(params.sessionId);
      if (!row) {
        set.status = 404;
        return { error: "session_not_found" };
      }

      const agent = getOrCreateAgent(params.sessionId, persistedState(row));

      if (body.model) agent.state.model = body.model as any;
      if (body.thinkingLevel) agent.state.thinkingLevel = body.thinkingLevel as any;
      if (typeof body.systemPrompt === "string") {
        agent.state.systemPrompt = body.systemPrompt;
      }

      const savedRow = await persistAgentSession(
        params.sessionId,
        row.title,
        toPersistableState(agent),
      );

      return {
        ok: true,
        ...snapshot(savedRow!),
      };
    },
    {
      body: t.Object({
        model: t.Optional(t.Any()),
        thinkingLevel: t.Optional(t.String()),
        systemPrompt: t.Optional(t.String()),
      }),
    },
  );
