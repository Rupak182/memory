import { expect, test } from "bun:test";
import { getTestDb } from "./get-test-db";
import { users } from "../src/schema";
import { eq } from "drizzle-orm";

test("insert a user and fetch it", async () => {
  const db = getTestDb();

  // Clear existing users for a clean run
  await db.delete(users);

  const newUser = {
    id: "user_123",
    email: "test@example.com",
    createdAt: new Date(),
  };

  await db.insert(users).values(newUser);

  const [foundUser] = await db.select().from(users).where(eq(users.id, "user_123"));
  expect(foundUser?.email).toBe("test@example.com");
});
