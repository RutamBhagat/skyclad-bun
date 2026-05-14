import { cors } from "@elysiajs/cors";
import { env } from "@skyclad-bun/env/server";
import { Elysia } from "elysia";
import { logger } from "@bogeychan/elysia-logger";

import { chatRoutes } from "./features/chat/routes";
import { ingestRoutes } from "./features/ingest/routes";
import { retrievalRoutes } from "./features/retrieval/routes";

new Elysia()
  .use(logger())
  .use(
    cors({
      origin: env.CORS_ORIGIN,
      methods: ["GET", "POST", "OPTIONS"],
    }),
  )
  .get("/", () => "OK")
  .use(chatRoutes)
  .use(ingestRoutes)
  .use(retrievalRoutes)
  .listen(3000, () => {
    console.log("Server is running on http://localhost:3000");
  });
