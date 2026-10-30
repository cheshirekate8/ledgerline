import { Cents, nonNegativeCents } from '../shared/money';
import { UnknownSkuError } from './pricing-errors';

/** Unit prices in cents, keyed by SKU. */
export class PriceList {
  private readonly prices = new Map<string, Cents>();

  constructor(entries: Readonly<Record<string, number>>) {
    for (const [sku, price] of Object.entries(entries)) {
      if (sku.trim().length === 0) {
        throw new RangeError('SKUs must be non-empty');
      }
      this.prices.set(sku, nonNegativeCents(price));
    }
  }

  priceOf(sku: string): Cents {
    const price = this.prices.get(sku);
    if (price === undefined) {
      throw new UnknownSkuError(sku);
    }
    return price;
  }

  has(sku: string): boolean {
    return this.prices.has(sku);
  }

  get skus(): readonly string[] {
    return [...this.prices.keys()];
  }
}
