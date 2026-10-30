import { createPricingCatalog, PricingCatalogConfig } from '../../src/pricing/pricing-catalog';

/** The store's catalog in tests. Prices are chosen to exercise rounding. */
export const TEST_CATALOG_CONFIG: PricingCatalogConfig = {
  prices: { MUG: 1_999, TEE: 2_500, POSTER: 1_005, STICKER: 35 },
  taxRates: { 'US-CA': 825, 'US-OR': 0, DE: 1_900 },
  discountCodes: [
    { code: 'TEN', percentOffBasisPoints: 1_000 },
    { code: 'FIFTEEN', percentOffBasisPoints: 1_500 },
  ],
  coupons: [
    { code: 'FIVE', amountCents: 500 },
    { code: 'HUNDRED', amountCents: 10_000 },
  ],
};

export const testCatalog = () => createPricingCatalog(TEST_CATALOG_CONFIG);
