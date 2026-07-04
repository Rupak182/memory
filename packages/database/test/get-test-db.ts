import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../src/schema";

export const getTestDb = () => {
  const sqlite = new Database("test.sqlite");
  sqlite.run("PRAGMA foreign_keys = ON;");
  return drizzle(sqlite, { schema });
};

