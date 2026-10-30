import { Cents } from '../shared/money';
import { Coupon } from './coupons';
import { DiscountCode } from './discount-codes';

export interface LineInput {
  readonly lineId: string;
  readonly sku: string;
  readonly quantity: number;
  readonly unitPriceCents: Cents;
}

/**
 * The price of one line, with the order-level coupon and tax allocated to it
 * so that the line totals sum exactly to the order total.
 */
export interface LinePricing extends LineInput {
  /** unitPriceCents × quantity. */
  readonly grossCents: Cents;
  /** Total of all percentage discounts on this line. */
  readonly discountCents: Cents;
  /** grossCents − discountCents. */
  readonly netCents: Cents;
  /** This line's share of the coupon. */
  readonly couponCents: Cents;
  /** This line's share of the order's tax. */
  readonly taxCents: Cents;
  /** netCents − couponCents + taxCents: what the customer paid for this line. */
  readonly totalCents: Cents;
}

export interface OrderPricingInput {
  readonly lines: readonly LineInput[];
  readonly discountCodes: readonly DiscountCode[];
  readonly coupon?: Coupon;
  readonly taxRateBasisPoints: number;
}

export interface OrderPricing {
  readonly lines: readonly LinePricing[];
  readonly discountCodes: readonly DiscountCode[];
  readonly couponCode?: string;
  /** Sum of line gross amounts. */
  readonly subtotalCents: Cents;
  readonly discountCents: Cents;
  /** Subtotal after percentage discounts. */
  readonly discountedSubtotalCents: Cents;
  /** Coupon amount actually applied; never more than the discounted subtotal. */
  readonly couponCents: Cents;
  /** Amount tax is charged on: discounted subtotal minus coupon. */
  readonly taxableCents: Cents;
  readonly taxRateBasisPoints: number;
  readonly taxCents: Cents;
  readonly totalCents: Cents;
}

/** Amounts returned to the customer for some units of one line. */
export interface RefundAmounts {
  readonly quantity: number;
  readonly grossCents: Cents;
  readonly discountCents: Cents;
  readonly couponCents: Cents;
  readonly taxCents: Cents;
  readonly totalCents: Cents;
}
