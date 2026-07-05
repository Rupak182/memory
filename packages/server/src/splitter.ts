export interface TextChunk {
  index: number;
  text: string;
}

export interface SplitterOptions {
  /** Target maximum characters per chunk (default: 1500) */
  chunkSize?: number;
  /** Overlap in characters between consecutive chunks (default: 200) */
  chunkOverlap?: number;
}

/**
 * Splits text into overlapping chunks using a recursive separator strategy.
 * Tries to split on paragraphs → sentences → words → characters to preserve
 * semantic coherence as much as possible.
 */
export function splitText(text: string, options: SplitterOptions = {}): TextChunk[] {
  const { chunkSize = 1500, chunkOverlap = 200 } = options;

  if (chunkSize <= 0) {
    throw new Error("chunkSize must be greater than 0");
  }
  if (chunkOverlap >= chunkSize) {
    throw new Error("chunkOverlap must be less than chunkSize");
  }

  const raw = recursiveSplit(text.trim(), chunkSize, ["\n\n", "\n", ". ", " ", ""]);
  return mergeChunks(raw, chunkSize, chunkOverlap).map((text, index) => ({ index, text }));
}

/**
 * Recursively tries separators from the list until chunks fit within chunkSize.
 */
function recursiveSplit(text: string, chunkSize: number, separators: string[]): string[] {
  if (text.length <= chunkSize) return [text];

  const [separator, ...remaining] = separators;

  // No more separators — hard-cut at chunkSize
  if (separator === undefined || separator === "") {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
  }

  const parts = text.split(separator).filter((p) => p.trim().length > 0);

  // Every part already fits — return as-is
  if (parts.every((p) => p.length <= chunkSize)) return parts;

  // Recursively split parts that are still too large
  const result: string[] = [];
  for (const part of parts) {
    if (part.length <= chunkSize) {
      result.push(part);
    } else {
      result.push(...recursiveSplit(part, chunkSize, remaining));
    }
  }
  return result;
}

/**
 * Merges small adjacent parts into chunks up to chunkSize,
 * with chunkOverlap carried over between consecutive chunks.
 */
function mergeChunks(parts: string[], chunkSize: number, chunkOverlap: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const part of parts) {
    if (currentLen + part.length > chunkSize && current.length > 0) {
      const chunkText = current.join(" ").trim();
      chunks.push(chunkText);

      // Slice the last chunkOverlap characters from the end of the text
      const rawOverlap = chunkOverlap > 0 ? chunkText.slice(-chunkOverlap) : "";

      // Find the first space to avoid cutting a word in half
      const spaceIdx = rawOverlap.indexOf(" ");
      const cleanOverlap = spaceIdx !== -1 ? rawOverlap.slice(spaceIdx + 1) : rawOverlap;

      if (cleanOverlap.trim().length > 0) {
        current = cleanOverlap.split(" ");
        currentLen = cleanOverlap.length + 1; // +1 to account for upcoming space separator
      } else {
        current = [];
        currentLen = 0;
      }
    }

    current.push(part);
    currentLen += part.length + 1;
  }

  if (current.length > 0) {
    chunks.push(current.join(" ").trim());
  }

  return chunks.filter((c) => c.length > 0);
}
