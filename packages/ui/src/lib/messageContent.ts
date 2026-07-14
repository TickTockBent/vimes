// `message` event payload content (packages/core/src/events.ts
// messagePayloadSchema) is loose by design (rule 0.6): a string, or an array
// of content blocks of unspecified shape. Only {type:'text', text} blocks are
// rendered; anything else (tool_use, thinking, images, a future block type)
// is silently ignored rather than guessed at — render only what is
// structurally known (rule 0.8's posture extended to the client).
export function extractTextBlocks(content: unknown): string[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [content] : [];
  }
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (
        block !== null &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'text' &&
        typeof (block as Record<string, unknown>).text === 'string'
      ) {
        texts.push((block as Record<string, unknown>).text as string);
      }
    }
    return texts;
  }
  return [];
}
