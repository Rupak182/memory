import type { Ai, Vectorize, VectorizeIndex, VectorizeVectorMetadata } from "@cloudflare/workers-types";

export type VectorizeDB = VectorizeIndex | Vectorize;

/**
 * Generate a single embedding using @cf/baai/bge-small-en-v1.5
 */
export async function getEmbedding(ai: Ai, text: string): Promise<number[]> {
  const result = (await ai.run("@cf/baai/bge-small-en-v1.5", {
    text: [text],
  })) as { data: number[][] };
  if (!result || !result.data || result.data.length === 0) {
    throw new Error("Failed to generate embedding: empty response from Workers AI");
  }
  const val = result.data[0];
  if (!val) {
    throw new Error("Failed to generate embedding: empty response array from Workers AI");
  }
  return val;
}

/**
 * Generate multiple embeddings using @cf/baai/bge-small-en-v1.5
 * Uses batch chunking to avoid Workers AI input size/token limits.
 */
export async function getEmbeddings(ai: Ai, texts: string[], batchSize: number = 32): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (batchSize <= 0) {
    throw new Error("batchSize must be greater than 0");
  }
  
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const chunk = texts.slice(i, i + batchSize);
    const result = (await ai.run("@cf/baai/bge-small-en-v1.5", {
      text: chunk,
    })) as { data: number[][] };
    
    if (!result || !result.data) {
      throw new Error(`Failed to generate embeddings: empty response from Workers AI at batch index ${i}`);
    }
    if (result.data.length !== chunk.length) {
      throw new Error(`Embedding count mismatch at batch index ${i}: expected ${chunk.length}, got ${result.data.length}`);
    }
    results.push(...result.data);
  }
  
  return results;
}

/**
 * Upsert a single vector into a Vectorize index
 */
export async function upsertVector(
  index: VectorizeDB,
  id: string,
  values: number[],
  metadata?: Record<string, VectorizeVectorMetadata>
): Promise<void> {
  await index.upsert([
    {
      id,
      values,
      metadata,
    },
  ]);
}

/**
 * Upsert multiple vectors into a Vectorize index
 * Uses chunking to stay well below Vectorize's 5,000 vector limit per request.
 */
export async function upsertVectors(
  index: VectorizeDB,
  vectors: { id: string; values: number[]; metadata?: Record<string, VectorizeVectorMetadata> }[],
  batchSize: number = 1000
): Promise<void> {
  if (vectors.length === 0) return;
  if (batchSize <= 0) {
    throw new Error("batchSize must be greater than 0");
  }
  for (let i = 0; i < vectors.length; i += batchSize) {
    const chunk = vectors.slice(i, i + batchSize);
    await index.upsert(chunk);
  }
}

/**
 * Delete a single vector by ID from a Vectorize index
 */
export async function deleteVector(index: VectorizeDB, id: string): Promise<void> {
  await index.deleteByIds([id]);
}

/**
 * Delete multiple vectors by ID from a Vectorize index
 */
export async function deleteVectors(index: VectorizeDB, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await index.deleteByIds(ids);
}

/**
 * Query a Vectorize index using a vector
 */
export async function queryVector(
  index: VectorizeDB,
  vector: number[],
  topK: number = 5
): Promise<{ id: string; score: number; metadata?: Record<string, VectorizeVectorMetadata> }[]> {
  const result = await index.query(vector, {
    topK,
    returnMetadata: "all",
  });
  
  return result.matches.map((match) => ({
    id: match.id,
    score: match.score,
    metadata: match.metadata as Record<string, VectorizeVectorMetadata> | undefined,
  }));
}
