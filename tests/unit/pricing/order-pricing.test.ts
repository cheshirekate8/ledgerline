import { discountLine, MAX_LINE_QUANTITY } from '../../../src/pricing/line-pricing';
import { priceOrder } from '../../../src/pricing/order-pricing';
import { LineInput } from '../../../src/pricing/pricing-types';
import { cents } from '../../../src/shared/money';
import { Prng } from '../../support/prng';

const line = (lineId: string, unitPrice: number, quantity: number, sku = lineId): LineInput => ({
  lineId,
  sku,
  quantity,
  unitPriceCents: cents(unitPrice),
});
const tenPercent = { code: 'TEN', percentOffBasisPoints: 1_000 };

describe('discountLine', () => {
  it('rounds each line discount half to even', () => {
    expect(discountLine(line('a', 25, 1), [tenPercent])).toEqual({ grossCents: 25, discountCents: 2, netCents: 23 });
    expect(discountLine(line('b', 35, 1), [tenPercent])).toEqual({ grossCents: 35, discountCents: 4, netCents: 31 });
    expect(discountLine(line('c', 5_997, 1), [tenPercent]).discountCents).toBe(600);
  });

  it('applies multiple codes one after another on the remaining amount', () => {
    const fifteen = { code: 'FIFTEEN', percentOffBasisPoints: 1_500 };
    expect(discountLine(line('a', 1_000, 1), [tenPercent, fifteen])).toEqual({
      grossCents: 1_000,
      discountCents: 235,
      netCents: 765,
    });
  });

  it('allows a 100% discount but never a negative line', () => {
    expect(discountLine(line('a', 999, 2), [{ code: 'ALL', percentOffBasisPoints: 10_000 }]).netCents).toBe(0);
  });

  it('refuses invalid quantities', () => {
    expect(() => discountLine(line('a', 1, 0), [])).toThrow(RangeError);
    expect(() => discountLine(line('a', 1, 1.5), [])).toThrow(RangeError);
    expect(() => discountLine(line('a', 1, MAX_LINE_QUANTITY + 1), [])).toThrow(RangeError);
  });
});

describe('priceOrder', () => {
  it('prices the worked example: discount per line, coupon on subtotal, tax on the rest', () => {
    const pricing = priceOrder({
      lines: [line('a', 1_999, 3), line('b', 2_500, 1)],
      discountCodes: [tenPercent],
      coupon: { code: 'FIVE', amountCents: cents(500) },
      taxRateBasisPoints: 825,
    });

    expect(pricing).toMatchObject({
      subtotalCents: 8_497,
      discountCents: 850,
      discountedSubtotalCents: 7_647,
      couponCents: 500,
      couponCode: 'FIVE',
      taxableCents: 7_147,
      taxRateBasisPoints: 825,
      taxCents: 590,
      totalCents: 7_737,
    });
    expect(pricing.lines).toEqual([
      expect.objectContaining({
        lineId: 'a',
        grossCents: 5_997,
        discountCents: 600,
        netCents: 5_397,
        couponCents: 353,
        taxCents: 416,
        totalCents: 5_460,
      }),
      expect.objectContaining({
        lineId: 'b',
        grossCents: 2_500,
        discountCents: 250,
        netCents: 2_250,
        couponCents: 147,
        taxCents: 174,
        totalCents: 2_277,
      }),
    ]);
  });

  it('rounds tax half up on the final subtotal', () => {
    expect(priceOrder({ lines: [line('a', 25, 1)], discountCodes: [], taxRateBasisPoints: 1_000 }).taxCents).toBe(3);
    expect(priceOrder({ lines: [line('a', 24, 1)], discountCodes: [], taxRateBasisPoints: 1_000 }).taxCents).toBe(2);
  });

  it('rounds tax once on the order, not per line', () => {
    const pricing = priceOrder({
      lines: [line('a', 5, 1), line('b', 5, 1), line('c', 5, 1)],
      discountCodes: [],
      taxRateBasisPoints: 1_000,
    });
    expect(pricing.taxCents).toBe(2);
    expect(pricing.lines.map((l) => l.taxCents)).toEqual([1, 1, 0]);
  });

  it('caps the coupon so the subtotal never goes below zero', () => {
    const pricing = priceOrder({
      lines: [line('a', 300, 1), line('b', 100, 1)],
      discountCodes: [],
      coupon: { code: 'BIG', amountCents: cents(10_000) },
      taxRateBasisPoints: 2_000,
    });
    expect(pricing).toMatchObject({ couponCents: 400, taxableCents: 0, taxCents: 0, totalCents: 0 });
    expect(pricing.lines.map((l) => l.couponCents)).toEqual([300, 100]);
    expect(pricing.lines.every((l) => l.totalCents === 0)).toBe(true);
  });

  it('applies the coupon after discounts, never to the pre-discount subtotal', () => {
    const pricing = priceOrder({
      lines: [line('a', 1_000, 1)],
      discountCodes: [{ code: 'HALF', percentOffBasisPoints: 5_000 }],
      coupon: { code: 'SIX', amountCents: cents(600) },
      taxRateBasisPoints: 0,
    });
    expect(pricing).toMatchObject({ discountedSubtotalCents: 500, couponCents: 500, totalCents: 0 });
  });

  it('prices an empty order at zero', () => {
    expect(priceOrder({ lines: [], discountCodes: [], taxRateBasisPoints: 825 }).totalCents).toBe(0);
  });

  it('keeps line totals summing to the order total across many random orders', () => {
    const random = new Prng(2024);
    for (let run = 0; run < 300; run += 1) {
      const lines = Array.from({ length: random.int(1, 6) }, (_, i) =>
        line(`l${i}`, random.int(0, 50_000), random.int(1, 12)),
      );
      const codes = Array.from({ length: random.int(0, 2) }, (_, i) => ({
        code: `C${i}`,
        percentOffBasisPoints: random.int(0, 10_000),
      }));
      const pricing = priceOrder({
        lines,
        discountCodes: codes,
        ...(random.int(0, 1) === 1 ? { coupon: { code: 'C', amountCents: cents(random.int(0, 200_000)) } } : {}),
        taxRateBasisPoints: random.int(0, 3_000),
      });

      const sum = (pick: (l: (typeof pricing.lines)[number]) => number) =>
        pricing.lines.reduce((total, l) => total + pick(l), 0);
      expect(sum((l) => l.totalCents)).toBe(pricing.totalCents);
      expect(sum((l) => l.couponCents)).toBe(pricing.couponCents);
      expect(sum((l) => l.taxCents)).toBe(pricing.taxCents);
      expect(pricing.couponCents).toBeLessThanOrEqual(pricing.discountedSubtotalCents);
      for (const priced of pricing.lines) {
        expect(priced.couponCents).toBeLessThanOrEqual(priced.netCents);
        expect(priced.totalCents).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(priced.totalCents)).toBe(true);
      }
    }
  });
});
