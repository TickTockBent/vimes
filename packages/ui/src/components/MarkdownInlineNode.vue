<script setup lang="ts">
// One MarkdownInline node — recurses into itself for strong/em/link children
// (Vue 3.2+ `<script setup>` SFCs can reference themselves by filename with no
// explicit import, which is what makes the recursion below work).
//
// No raw-HTML-binding directive anywhere: every leaf renders through a real
// Vue text node ({{ }} interpolation), so escaping is Vue's, structurally,
// not a sanitizer we have to keep correct forever.
import { computed } from 'vue';
import { resolvePathAgainstCwd, type MarkdownInline } from '../lib/markdown.js';

// `cwd` is threaded through every level of recursion (not just the top) since
// a `path` code span can legally appear nested inside `**strong**`/`*em*`
// (e.g. "**see `a.ts:5`**") — scope F3 needs the session cwd wherever a
// `path` leaf actually renders.
const props = defineProps<{ node: MarkdownInline; cwd: string }>();

// F3/F4: builds the `#/files?path=&line=` URL App.vue:49 already routes to
// the editor — no new route added. `encodeURIComponent` on both params so a
// path containing spaces/#/?/& can't corrupt the query string (assertion 14).
// Deliberately NO existence check (F4): a path the agent invented becomes a
// link that opens the editor and reports not-found, which is an honest
// outcome — this stays a plain synchronous string build.
const pathHref = computed<string | null>(() => {
  if (props.node.kind !== 'path') {
    return null;
  }
  const resolved = resolvePathAgainstCwd(props.cwd, props.node.path);
  const pathParam = `path=${encodeURIComponent(resolved)}`;
  const lineParam = props.node.line !== null ? `&line=${encodeURIComponent(String(props.node.line))}` : '';
  return `#/files?${pathParam}${lineParam}`;
});
</script>

<template>
  <template v-if="node.kind === 'text'">{{ node.text }}</template>

  <strong v-else-if="node.kind === 'strong'">
    <MarkdownInlineNode v-for="(child, childIndex) in node.children" :key="childIndex" :node="child" :cwd="cwd" />
  </strong>

  <em v-else-if="node.kind === 'em'">
    <MarkdownInlineNode v-for="(child, childIndex) in node.children" :key="childIndex" :node="child" :cwd="cwd" />
  </em>

  <code
    v-else-if="node.kind === 'code'"
    class="rounded bg-slate-200 px-1 py-0.5 font-mono text-[0.85em] break-all dark:bg-slate-700"
  >{{ node.text }}</code>

  <!-- B3: `node.href` reached this component only because markdown.ts already
       ran it through the scheme allow-list — nothing re-validates it here,
       the parser is the one place that decision is made. -->
  <a
    v-else-if="node.kind === 'link'"
    :href="node.href"
    target="_blank"
    rel="noopener noreferrer"
    class="underline decoration-dotted"
  >
    <MarkdownInlineNode v-for="(child, childIndex) in node.children" :key="childIndex" :node="child" :cwd="cwd" />
  </a>

  <!-- Scope F: a code span shaped like a file path opens the VIMES editor in
       a new tab, at the right line if one was parsed. -->
  <a
    v-else-if="node.kind === 'path' && pathHref !== null"
    :href="pathHref"
    target="_blank"
    rel="noopener noreferrer"
    class="rounded bg-slate-200 px-1 py-0.5 font-mono text-[0.85em] break-all underline decoration-dotted dark:bg-slate-700"
  >{{ node.raw }}</a>
</template>
