import { z } from "zod";
import { createWorkersAI } from "workers-ai-provider";
import { generateText } from "ai";
import type { Ai } from "@cloudflare/workers-types";

export interface CandidateMemory {
  id: string;
  memory: string;
}

export const FactExtractionSchema = z.object({
  facts: z.array(
    z.object({
      fact: z.string().describe("The normalized, atomic fact extracted from the text."),
      type: z.enum(["new", "updates", "extends"]).describe("Whether this is a completely new fact, an update to an existing fact, or an extension/detail of an existing fact."),
      targetId: z.string().optional().describe("The ID of the candidate memory this fact updates or extends (must match one of the candidate IDs provided).")
    })
  )
});

export type ExtractedFacts = z.infer<typeof FactExtractionSchema>;

/**
 * Extracts atomic facts and classifies their relations against candidate memories.
 */
export async function extractFacts(
  ai: Ai,
  text: string,
  candidates: CandidateMemory[] = []
): Promise<ExtractedFacts> {
  const aiProvider = createWorkersAI({ binding: ai });
  const model = aiProvider("@cf/meta/llama-3.1-8b-instruct-fp8");

  const systemPrompt = `You are an AI assistant designed to extract atomic, semantic facts from text chunks and cross-reference them with a list of existing candidate memories.

Guidelines for fact extraction:
1. Extract facts as clear, concise, self-contained atomic statements (e.g., "User prefers React for web development", not "They prefer React").
2. Standardize and normalize facts (e.g., correct casing, remove conversational filler, normalize names).
3. If existing candidate memories are provided, cross-reference the extracted facts with them:
   - "updates": Use this if the new fact directly contradicts, replaces, or makes an existing memory obsolete (e.g., "User prefers Next.js" updates "User prefers React"). You MUST provide the targetId of the obsolete memory.
   - "extends": Use this if the new fact adds details, context, or additional info to an existing memory without contradicting it (e.g., "User prefers React because of hooks" extends "User prefers React"). You MUST provide the targetId of the extended memory.
   - "new": Use this if the fact is completely unrelated to any of the candidate memories. Do NOT specify a targetId.

Candidate Memories:
${candidates.length > 0 ? candidates.map((c) => `- [ID: ${c.id}] "${c.memory}"`).join("\n") : "No existing candidate memories found."}

Output format:
You must output a JSON object matching this schema:
{
  "facts": [
    {
      "fact": "string",
      "type": "new" | "updates" | "extends",
      "targetId": "string" // optional, only if type is updates or extends
    }
  ]
}

Return ONLY a valid JSON object matching the schema. Do not wrap it in markdown code fences or add explanations.`;

  const userPrompt = `Extract facts and relations from the following text chunk:
"""
${text}
"""`;

  try {
    const { text: rawText } = await generateText({
      model,
      system: systemPrompt,
      prompt: userPrompt,
    });
    
    let cleanText = rawText.trim();
    if (cleanText.startsWith("```")) {
      cleanText = cleanText.replace(/^```(?:json)?\n?/i, "");
      cleanText = cleanText.replace(/\n?```$/, "");
    }
    
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleanText.trim());
    } catch (parseErr) {
      // Fallback: extract the outermost JSON object if model returned conversational prose
      const start = cleanText.indexOf("{");
      const end = cleanText.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        try {
          parsed = JSON.parse(cleanText.slice(start, end + 1));
        } catch {
          throw parseErr; // Throw original parsing error if fallback parsing also fails
        }
      } else {
        throw parseErr;
      }
    }

    return sanitizeFacts(FactExtractionSchema.parse(parsed), candidates);
  } catch (error) {
    console.error("Failed to extract facts:", error);
    throw new Error(`Failed to extract facts: ${(error as Error).message}`, { cause: error });
  }
}

/**
 * Guards against model hallucination by validating each fact's targetId against
 * the supplied candidate ID set. Any fact whose targetId does not match a real
 * candidate is reclassified as "new" and its targetId is dropped.
 */
function sanitizeFacts(result: ExtractedFacts, candidates: CandidateMemory[]): ExtractedFacts {
  const validIds = new Set(candidates.map((c) => c.id));
  const facts = result.facts.map((fact) => {
    if (fact.type === "new") return fact;
    if (fact.targetId && validIds.has(fact.targetId)) return fact;
    console.warn(`extractFacts: invalid targetId found in fact – reclassifying as "new".`);
    return { fact: fact.fact, type: "new" as const };
  });
  return { facts };
}
