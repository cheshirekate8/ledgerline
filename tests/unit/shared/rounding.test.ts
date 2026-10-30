import { divideRounded, scaleRounded, toSafeNumber } from '../../../src/shared/rounding';

describe('divideRounded', () => {
  it.each([
    [5n, 2n, 2n],
    [7n, 2n, 4n],
    [9n, 2n, 4n],
    [11n, 2n, 6n],
    [-5n, 2n, -2n],
    [-7n, 2n, -4n],
    [10n, 4n, 2n],
    [14n, 4n, 4n],
    [13n, 4n, 3n],
  ])('half-even: %p / %p = %p', (numerator, denominator, expected) => {
    expect(divideRounded(numerator, denominator, 'half-even')).toBe(expected);
  });

  it.each([
    [5n, 2n, 3n],
    [7n, 2n, 4n],
    [9n, 2n, 5n],
    [-5n, 2n, -3n],
    [13n, 4n, 3n],
    [11n, 4n, 3n],
  ])('half-up (away from zero): %p / %p = %p', (numerator, denominator, expected) => {
    expect(divideRounded(numerator, denominator, 'half-up')).toBe(expected);
  });

  it('handles negative denominators', () => {
    expect(divideRounded(5n, -2n, 'half-up')).toBe(-3n);
  });

  it('rejects division by zero', () => {
    expect(() => divideRounded(1n, 0n, 'half-even')).toThrow(RangeError);
  });
});

describe('scaleRounded', () => {
  it('computes value * numerator / denominator without floating point drift', () => {
    expect(scaleRounded(1_005, 1_000, 10_000, 'half-even')).toBe(100);
    expect(scaleRounded(1_015, 1_000, 10_000, 'half-even')).toBe(102);
    expect(scaleRounded(1_005, 1_000, 10_000, 'half-up')).toBe(101);
  });

  it('stays exact for products beyond the double precision range', () => {
    expect(scaleRounded(Number.MAX_SAFE_INTEGER, 10_000, 10_000, 'half-even')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects non-integer inputs', () => {
    expect(() => scaleRounded(1.5, 1, 1, 'half-up')).toThrow(RangeError);
  });
});

describe('toSafeNumber', () => {
  it('rejects values outside the safe range', () => {
    expect(() => toSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(RangeError);
  });
});
