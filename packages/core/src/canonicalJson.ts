// THE serializer for every byte-compare in the project (rule 0.3 determinism
// contract). Object keys are sorted deeply; arrays keep their order; all other
// values follow plain JSON.stringify semantics; no whitespace is emitted.
//
// Consequences of "JSON.stringify semantics otherwise": `undefined`, functions,
// and symbols are dropped from objects and become `null` inside arrays; `bigint`
// throws; `NaN`/`Infinity` serialize to `null`. Callers that need those cases
// stable must normalize before serializing (the event spine normalizes an
// absent payload to `null` upstream).

function sortObjectKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const sourceObject = value as Record<string, unknown>;
    const sortedEntries = Object.keys(sourceObject)
      .sort()
      .map((key) => [key, sortObjectKeysDeep(sourceObject[key])] as const);
    return Object.fromEntries(sortedEntries);
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortObjectKeysDeep(value));
}
