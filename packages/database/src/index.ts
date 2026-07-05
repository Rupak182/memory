import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import type { D1Database } from "@cloudflare/workers-types";

export * from "./schema";
export * from "./queries";
export * from "./vector";
export { eq, and, or, sql, inArray, desc, asc } from "drizzle-orm";

export const getDb = (binding: D1Database) => {
  return drizzle(binding, { schema });
};

export type DrizzleDb = ReturnType<typeof getDb>;
