import { Elysia, t } from "elysia";

import { chatSessionHub } from "./session-hub";

export const chatRoutes = new Elysia({ prefix: "/api/chat" })
  .post(
    "/sessions",
    async ({ body }) => {
      return await chatSessionHub.createSession({ cwd: body.cwd });
    },
    {
      body: t.Object({
        cwd: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/sessions/:sessionId",
    ({ params, set }) => {
      try {
        return chatSessionHub.snapshotSession(params.sessionId);
      } catch (error) {
        set.status = 404;
        return {
          error: error instanceof Error ? error.message : "Session not found",
        };
      }
    },
  )
  .get(
    "/sessions/:sessionId/events",
    ({ params, set }) => {
      try {
        return chatSessionHub.createEventStream(params.sessionId);
      } catch (error) {
        set.status = 404;
        return {
          error: error instanceof Error ? error.message : "Session not found",
        };
      }
    },
  )
  .post(
    "/sessions/:sessionId/prompt",
    async ({ params, body, set }) => {
      try {
        return await chatSessionHub.prompt(params.sessionId, body.text);
      } catch (error) {
        set.status = 404;
        return {
          error: error instanceof Error ? error.message : "Session not found",
        };
      }
    },
    {
      body: t.Object({
        text: t.String(),
      }),
    },
  )
  .post(
    "/sessions/:sessionId/abort",
    async ({ params, set }) => {
      try {
        return await chatSessionHub.abort(params.sessionId);
      } catch (error) {
        set.status = 404;
        return {
          error: error instanceof Error ? error.message : "Session not found",
        };
      }
    },
  )
  .post(
    "/sessions/:sessionId/idle",
    async ({ params, set }) => {
      try {
        return await chatSessionHub.waitForIdle(params.sessionId);
      } catch (error) {
        set.status = 404;
        return {
          error: error instanceof Error ? error.message : "Session not found",
        };
      }
    },
  )
  .patch(
    "/sessions/:sessionId/title",
    async ({ params, body, set }) => {
      try {
        return await chatSessionHub.setTitle(params.sessionId, body.title);
      } catch (error) {
        set.status = 404;
        return {
          error: error instanceof Error ? error.message : "Session not found",
        };
      }
    },
    {
      body: t.Object({
        title: t.String(),
      }),
    },
  );
