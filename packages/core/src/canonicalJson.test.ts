import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonicalJson.js';

describe('canonicalJson', () => {
  it('sorts object keys deeply', () => {
    const value = { b: 1, a: { d: 4, c: 3 }, e: [{ z: 26, y: 25 }] };
    expect(canonicalJson(value)).toBe('{"a":{"c":3,"d":4},"b":1,"e":[{"y":25,"z":26}]}');
  });

  it('keeps array element order stable (arrays are not sorted)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson(['banana', 'apple', 'cherry'])).toBe('["banana","apple","cherry"]');
  });

  it('emits no whitespace', () => {
    const serialized = canonicalJson({ a: 1, b: [1, 2] });
    expect(serialized).not.toMatch(/\s/);
  });

  it('is byte-identical across two construction orders of the same object', () => {
    const firstConstructionOrder = { alpha: 1, beta: { gamma: 2, delta: 3 }, epsilon: [9, 8, 7] };
    const secondConstructionOrder: Record<string, unknown> = {};
    secondConstructionOrder.epsilon = [9, 8, 7];
    secondConstructionOrder.beta = {};
    (secondConstructionOrder.beta as Record<string, unknown>).delta = 3;
    (secondConstructionOrder.beta as Record<string, unknown>).gamma = 2;
    secondConstructionOrder.alpha = 1;

    expect(canonicalJson(firstConstructionOrder)).toBe(canonicalJson(secondConstructionOrder));
  });

  it('handles primitives and null with JSON.stringify semantics', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('text')).toBe('"text"');
    expect(canonicalJson(true)).toBe('true');
  });
});
