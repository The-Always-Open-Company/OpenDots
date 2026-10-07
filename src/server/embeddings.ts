import { z } from 'zod';
import { EMBEDDING_DIMENSIONS } from './postgres.js';

export type Embed = (
  texts: string[],
  signal?: AbortSignal,
) => Promise<number[][]>;

const BATCH = 64;
// About 8,000 tokens, the input limit of OpenAI embedding models.
const MAX_INPUT_CHARS = 24_000;

const response = z.object({
  data: z.array(
    z.object({ index: z.number(), embedding: z.array(z.number()) }),
  ),
});

export function openAiEmbeddings(config: {
  apiKey: string;
  baseUrl: string;
  model: string;
}): Embed {
  return async (texts, signal) => {
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += BATCH) {
      const batch = texts
        .slice(start, start + BATCH)
        .map((text) => text.slice(0, MAX_INPUT_CHARS) || ' ');
      const result = await fetch(
        `${config.baseUrl.replace(/\/$/, '')}/embeddings`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({ model: config.model, input: batch }),
          signal,
        },
      );
      if (!result.ok)
        throw new Error(
          `Embedding request failed with HTTP ${result.status}. Check OPENAI_API_KEY and EMBEDDING_MODEL.`,
        );
      const data = response.parse(await result.json()).data;
      for (const item of data.sort((a, b) => a.index - b.index)) {
        if (item.embedding.length !== EMBEDDING_DIMENSIONS)
          throw new Error(
            `EMBEDDING_MODEL must return ${EMBEDDING_DIMENSIONS}-dimension vectors; got ${item.embedding.length}.`,
          );
        vectors.push(item.embedding);
      }
    }
    if (vectors.length !== texts.length)
      throw new Error('Embedding response did not cover every input.');
    return vectors;
  };
}
