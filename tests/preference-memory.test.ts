import { describe, expect, it } from 'vitest';
import {
  PREFERENCE_MEMORY_INSTRUCTIONS,
  memoriesToStore,
  parsePreferenceMemories,
  preferenceExtractionUser,
  shouldLearnFromMessage,
} from '../src/server/preference-memory.js';

describe('preference memories', () => {
  it('keeps unique preferences and drops blanks', () => {
    expect(
      parsePreferenceMemories({
        memories: ['Prefers short answers.', ' prefers short answers ', ''],
      }),
    ).toEqual(['Prefers short answers.']);
  });

  it('asks only for who they are, communication, and working style', () => {
    expect(PREFERENCE_MEMORY_INSTRUCTIONS).toContain('who they are');
    expect(PREFERENCE_MEMORY_INSTRUCTIONS).toContain('communicate');
    expect(PREFERENCE_MEMORY_INSTRUCTIONS).toContain('how they like to work');
    expect(PREFERENCE_MEMORY_INSTRUCTIONS).toContain('question or task');
    expect(
      preferenceExtractionUser([
        { role: 'user', content: 'I prefer short answers' },
      ]),
    ).toContain('user: I prefer short answers');
  });

  it('stores an explicit memory as written and a learned turn only after extraction', async () => {
    const turns = [
      { role: 'user' as const, content: 'What is the weather?' },
      { role: 'assistant' as const, content: 'I can check.' },
    ];
    expect(await memoriesToStore(turns, false, async () => [])).toEqual(turns);
    expect(
      await memoriesToStore(turns, true, async () => ['Prefers short answers']),
    ).toEqual([{ role: 'user', content: 'Prefers short answers' }]);
  });

  it('skips schedule prompts and call receipts', () => {
    expect(
      shouldLearnFromMessage({
        role: 'user',
        id: 'opendots-work:1',
        metadata: { opendotsSource: 'work' },
      }),
    ).toBe(false);
    expect(
      shouldLearnFromMessage({
        role: 'user',
        id: 'note',
        metadata: { opendotsSource: 'voice_receipt' },
      }),
    ).toBe(false);
    expect(
      shouldLearnFromMessage({ role: 'user', id: 'plain' }),
    ).toBe(true);
  });
});
