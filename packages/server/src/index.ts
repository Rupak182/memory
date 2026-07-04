import { Hono } from "hono";
import { getDb, users } from "@memory/database";
import { SHARED_VERSION } from "@memory/shared";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/", (c) => {
  return c.text(`Hello Hono! Shared Version: ${SHARED_VERSION}`);
});

app.get("/db-test", async (c) => {
  const db = getDb(c.env.DB);
  const allUsers = await db.select().from(users);
  return c.json({ status: "success", version: SHARED_VERSION, users: allUsers });
});

export default app;
