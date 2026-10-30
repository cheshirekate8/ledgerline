import { deepClone, deepFreeze, fingerprint, stableStringify } from '../../../src/shared/stable-json';

describe('stableStringify', () => {
  it('serializes objects independent of key order', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('drops undefined properties', () => {
    expect(stableStringify({ a: undefined, b: 2 })).toBe('{"b":2}');
  });
});

describe('fingerprint', () => {
  it('is equal for equal values and different otherwise', () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});

describe('deepFreeze', () => {
  it('freezes nested objects and arrays', () => {
    const value = deepFreeze({ nested: { list: [{ x: 1 }] } });
    expect(Object.isFrozen(value.nested)).toBe(true);
    expect(Object.isFrozen(value.nested.list)).toBe(true);
    expect(Object.isFrozen(value.nested.list[0])).toBe(true);
  });
});

describe('deepClone', () => {
  it('produces an independent, mutable copy', () => {
    const original = deepFreeze({ nested: { count: 1 } });
    const copy = deepClone(original);
    copy.nested.count = 2;
    expect(original.nested.count).toBe(1);
  });
});
