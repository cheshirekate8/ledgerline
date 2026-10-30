import { FixedClock, SystemClock, toEpochMillis, toIsoString } from '../../../src/shared/clock';

describe('FixedClock', () => {
  it('reports the time it was created with until moved', () => {
    const clock = new FixedClock('2026-03-01T12:00:00.000Z');
    expect(toIsoString(clock.now())).toBe('2026-03-01T12:00:00.000Z');
    expect(toIsoString(clock.now())).toBe('2026-03-01T12:00:00.000Z');
  });

  it('advances by a number of milliseconds', () => {
    const clock = new FixedClock(1_000);
    clock.advance(250);
    expect(clock.now()).toBe(1_250);
  });

  it('can be set to a later instant', () => {
    const clock = new FixedClock('2026-03-01T00:00:00.000Z');
    clock.set('2026-03-02T00:00:00.000Z');
    expect(toIsoString(clock.now())).toBe('2026-03-02T00:00:00.000Z');
  });

  it('refuses to move backwards', () => {
    const clock = new FixedClock(10_000);
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.set(9_999)).toThrow(RangeError);
    expect(clock.now()).toBe(10_000);
  });
});

describe('SystemClock', () => {
  it('follows the wall clock', () => {
    const before = Date.now();
    const now = new SystemClock().now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe('toEpochMillis', () => {
  it('accepts numbers, ISO strings and dates', () => {
    expect(toEpochMillis(5)).toBe(5);
    expect(toEpochMillis('1970-01-01T00:00:01.000Z')).toBe(1_000);
    expect(toEpochMillis(new Date(42))).toBe(42);
  });

  it('rejects unparseable input', () => {
    expect(() => toEpochMillis('not a date')).toThrow(RangeError);
    expect(() => toEpochMillis(Number.NaN)).toThrow(RangeError);
  });
});
