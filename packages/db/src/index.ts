import { env } from "@skyclad-bun/env/server";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "./schema";

export function createDb() {
  return drizzle(env.DATABASE_URL, { schema });
}

export const db = createDb();
export { sql, and, eq, asc, isNotNull, cosineDistance, desc } from "drizzle-orm";
