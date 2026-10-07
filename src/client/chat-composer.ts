/** Names attached library documents so the Dot can search or read them by ID. */
export function attachedDocuments(
  text: string,
  documents: { id: string; title: string }[],
) {
  if (!documents.length) return text;
  const list = documents
    .map(
      (document) =>
        `“${document.title.replace(/[\r\n]+/g, ' ')}” (id ${document.id})`,
    )
    .join(', ');
  return `${text}\n\nAttached documents: ${list}. Use search_documents or read_document with these IDs.`;
}

export function shouldSubmitComposerOnKeyDown(event: {
  key: string;
  shiftKey: boolean;
  nativeEvent: {
    isComposing?: boolean;
    keyCode?: number;
  };
}) {
  return (
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.nativeEvent.isComposing &&
    event.nativeEvent.keyCode !== 229
  );
}
