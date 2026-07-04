import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "../src/schema";

// AnyDb from queries.ts requires "async" mode, but Bun SQLite is a sync driver.
// In practice Drizzle's async transaction callback still works correctly on Bun
// because Bun awaits the returned Promise from the callback regardless. We cast
// here so test files remain compatible without loosening production type safety.
type AnyDb = BaseSQLiteDatabase<"async", unknown, typeof schema>;

export const getTestDb = () => {
  const sqlite = new Database("test.sqlite");
  sqlite.run("PRAGMA foreign_keys = ON;");
  return drizzle(sqlite, { schema }) as unknown as AnyDb;
};

