// @vitest-environment happy-dom
//
// THE FIRST COMPONENT-MOUNT TEST IN THIS REPO (S15·U5, 2026-08-14).
//
// It exists because S15-F5 was a bug no gate here COULD have caught: nothing in
// the suite mounted a `.vue`, so a missing `:key` on PanelHost's StreamView
// branch shipped and blanked every session opened into an already-occupied
// panel. `App.vue` keys PanelHosts by stack index and `openPanelFrom` replaces a
// slot's route in ONE update, so without a key on the view Vue patches the
// mounted StreamView in place with a swapped `appSessionId` — and `onMounted`,
// the only site of `store.subscribe` + `markSeen`, never runs again.
//
// WHAT THIS ASSERTS, DELIBERATELY: the REMOUNT CONTRACT, not StreamView's
// internals. StreamView is replaced by a recording stub, so the real store,
// the WebSocket, and the network are never reached — the reason `onMounted`
// matters is documented above, and re-asserting it here would just couple this
// test to whatever StreamView happens to do on mount today. What must not
// regress is structural and is exactly what the stub can see: session A's view
// is UNMOUNTED and a fresh one is mounted for B.
//
// The bug's signature is `['A']` — one mount, never a second. Sabotage-verified
// in both directions (drop the `:key` → `['A']`; restore → `['A','B']`).
//
// The `@vitest-environment happy-dom` pragma above is per-file on purpose: the
// rest of the suite is pure and headless, and a global DOM environment would tax
// all 3,461 of those tests to serve these two.
import { describe, expect, it } from 'vitest';
import { defineComponent, h, onMounted, onUnmounted } from 'vue';
import { mount } from '@vue/test-utils';
import PanelHost from './PanelHost.vue';
import type { Route } from '../lib/route.js';

// One entry per StreamView lifecycle event, in order — `mount:<id>` /
// `unmount:<id>`. A list rather than a counter so the ORDER and the IDENTITY are
// both assertable: "B mounted" and "A's panel was torn down first" are different
// claims and the bug only violates one of them.
const lifecycleLog: string[] = [];

// The stand-in for StreamView. It declares only `appSessionId` — the identity
// prop whose change is the whole question — and records its own mount/unmount.
// `name: 'StreamView'` is what `global.stubs` matches on.
const RecordingStreamView = defineComponent({
  name: 'StreamView',
  props: { appSessionId: { type: String, required: true } },
  setup(props) {
    onMounted(() => {
      lifecycleLog.push(`mount:${props.appSessionId}`);
    });
    onUnmounted(() => {
      lifecycleLog.push(`unmount:${props.appSessionId}`);
    });
    return () => h('div', { class: 'recording-stream-view' }, props.appSessionId);
  },
});

function streamRoute(appSessionId: string): Route {
  return { view: 'stream', appSessionId };
}

function mountPanel(route: Route) {
  lifecycleLog.length = 0;
  return mount(PanelHost, {
    props: { route, index: 1, focused: false, backKind: 'close' },
    global: { stubs: { StreamView: RecordingStreamView } },
  });
}

// The mounts alone, in order. Asserted separately from the unmounts on purpose:
// whether Vue tears the old child down BEFORE or AFTER it mounts the new one is
// its own patch-order detail (today: unmount first), and pinning that would make
// this test a tripwire for a Vue minor. The claim under test is "a second mount
// happened, for B" — that is what the fix buys and what the bug destroys.
function mountsOnly(): string[] {
  return lifecycleLog.filter((entry) => entry.startsWith('mount:'));
}

describe('PanelHost — the StreamView remount contract (S15-F5)', () => {
  it('remounts StreamView when the panel swaps to a different session', async () => {
    const wrapper = mountPanel(streamRoute('session-a'));
    expect(mountsOnly()).toEqual(['mount:session-a']);

    // The in-place route swap `openPanelFrom` performs: same panel, same stack
    // index, new session. Un-keyed, this is a prop patch and nothing remounts.
    await wrapper.setProps({ route: streamRoute('session-b') });

    // ⚠ The bug's exact signature is `['mount:session-a']` here — one mount, no
    // second one. Do not soften this to a length check.
    expect(mountsOnly()).toEqual(['mount:session-a', 'mount:session-b']);
    // A's instance is genuinely gone, not merely shadowed: this is what makes
    // the per-session state (scroll follow, seen-on-view, composer draft) reset.
    expect(lifecycleLog).toContain('unmount:session-a');
    expect(wrapper.get('.recording-stream-view').text()).toBe('session-b');

    wrapper.unmount();
  });

  it('does NOT remount when the same session is re-set (the key is the id, not the object)', async () => {
    const wrapper = mountPanel(streamRoute('session-a'));

    // A fresh route OBJECT for the SAME session — what a re-parse of an
    // unchanged hash produces. Keying on object identity would pass the test
    // above and churn a live panel here, so this pins the key to the id.
    await wrapper.setProps({ route: streamRoute('session-a') });

    expect(lifecycleLog).toEqual(['mount:session-a']);
    expect(wrapper.get('.recording-stream-view').text()).toBe('session-a');

    wrapper.unmount();
  });
});
