import { z } from 'zod';
import { workPromptKind } from '../shared/work-marker.js';
import type { MemoryTurn } from './memory.js';

export const PREFERENCE_MEMORY_INSTRUCTIONS = `Extract durable preferences about the person, not a record of the conversation.
Keep a memory only when they state something that should shape later conversations:
- who they are, such as name, pronouns, timezone, language, or the place they treat as home
- how they want to communicate, such as tone, length, formality, or format
- how they like to work, such as planning style, tools, review habits, decision style, or a standing constraint
Do not keep the question or task they asked, topics that matter only for this conversation, the assistant's answer, schedules, document contents, secrets, or credentials.
Write each kept memory as a short preference. Answer with a JSON object {"memories":["..."]}, and {"memories":[]} when the turn has none.`;

const extracted = z.object({
  memories: z.array(z.unknown()).max(8),
});

export function preferenceKey(text: string) {
  return text.trim().toLowerCase().replace(/[.]+$/u, '');
}

export function parsePreferenceMemories(value: unknown): string[] {
  const parsed = extracted.safeParse(value);
  if (!parsed.success) return [];
  const seen = new Set<string>();
  const memories: string[] = [];
  for (const item of parsed.data.memories) {
    if (typeof item !== 'string') continue;
    const memory = item.trim();
    if (!memory || memory.length > 240) continue;
    const key = preferenceKey(memory);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    memories.push(memory);
  }
  return memories;
}

export function preferenceExtractionUser(turns: MemoryTurn[]) {
  return turns
    .map((turn) => `${turn.role}: ${turn.content.trim()}`)
    .join('\n')
    .slice(0, 8000);
}

/** Scheduled prompts and call receipts are not preferences. */
export function shouldLearnFromMessage(message: {
  role: string;
  id: string;
  metadata?: unknown;
}) {
  if (message.role !== 'user') return false;
  if (workPromptKind(message)) return false;
  const metadata = message.metadata;
  const source =
    metadata && typeof metadata === 'object' && 'opendotsSource' in metadata
      ? (metadata as { opendotsSource?: unknown }).opendotsSource
      : undefined;
  return source !== 'voice_receipt';
}

export async function memoriesToStore(
  turns: MemoryTurn[],
  infer: boolean,
  extract: (turns: MemoryTurn[]) => Promise<string[]>,
): Promise<MemoryTurn[]> {
  const usable = turns.filter((turn) => turn.content.trim());
  if (!usable.length) return [];
  if (!infer) return usable;
  return (await extract(usable)).map((content) => ({
    role: 'user' as const,
    content,
  }));
}
