import { allocateProportionally } from '../shared/allocation';
import { Cents, cents, subtractCents, sumCents } from '../shared/money';
import { assertQuantity } from './line-pricing';
import { LinePricing, RefundAmounts } from './pricing-types';

export interface UnitAmounts {
  readonly grossCents: Cents;
  readonly discountCents: Cents;
  readonly couponCents: Cents;
  readonly taxCents: Cents;
  readonly totalCents: Cents;
}

/**
 * Splits a priced line into its individual units. The line's discounted
 * amount is spread evenly over the units, then its coupon share and tax
 * share are spread in proportion to what each unit carries. Every component
 * of every unit is non-negative and the units sum exactly to the line, so
 * refunding units one at a time or all at once returns the same total and
 * prorates the discount, coupon and tax along with the price.
 */
export function splitLineIntoUnits(line: LinePricing): UnitAmounts[] {
  assertQuantity(line.quantity);
  const netPerUnit = allocateProportionally(line.netCents, Array.from({ length: line.quantity }, () => 1));
  const afterCouponPerUnit = allocateProportionally(subtractCents(line.netCents, line.couponCents), netPerUnit);
  const taxPerUnit = allocateProportionally(line.taxCents, afterCouponPerUnit);
  return netPerUnit.map((net, index) => {
    const afterCoupon = afterCouponPerUnit[index]!;
    const tax = taxPerUnit[index]!;
    return {
      grossCents: line.unitPriceCents,
      discountCents: subtractCents(line.unitPriceCents, net),
      couponCents: subtractCents(net, afterCoupon),
      taxCents: tax,
      totalCents: cents(afterCoupon + tax),
    };
  });
}

/**
 * The refund for `quantity` more units of a line, of which
 * `alreadyRefunded` units were refunded earlier. Units are always refunded
 * in the same order, so successive partial refunds add up to the line total.
 */
export function refundForUnits(line: LinePricing, alreadyRefunded: number, quantity: number): RefundAmounts {
  if (!Number.isInteger(alreadyRefunded) || alreadyRefunded < 0) {
    throw new RangeError(`alreadyRefunded must be a non-negative integer, got ${alreadyRefunded}`);
  }
  assertQuantity(quantity);
  if (alreadyRefunded + quantity > line.quantity) {
    throw new RangeError(
      `Cannot refund ${quantity} more of line ${line.lineId}: ${line.quantity - alreadyRefunded} remain`,
    );
  }
  const units = splitLineIntoUnits(line).slice(alreadyRefunded, alreadyRefunded + quantity);
  return {
    quantity,
    grossCents: sumCents(units.map((unit) => unit.grossCents)),
    discountCents: sumCents(units.map((unit) => unit.discountCents)),
    couponCents: sumCents(units.map((unit) => unit.couponCents)),
    taxCents: sumCents(units.map((unit) => unit.taxCents)),
    totalCents: sumCents(units.map((unit) => unit.totalCents)),
  };
}
