import { expect, it } from 'vitest';
import {
  attachedDocuments,
  shouldSubmitComposerOnKeyDown,
} from '../src/client/chat-composer';

function keyEvent({
  key = 'Enter',
  shiftKey = false,
  isComposing = false,
  keyCode,
}: {
  key?: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
} = {}) {
  return {
    key,
    shiftKey,
    nativeEvent: {
      isComposing,
      keyCode,
    },
  };
}

it('does not submit Enter while IME composition is active', () => {
  expect(shouldSubmitComposerOnKeyDown(keyEvent({ isComposing: true }))).toBe(
    false,
  );
});

it('does not submit legacy IME composition Enter events', () => {
  expect(shouldSubmitComposerOnKeyDown(keyEvent({ keyCode: 229 }))).toBe(false);
});

it('submits Enter after composition completes', () => {
  expect(shouldSubmitComposerOnKeyDown(keyEvent())).toBe(true);
});

it('keeps Shift+Enter available for multiline drafts', () => {
  expect(shouldSubmitComposerOnKeyDown(keyEvent({ shiftKey: true }))).toBe(
    false,
  );
});

it('names attached documents by title and ID on one line', () => {
  expect(attachedDocuments('Summarize this', [])).toBe('Summarize this');
  expect(
    attachedDocuments('Summarize this', [
      { id: 'doc-1', title: 'Q3\nReport' },
      { id: 'doc-2', title: 'Notes' },
    ]),
  ).toBe(
    'Summarize this\n\nAttached documents: “Q3 Report” (id doc-1), “Notes” (id doc-2). Use search_documents or read_document with these IDs.',
  );
});
