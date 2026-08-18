// Ambient shim so plain `tsc -b` at the repo root (which does not understand
// .vue SFCs) can still typecheck the .ts files that import them — real .vue
// type-checking happens via `vue-tsc` in this package's own build/typecheck
// script (docs/slice-1.md step-3 note; root tsc -b may exclude .vue).
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
