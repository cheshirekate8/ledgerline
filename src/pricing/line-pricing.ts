import { applyBasisPoints, Cents, cents, multiplyCents, subtractCents } from '../shared/money';
import { DiscountCode } from './discount-codes';
import { LineInput } from './pricing-types';

export interface DiscountedLine {
  readonly grossCents: Cents;
  readonly discountCents: Cents;
  readonly netCents: Cents;
}

export const MAX_LINE_QUANTITY = 10_000;

export function assertQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) {
    throw new RangeError(`Quantity must be an integer from 1 to ${MAX_LINE_QUANTITY}, got ${quantity}`);
  }
}

/**
 * Applies the percentage discount codes to one line, in the order given.
 * Each code takes its percentage of what remains of the line after the
 * previous codes, and each discount is rounded half to even on its own.
 */
export function discountLine(line: LineInput, discountCodes: readonly DiscountCode[]): DiscountedLine {
  assertQuantity(line.quantity);
  const grossCents = multiplyCents(line.unitPriceCents, line.quantity);
  let remaining = grossCents;
  for (const discount of discountCodes) {
    remaining = subtractCents(remaining, applyBasisPoints(remaining, discount.percentOffBasisPoints, 'half-even'));
  }
  return { grossCents, discountCents: cents(grossCents - remaining), netCents: remaining };
}
