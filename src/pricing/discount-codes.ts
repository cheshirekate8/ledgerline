import { assertBasisPoints } from '../shared/money';
import { UnknownDiscountCodeError } from './pricing-errors';

/** A percentage discount applied to every line of an order. */
export interface DiscountCode {
  readonly code: string;
  /** Percentage off in basis points: 1500 is 15%. */
  readonly percentOffBasisPoints: number;
}

export class DiscountCodeCatalog {
  private readonly codes = new Map<string, DiscountCode>();

  constructor(codes: readonly DiscountCode[]) {
    for (const entry of codes) {
      const code = normalizeCode(entry.code);
      assertBasisPoints(entry.percentOffBasisPoints, `Discount ${code}`);
      if (this.codes.has(code)) {
        throw new Error(`Discount code ${code} is defined twice`);
      }
      this.codes.set(code, Object.freeze({ code, percentOffBasisPoints: entry.percentOffBasisPoints }));
    }
  }

  lookup(code: string): DiscountCode {
    const discount = this.codes.get(normalizeCode(code));
    if (!discount) {
      throw new UnknownDiscountCodeError(code);
    }
    return discount;
  }
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}
