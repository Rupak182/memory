import { Hono } from "hono";
import { getDb, users } from "@memory/database";
import { SHARED_VERSION } from "@memory/shared";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/", (c) => {
  return c.text(`Hello Hono! Shared Version: ${SHARED_VERSION}`);
});

app.get("/db-test", async (c) => {
  try {
    const db = getDb(c.env.DB);
    const allUsers = await db.select({ id: users.id }).from(users).limit(10);
    return c.json({ status: "success", version: SHARED_VERSION, users: allUsers });
  } catch (error) {
    const err = error as Error;
    return c.json({ status: "error", message: "Failed to query database", error: err.message }, 500);
  }
});

export default app;
