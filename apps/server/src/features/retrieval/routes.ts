import { Elysia, t } from "elysia";

export const retrievalRoutes = new Elysia({ prefix: "/api/retrieval" }).post(
  "/resolve_paper_id",
  ({ body }) => {
    return {
      ok: true,
      result: [],
      args: body,
    };
  },
  {
    body: t.Object({
      paperName: t.String(),
      query: t.String(),
    }),
  },
);
