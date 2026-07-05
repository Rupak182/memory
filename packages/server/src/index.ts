import { Hono } from "hono";
import { getDb, users, getEmbedding, getEmbeddings, queryVector } from "@memory/database";
import { SHARED_VERSION } from "@memory/shared";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { extractFacts } from "./extractor";

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
    console.error("Failed to query database:", err);
    return c.json({ status: "error", message: "Failed to query database" }, 500);
  }
});

app.get("/test-vectorize", async (c) => {
  const ids: string[] = ["vec_k8s", "vec_nextjs", "vec_boston"];
  const index = c.env.CHUNKS_INDEX;

  try {
    const ai = c.env.AI;

    console.log("   [Step 1] Generating embeddings for three distinct topics...");
    const texts: string[] = [
      "Kubernetes is an open-source container orchestration system.",
      "Next.js is a React framework for building full-stack web applications.",
      "Boston is the capital and most populous city of Massachusetts."
    ];
    
    const embeddings = await getEmbeddings(ai, texts);
    const vectors = [];
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      const id = ids[i];
      const embedding = embeddings[i];
      if (!text || !id || !embedding) continue;
      
      vectors.push({
        id,
        values: embedding,
        metadata: { text }
      });
    }

    console.log("   [Step 2] Upserting vectors into CHUNKS_INDEX...");
    await index.upsert(vectors);

    console.log("   Waiting 12 seconds for Vectorize to index the vectors...");
    await new Promise((resolve) => setTimeout(resolve, 12000));

    console.log("   [Step 3] Querying the index with 'What is Kubernetes?'...");
    const queryEmbed = await getEmbedding(ai, "What is Kubernetes?");
    const matches = await queryVector(index, queryEmbed, 3);

    console.log("   [Step 4] Checking match relevance...");
    const bestMatch = matches[0];
    if (!bestMatch) {
      throw new Error("No matches returned from index");
    }

    console.log(`   Best match ID: ${bestMatch.id} (Score: ${bestMatch.score})`);

    if (bestMatch.id !== "vec_k8s") {
      throw new Error(`Expected vec_k8s to be the best match, but got ${bestMatch.id}`);
    }

    console.log("   Verification checks for Phase 3: SUCCESS ✅");
    return c.json({ status: "success", message: "Phase 3 verification passed!" });
  } catch (error) {
    const err = error as Error;
    console.error("Verification failed:", err);
    return c.json({ status: "error", message: "Verification failed" }, 500);
  } finally {
    console.log("   [Step 5] Cleaning up generated test vectors...");
    await index.deleteByIds(ids).catch((e) => {
      console.error("Cleanup failed:", e);
    });
  }
});

const TestExtractorRequestSchema = z.object({
  text: z.string().min(1, "text field is required in request body"),
  candidates: z.array(
    z.object({
      id: z.string(),
      memory: z.string(),
    })
  ).optional(),
});

app.post(
  "/test-extractor",
  zValidator("json", TestExtractorRequestSchema),
  async (c) => {
    try {
      const ai = c.env.AI;
      const body = c.req.valid("json");

      console.log("   [Step 1] Running fact extractor LLM...");
      const result = await extractFacts(ai, body.text, body.candidates || []);

      return c.json({ status: "success", result });
    } catch (error) {
      const err = error as Error;
      console.error("Extraction verification failed:", err);
      return c.json({ status: "error", message: "Extraction failed" }, 500);
    }
  }
);

export default app;


