import { CouponCatalog } from './coupons';
import { DiscountCode, DiscountCodeCatalog } from './discount-codes';
import { PriceList } from './price-list';
import { TaxTable } from './tax-table';

/** Everything needed to price an order. */
export interface PricingCatalog {
  readonly prices: PriceList;
  readonly discountCodes: DiscountCodeCatalog;
  readonly coupons: CouponCatalog;
  readonly taxRates: TaxTable;
}

export interface PricingCatalogConfig {
  /** Unit price in cents per SKU. */
  readonly prices: Readonly<Record<string, number>>;
  /** Tax rate in basis points per shipping region. */
  readonly taxRates: Readonly<Record<string, number>>;
  readonly discountCodes?: readonly DiscountCode[];
  readonly coupons?: ReadonlyArray<{ code: string; amountCents: number }>;
}

export function createPricingCatalog(config: PricingCatalogConfig): PricingCatalog {
  return {
    prices: new PriceList(config.prices),
    discountCodes: new DiscountCodeCatalog(config.discountCodes ?? []),
    coupons: new CouponCatalog(config.coupons ?? []),
    taxRates: new TaxTable(config.taxRates),
  };
}
