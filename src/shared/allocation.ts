import { Cents, cents } from './money';

/**
 * Splits `total` across `weights` in proportion using the largest remainder
 * method. The parts always sum to exactly `total`, and no part exceeds the
 * ceiling of its exact proportional share. Leftover cents go to the largest
 * fractional remainders with ties broken by position, so the split is
 * deterministic.
 */
export function allocateProportionally(total: Cents, weights: readonly number[]): Cents[] {
  if (total < 0) {
    throw new RangeError(`Cannot allocate a negative amount: ${total}`);
  }
  for (const weight of weights) {
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new RangeError(`Allocation weights must be non-negative integers, got ${weight}`);
    }
  }
  const weightSum = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (weightSum === 0n) {
    if (total !== 0) {
      throw new RangeError(`Cannot allocate ${total} across zero total weight`);
    }
    return weights.map(() => cents(0));
  }

  const bigTotal = BigInt(total);
  const shares = weights.map((weight, index) => {
    const product = bigTotal * BigInt(weight);
    return { index, amount: product / weightSum, remainder: product % weightSum };
  });
  let leftover = bigTotal - shares.reduce((sum, share) => sum + share.amount, 0n);
  const byRemainder = [...shares].sort((a, b) => {
    if (a.remainder === b.remainder) {
      return a.index - b.index;
    }
    return a.remainder > b.remainder ? -1 : 1;
  });
  for (const share of byRemainder) {
    if (leftover === 0n) {
      break;
    }
    share.amount += 1n;
    leftover -= 1n;
  }
  return shares.map((share) => cents(Number(share.amount)));
}
