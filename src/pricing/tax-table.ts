import { assertBasisPoints } from '../shared/money';
import { UnknownTaxRegionError } from './pricing-errors';

/** Sales tax rates in basis points, keyed by shipping region code. */
export class TaxTable {
  private readonly rates = new Map<string, number>();

  constructor(rates: Readonly<Record<string, number>>) {
    for (const [region, rate] of Object.entries(rates)) {
      assertBasisPoints(rate, `Tax rate for ${region}`);
      this.rates.set(normalizeRegion(region), rate);
    }
  }

  rateFor(region: string): number {
    const rate = this.rates.get(normalizeRegion(region));
    if (rate === undefined) {
      throw new UnknownTaxRegionError(region);
    }
    return rate;
  }

  supports(region: string): boolean {
    return this.rates.has(normalizeRegion(region));
  }
}

export function normalizeRegion(region: string): string {
  return region.trim().toUpperCase();
}
