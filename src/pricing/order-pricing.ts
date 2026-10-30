import { allocateProportionally } from '../shared/allocation';
import { applyBasisPoints, assertBasisPoints, cents, minCents, subtractCents, sumCents, ZERO_CENTS } from '../shared/money';
import { discountLine } from './line-pricing';
import { LinePricing, OrderPricing, OrderPricingInput } from './pricing-types';

/**
 * Prices an order, in this order:
 *
 * 1. each line's gross is unit price × quantity;
 * 2. percentage discount codes are applied per line, rounded half to even;
 * 3. the fixed-amount coupon comes off the discounted subtotal, and is capped
 *    so the subtotal never goes below zero;
 * 4. tax is charged at the shipping region's rate on what remains, rounded
 *    half up once on the order as a whole.
 *
 * The coupon and the tax are then allocated back to the lines (largest
 * remainder, proportional to each line's amount) so that per-line refunds
 * can never return more than was paid for that line.
 */
export function priceOrder(input: OrderPricingInput): OrderPricing {
  assertBasisPoints(input.taxRateBasisPoints, 'Tax rate');
  const discounted = input.lines.map((line) => ({ line, ...discountLine(line, input.discountCodes) }));

  const subtotalCents = sumCents(discounted.map((entry) => entry.grossCents));
  const discountCents = sumCents(discounted.map((entry) => entry.discountCents));
  const discountedSubtotalCents = sumCents(discounted.map((entry) => entry.netCents));
  const couponCents = input.coupon ? minCents(input.coupon.amountCents, discountedSubtotalCents) : ZERO_CENTS;
  const taxableCents = subtractCents(discountedSubtotalCents, couponCents);
  const taxCents = applyBasisPoints(taxableCents, input.taxRateBasisPoints, 'half-up');

  const couponShares = allocateProportionally(
    couponCents,
    discounted.map((entry) => entry.netCents),
  );
  const afterCoupon = discounted.map((entry, index) => subtractCents(entry.netCents, couponShares[index]!));
  const taxShares = allocateProportionally(taxCents, afterCoupon);

  const lines: LinePricing[] = discounted.map((entry, index) => ({
    lineId: entry.line.lineId,
    sku: entry.line.sku,
    quantity: entry.line.quantity,
    unitPriceCents: entry.line.unitPriceCents,
    grossCents: entry.grossCents,
    discountCents: entry.discountCents,
    netCents: entry.netCents,
    couponCents: couponShares[index]!,
    taxCents: taxShares[index]!,
    totalCents: cents(afterCoupon[index]! + taxShares[index]!),
  }));

  return {
    lines,
    discountCodes: input.discountCodes.map((code) => ({ ...code })),
    ...(input.coupon ? { couponCode: input.coupon.code } : {}),
    subtotalCents,
    discountCents,
    discountedSubtotalCents,
    couponCents,
    taxableCents,
    taxRateBasisPoints: input.taxRateBasisPoints,
    taxCents,
    totalCents: cents(taxableCents + taxCents),
  };
}
