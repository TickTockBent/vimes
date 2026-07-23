<script setup lang="ts">
// Renders one assistant text block's markdown. ASSISTANT ONLY — StreamView
// decides at the call site (roleOf(event)) and keeps user messages literal;
// this component has no opinion about role, it only renders what it's given.
//
// No raw-HTML-binding directive anywhere: parseMarkdown returns a structure,
// and every leaf below is a real Vue element/text node — escaping is Vue's,
// structurally.
import { computed } from 'vue';
import { parseMarkdown, type MarkdownBlock } from '../lib/markdown.js';
import MarkdownInlineNode from './MarkdownInlineNode.vue';

const props = defineProps<{ text: string; cwd: string }>();

// PARSED IN A MEMOIZED computed, never inline in the template: a template
// expression re-runs on every render, and the stream re-renders constantly.
// This lives in its own component instance — one per rendered text block,
// keyed by StreamView's `${eventId}-${blockIndex}` — so the computed is
// cached per instance and only re-evaluates if `text` itself changes, which
// for an already-landed historical event never happens again after the first
// render.
const blocks = computed<MarkdownBlock[]>(() => parseMarkdown(props.text));

// Heading levels render at three visual sizes rather than six near-identical
// ones — the grammar still tracks all six levels faithfully (level is
// preserved on the block), this is presentation only.
function headingSizeClass(level: 1 | 2 | 3 | 4 | 5 | 6): string {
  if (level <= 2) {
    return 'text-base';
  }
  if (level <= 4) {
    return 'text-sm';
  }
  return 'text-sm italic';
}
</script>

<template>
  <div class="markdown-message min-w-0 space-y-1">
    <template v-for="(block, blockIndex) in blocks" :key="blockIndex">
      <component
        :is="`h${block.level}`"
        v-if="block.kind === 'heading'"
        class="font-bold"
        :class="headingSizeClass(block.level)"
      >
        <MarkdownInlineNode v-for="(node, nodeIndex) in block.inlines" :key="nodeIndex" :node="node" :cwd="cwd" />
      </component>

      <!-- Fence contents are opaque (never inline-parsed) — plain monospace
           text, its own horizontal scroll so a long line scrolls INSIDE the
           block rather than widening the page on a phone. -->
      <pre
        v-else-if="block.kind === 'codeBlock'"
        class="overflow-x-auto rounded-md bg-slate-900 p-2 font-mono text-xs text-slate-100 dark:bg-black"
      ><code>{{ block.code }}</code></pre>

      <ul v-else-if="block.kind === 'list' && !block.ordered" class="list-disc space-y-0.5 pl-5">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex">
          <MarkdownInlineNode v-for="(node, nodeIndex) in item.inlines" :key="nodeIndex" :node="node" :cwd="cwd" />
        </li>
      </ul>

      <ol v-else-if="block.kind === 'list' && block.ordered" class="list-decimal space-y-0.5 pl-5">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex">
          <MarkdownInlineNode v-for="(node, nodeIndex) in item.inlines" :key="nodeIndex" :node="node" :cwd="cwd" />
        </li>
      </ol>

      <hr v-else-if="block.kind === 'rule'" class="border-slate-300 dark:border-slate-400/50" />

      <p v-else-if="block.kind === 'paragraph'" class="whitespace-pre-wrap">
        <MarkdownInlineNode v-for="(node, nodeIndex) in block.inlines" :key="nodeIndex" :node="node" :cwd="cwd" />
      </p>
    </template>
  </div>
</template>
