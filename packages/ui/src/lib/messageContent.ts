// `message` event payload content (packages/core/src/events.ts
// messagePayloadSchema) is loose by design (rule 0.6): a string, or an array
// of content blocks of unspecified shape. Blocks are classified into a small
// set of renderable kinds; anything unrecognized — or a recognized type
// missing the field it needs to render — is silently ignored rather than
// guessed at (rule 0.8's posture extended to the client).
//
// Observed shapes (rule 0.7, live event log): assistant-role blocks are
// {type:'text', text}, {type:'thinking', thinking}, or {type:'tool_use',
// name, input}; user-role blocks (tool results relayed back to the model)
// are {type:'tool_result', content} — content itself either a plain string
// or a nested array of blocks — plus plain {type:'text', text} blocks.

const TOOL_INPUT_PREVIEW_LENGTH = 80;
const TOOL_RESULT_PREVIEW_LENGTH = 120;

export type ContentBlockView =
  | { kind: 'text'; text: string }
  | { kind: 'thinking' }
  | { kind: 'tool'; name: string; inputPreview: string }
  | { kind: 'toolResult'; preview: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

// tool_result content is itself either a plain string or a nested array of
// blocks (typically {type:'text', text}); flatten whatever text is found
// into one line. Anything structurally unrecognized contributes nothing
// rather than being stringified/guessed at.
function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (isRecord(block) && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join(' ');
  }
  return '';
}

export function extractContentBlocks(content: unknown): ContentBlockView[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ kind: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: ContentBlockView[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') {
          blocks.push({ kind: 'text', text: block.text });
        }
        break;
      case 'thinking':
        blocks.push({ kind: 'thinking' });
        break;
      case 'tool_use':
        if (typeof block.name === 'string') {
          blocks.push({
            kind: 'tool',
            name: block.name,
            inputPreview: truncate(JSON.stringify(block.input ?? {}), TOOL_INPUT_PREVIEW_LENGTH),
          });
        }
        break;
      case 'tool_result':
        blocks.push({
          kind: 'toolResult',
          preview: truncate(flattenToolResultContent(block.content), TOOL_RESULT_PREVIEW_LENGTH),
        });
        break;
      default:
        break;
    }
  }
  return blocks;
}
