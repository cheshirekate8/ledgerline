import { Cents, nonNegativeCents } from '../shared/money';
import { normalizeCode } from './discount-codes';
import { UnknownCouponError } from './pricing-errors';

/** A fixed amount taken off the order subtotal after percentage discounts. */
export interface Coupon {
  readonly code: string;
  readonly amountCents: Cents;
}

export class CouponCatalog {
  private readonly coupons = new Map<string, Coupon>();

  constructor(coupons: ReadonlyArray<{ code: string; amountCents: number }>) {
    for (const entry of coupons) {
      const code = normalizeCode(entry.code);
      if (this.coupons.has(code)) {
        throw new Error(`Coupon ${code} is defined twice`);
      }
      this.coupons.set(code, Object.freeze({ code, amountCents: nonNegativeCents(entry.amountCents) }));
    }
  }

  lookup(code: string): Coupon {
    const coupon = this.coupons.get(normalizeCode(code));
    if (!coupon) {
      throw new UnknownCouponError(code);
    }
    return coupon;
  }
}
