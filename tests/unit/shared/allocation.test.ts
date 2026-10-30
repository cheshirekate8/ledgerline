import { allocateProportionally } from '../../../src/shared/allocation';
import { cents } from '../../../src/shared/money';

describe('allocateProportionally', () => {
  it('splits exactly when the shares divide evenly', () => {
    expect(allocateProportionally(cents(100), [1, 1, 2])).toEqual([25, 25, 50]);
  });

  it('gives leftover cents to the largest remainders', () => {
    expect(allocateProportionally(cents(100), [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateProportionally(cents(10), [3, 3, 4])).toEqual([3, 3, 4]);
    expect(allocateProportionally(cents(7), [10, 20, 30])).toEqual([1, 2, 4]);
  });

  it('always sums to the total', () => {
    const weights = [997, 13, 4_201, 1, 77];
    for (let total = 0; total < 500; total += 7) {
      const parts = allocateProportionally(cents(total), weights);
      expect(parts.reduce((sum, part) => sum + part, 0)).toBe(total);
    }
  });

  it('never gives a part more than the ceiling of its exact share', () => {
    const weights = [5, 3, 2];
    const total = 9;
    const parts = allocateProportionally(cents(total), weights);
    parts.forEach((part, index) => {
      expect(part).toBeLessThanOrEqual(Math.ceil((total * weights[index]!) / 10));
    });
  });

  it('gives nothing to zero weights', () => {
    expect(allocateProportionally(cents(9), [0, 3, 0])).toEqual([0, 9, 0]);
  });

  it('allows zero across zero weight but nothing else', () => {
    expect(allocateProportionally(cents(0), [0, 0])).toEqual([0, 0]);
    expect(() => allocateProportionally(cents(1), [0, 0])).toThrow(RangeError);
  });

  it('rejects negative totals and weights', () => {
    expect(() => allocateProportionally(cents(-1), [1])).toThrow(RangeError);
    expect(() => allocateProportionally(cents(1), [-1, 2])).toThrow(RangeError);
  });
});
