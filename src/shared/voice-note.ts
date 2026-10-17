import type { Message } from '@ag-ui/core';

// Marks an owner message that started as a recorded voice note. Like the voice
// receipt marker it confers no trust or permissions and only affects rendering.
// It lives in the message ID, which every history path keeps.
export const voiceNoteMessagePrefix = 'opendots:voice_note:';
/** OpenAI's speech endpoint accepts at most 4,096 input characters. */
export const SPEECH_MAX_CHARS = 4096;

/** Reduces markdown to plain sentences so links, code and tables are not read aloud as symbols. */
export function speakableText(markdown: string): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= SPEECH_MAX_CHARS) return text;
  const cut = text.slice(0, SPEECH_MAX_CHARS - 1);
  const sentence = cut.lastIndexOf('. ');
  return `${sentence > SPEECH_MAX_CHARS / 2 ? cut.slice(0, sentence + 1) : cut}…`;
}

export function isVoiceNote(message: Pick<Message, 'id' | 'role'>): boolean {
  return (
    message.role === 'user' && message.id.startsWith(voiceNoteMessagePrefix)
  );
}

/** IDs of the last written assistant reply after each voice note. */
export function voiceNoteReplyIds(messages: Message[]): Set<string> {
  const ids = new Set<string>();
  let reply: string | undefined;
  let afterNote = false;
  for (const message of messages) {
    if (message.role === 'user') {
      if (reply) ids.add(reply);
      reply = undefined;
      afterNote = isVoiceNote(message);
    } else if (
      afterNote &&
      message.role === 'assistant' &&
      typeof message.content === 'string' &&
      message.content.trim()
    )
      reply = message.id;
  }
  if (reply) ids.add(reply);
  return ids;
}

/** The assistant text written after the latest voice note, if it was the last owner message. */
export function voiceNoteReply(messages: Message[]): Message | undefined {
  const lastUser = messages.findLastIndex((message) => message.role === 'user');
  if (lastUser < 0 || !isVoiceNote(messages[lastUser])) return undefined;
  return messages
    .slice(lastUser + 1)
    .findLast(
      (message) =>
        message.role === 'assistant' &&
        typeof message.content === 'string' &&
        !!message.content.trim(),
    );
}
