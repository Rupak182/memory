import { expect, test } from "bun:test";
import { getTestDb } from "./get-test-db";
import { users } from "../src/schema";
import { eq } from "drizzle-orm";

test("insert a user and fetch it", async () => {
  const db = getTestDb();

  console.log("   --- Starting Users Table Test ---");

  // Clear existing users for a clean run
  console.log("   [1/3] Clearing users from previous runs...");
  await db.delete(users);

  const newUser = {
    id: "user_123",
    email: "test@example.com",
    createdAt: new Date(),
  };

  console.log("   [2/3] Inserting new user...");
  await db.insert(users).values(newUser);

  console.log("   [3/3] Querying inserted user and verifying attributes...");
  const [foundUser] = await db.select().from(users).where(eq(users.id, "user_123"));
  expect(foundUser?.email).toBe("test@example.com");

  console.log("   --- Users Table Test: SUCCESS ---");
});
