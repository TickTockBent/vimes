import { describe, expect, it } from 'vitest';
import { decideComposerEnter } from './composerKey.js';

describe('decideComposerEnter', () => {
  it('sends on a plain desktop Enter', () => {
    expect(decideComposerEnter({ shiftKey: false, isComposing: false, isDesktop: true })).toBe('send');
  });

  it('inserts a newline on desktop Shift+Enter (the explicit newline chord)', () => {
    expect(decideComposerEnter({ shiftKey: true, isComposing: false, isDesktop: true })).toBe('newline');
  });

  it('inserts a newline on desktop Enter while composing (IME candidate commit, not a send)', () => {
    expect(decideComposerEnter({ shiftKey: false, isComposing: true, isDesktop: true })).toBe('newline');
  });

  it('inserts a newline on a plain mobile Enter (no other newline key; send is the button)', () => {
    expect(decideComposerEnter({ shiftKey: false, isComposing: false, isDesktop: false })).toBe('newline');
  });

  it('inserts a newline on mobile Shift+Enter', () => {
    expect(decideComposerEnter({ shiftKey: true, isComposing: false, isDesktop: false })).toBe('newline');
  });

  it('composing takes precedence over everything, including desktop + no shift', () => {
    expect(decideComposerEnter({ shiftKey: false, isComposing: true, isDesktop: false })).toBe('newline');
    expect(decideComposerEnter({ shiftKey: true, isComposing: true, isDesktop: true })).toBe('newline');
  });
});
