import { Elysia, t } from "elysia";

import { queryPaperDocsMarkdown, resolvePaperIdMarkdown } from "./service";

const markdownContentType = "text/markdown; charset=utf-8";

export const retrievalRoutes = new Elysia({ prefix: "/api/retrieval" })
  .post(
    "/resolve_paper_id",
    async ({ body, set }) => {
      set.headers["content-type"] = markdownContentType;
      return resolvePaperIdMarkdown(body);
    },
    {
      body: t.Object({
        paperName: t.String(),
        query: t.String(),
      }),
    },
  )
  .post(
    "/query_paper_docs",
    async ({ body, set }) => {
      set.headers["content-type"] = markdownContentType;
      return queryPaperDocsMarkdown(body);
    },
    {
      body: t.Object({
        paperId: t.String(),
        query: t.String(),
        lexicalQuery: t.String(),
      }),
    },
  );
