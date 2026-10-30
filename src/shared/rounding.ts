/**
 * Integer division with explicit rounding. Arithmetic is carried out on
 * bigint so intermediate products of cents and basis points cannot lose
 * precision, and no floating point value ever touches a monetary amount.
 */
export type RoundingMode = 'half-even' | 'half-up';

export function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) {
    throw new RangeError('Division by zero');
  }
  if (denominator < 0n) {
    return divideRounded(-numerator, -denominator, mode);
  }
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = magnitude / denominator;
  const twiceRemainder = (magnitude % denominator) * 2n;

  let rounded = quotient;
  if (twiceRemainder > denominator) {
    rounded = quotient + 1n;
  } else if (twiceRemainder === denominator && (mode === 'half-up' || quotient % 2n === 1n)) {
    rounded = quotient + 1n;
  }
  return negative ? -rounded : rounded;
}

/** Rounds `value * numerator / denominator` to an integer using `mode`. */
export function scaleRounded(value: number, numerator: number, denominator: number, mode: RoundingMode): number {
  assertSafeInteger(value, 'value');
  assertSafeInteger(numerator, 'numerator');
  assertSafeInteger(denominator, 'denominator');
  return toSafeNumber(divideRounded(BigInt(value) * BigInt(numerator), BigInt(denominator), mode));
}

export function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`Value ${value} is outside the safe integer range`);
  }
  return Number(value);
}

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer, got ${value}`);
  }
}
