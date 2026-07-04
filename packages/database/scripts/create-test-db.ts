import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

const createTestDb = async () => {
  const testDb = Bun.file("test.sqlite");
  if (await testDb.exists()) {
    await testDb.delete();
  }
  const sqlite = new Database("test.sqlite");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "./src/migrations" });
  console.log("Test database created and migrated");
};

createTestDb();
