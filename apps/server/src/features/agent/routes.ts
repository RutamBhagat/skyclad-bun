import { Elysia, t } from "elysia";

import { agentEvalCases, runAgentEvalCase } from "./agent-evals";
import { encodeSse } from "./route-responses";
import {
  abortAgent,
  assertAllowedModel,
  createAgent,
  deleteAgent,
  getOrCreateAgent,
  streamPrompt,
  toPersistableState,
} from "./session-manager";
import {
  createSession,
  deleteSession,
  findSession,
  listSessionSummaries,
  persistedState,
  persistAgentSession,
  persistPromptResult,
  snapshot,
} from "./session-persistence";

export const agentRoutes = new Elysia({ prefix: "/api/agent" })
  .get("/evals", async () => {
    return { cases: agentEvalCases };
  })
  .post(
    "/evals/run",
    async ({ body, set }) => {
      const requestedCaseIds = body.caseIds ?? agentEvalCases.map((evalCase) => evalCase.id);
      const availableCaseIds = new Set(agentEvalCases.map((evalCase) => evalCase.id));
      const unknownCaseIds = requestedCaseIds.filter((caseId) => !availableCaseIds.has(caseId));

      if (unknownCaseIds.length > 0) {
        set.status = 400;
        return {
          error: "unknown_eval_case",
          unknownCaseIds,
          availableCaseIds: [...availableCaseIds],
        };
      }

      const selectedCases = agentEvalCases.filter((evalCase) => requestedCaseIds.includes(evalCase.id));
      const results = [];

      for (const evalCase of selectedCases) {
        results.push(await runAgentEvalCase(evalCase, body.includeEvents ?? false));
      }

      const passed = results.filter((result) => result.passed).length;

      return {
        total: results.length,
        passed,
        failed: results.length - passed,
        score: results.length === 0 ? 0 : passed / results.length,
        results,
      };
    },
    {
      body: t.Object({
        caseIds: t.Optional(t.Array(t.String())),
        includeEvents: t.Optional(t.Boolean()),
      }),
    },
  )
  .get("/sessions", async () => {
    return { sessions: await listSessionSummaries() };
  })
  .post("/sessions", async () => {
    const sessionId = crypto.randomUUID();
    const agent = createAgent(sessionId);
    const state = toPersistableState(agent);
    const row = await createSession(sessionId, state);
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
  .delete("/sessions/:sessionId", async ({ params, set }) => {
    const row = await findSession(params.sessionId);
    if (!row) {
      set.status = 404;
      return { error: "session_not_found" };
    }

    deleteAgent(params.sessionId);
    await deleteSession(params.sessionId);

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

      if (body.model) {
        assertAllowedModel(body.model);
        agent.state.model = body.model as any;
      }
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
