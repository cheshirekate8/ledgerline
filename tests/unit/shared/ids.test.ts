import { RandomIdGenerator, SeededIdGenerator } from '../../../src/shared/ids';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('SeededIdGenerator', () => {
  it('produces the same sequence for the same seed', () => {
    const a = new SeededIdGenerator(7);
    const b = new SeededIdGenerator(7);
    const first = [a.next(), a.next(), a.next()];
    expect([b.next(), b.next(), b.next()]).toEqual(first);
  });

  it('produces different sequences for different seeds', () => {
    expect(new SeededIdGenerator(1).next()).not.toBe(new SeededIdGenerator(2).next());
  });

  it('produces UUID v4 shaped, unique identifiers', () => {
    const ids = new SeededIdGenerator(99);
    const seen = new Set<string>();
    for (let i = 0; i < 1_000; i += 1) {
      const id = ids.next();
      expect(id).toMatch(UUID_V4);
      seen.add(id);
    }
    expect(seen.size).toBe(1_000);
  });

  it('pins the sequence for seed 42 so it cannot drift between releases', () => {
    const ids = new SeededIdGenerator(42);
    expect(ids.next()).toBe('99e1ef7c-72c3-4b8a-9a3b-32c0ab73b0ad');
    expect(ids.next()).toBe('2cc09a8a-86ce-44d3-85f2-45149fef4401');
  });

  it('rejects non-integer seeds', () => {
    expect(() => new SeededIdGenerator(1.5)).toThrow(RangeError);
  });
});

describe('RandomIdGenerator', () => {
  it('produces UUIDs', () => {
    const ids = new RandomIdGenerator();
    expect(ids.next()).toMatch(UUID_V4);
    expect(ids.next()).not.toBe(ids.next());
  });
});
