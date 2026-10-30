import { CouponCatalog } from '../../../src/pricing/coupons';
import { DiscountCodeCatalog } from '../../../src/pricing/discount-codes';
import { PriceList } from '../../../src/pricing/price-list';
import { createPricingCatalog } from '../../../src/pricing/pricing-catalog';
import {
  UnknownCouponError,
  UnknownDiscountCodeError,
  UnknownSkuError,
  UnknownTaxRegionError,
} from '../../../src/pricing/pricing-errors';
import { TaxTable } from '../../../src/pricing/tax-table';
import { InvalidMoneyError } from '../../../src/shared/money';

describe('PriceList', () => {
  it('returns unit prices in cents', () => {
    const prices = new PriceList({ MUG: 1_299, FREE: 0 });
    expect(prices.priceOf('MUG')).toBe(1_299);
    expect(prices.priceOf('FREE')).toBe(0);
    expect(prices.has('MUG')).toBe(true);
    expect(prices.skus).toEqual(['MUG', 'FREE']);
  });

  it('refuses unknown SKUs with a typed error', () => {
    expect(() => new PriceList({}).priceOf('NOPE')).toThrow(UnknownSkuError);
  });

  it('refuses fractional or negative prices', () => {
    expect(() => new PriceList({ MUG: 12.99 })).toThrow(InvalidMoneyError);
    expect(() => new PriceList({ MUG: -1 })).toThrow(InvalidMoneyError);
    expect(() => new PriceList({ ' ': 1 })).toThrow(RangeError);
  });
});

describe('TaxTable', () => {
  it('looks up rates by normalized region code', () => {
    const taxes = new TaxTable({ 'us-ca': 725, DE: 1_900 });
    expect(taxes.rateFor('US-CA')).toBe(725);
    expect(taxes.rateFor(' de ')).toBe(1_900);
    expect(taxes.supports('FR')).toBe(false);
  });

  it('refuses unknown regions and invalid rates', () => {
    expect(() => new TaxTable({}).rateFor('FR')).toThrow(UnknownTaxRegionError);
    expect(() => new TaxTable({ FR: 20.5 })).toThrow(RangeError);
    expect(() => new TaxTable({ FR: 10_001 })).toThrow(RangeError);
  });
});

describe('DiscountCodeCatalog', () => {
  it('looks up codes case-insensitively', () => {
    const codes = new DiscountCodeCatalog([{ code: 'spring10', percentOffBasisPoints: 1_000 }]);
    expect(codes.lookup(' SPRING10 ')).toEqual({ code: 'SPRING10', percentOffBasisPoints: 1_000 });
  });

  it('refuses unknown, duplicate and out-of-range codes', () => {
    expect(() => new DiscountCodeCatalog([]).lookup('X')).toThrow(UnknownDiscountCodeError);
    expect(
      () =>
        new DiscountCodeCatalog([
          { code: 'a', percentOffBasisPoints: 1 },
          { code: 'A', percentOffBasisPoints: 2 },
        ]),
    ).toThrow(/defined twice/);
    expect(() => new DiscountCodeCatalog([{ code: 'X', percentOffBasisPoints: 10_001 }])).toThrow(RangeError);
  });
});

describe('CouponCatalog', () => {
  it('looks up fixed-amount coupons', () => {
    const coupons = new CouponCatalog([{ code: 'five-off', amountCents: 500 }]);
    expect(coupons.lookup('FIVE-OFF')).toEqual({ code: 'FIVE-OFF', amountCents: 500 });
  });

  it('refuses unknown, duplicate and fractional coupons', () => {
    expect(() => new CouponCatalog([]).lookup('X')).toThrow(UnknownCouponError);
    expect(
      () =>
        new CouponCatalog([
          { code: 'x', amountCents: 1 },
          { code: 'X', amountCents: 1 },
        ]),
    ).toThrow(/defined twice/);
    expect(() => new CouponCatalog([{ code: 'X', amountCents: 4.5 }])).toThrow(InvalidMoneyError);
  });
});

describe('createPricingCatalog', () => {
  it('builds every catalog from plain configuration', () => {
    const catalog = createPricingCatalog({ prices: { MUG: 100 }, taxRates: { DE: 1_900 } });
    expect(catalog.prices.priceOf('MUG')).toBe(100);
    expect(catalog.taxRates.rateFor('DE')).toBe(1_900);
    expect(() => catalog.discountCodes.lookup('ANY')).toThrow(UnknownDiscountCodeError);
    expect(() => catalog.coupons.lookup('ANY')).toThrow(UnknownCouponError);
  });
});
