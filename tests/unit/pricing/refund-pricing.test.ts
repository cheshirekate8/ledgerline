import { priceOrder } from '../../../src/pricing/order-pricing';
import { LinePricing } from '../../../src/pricing/pricing-types';
import { refundForUnits, splitLineIntoUnits } from '../../../src/pricing/refund-pricing';
import { cents } from '../../../src/shared/money';
import { Prng } from '../../support/prng';

function workedExampleLine(): LinePricing {
  return priceOrder({
    lines: [
      { lineId: 'a', sku: 'A', quantity: 3, unitPriceCents: cents(1_999) },
      { lineId: 'b', sku: 'B', quantity: 1, unitPriceCents: cents(2_500) },
    ],
    discountCodes: [{ code: 'TEN', percentOffBasisPoints: 1_000 }],
    coupon: { code: 'FIVE', amountCents: cents(500) },
    taxRateBasisPoints: 825,
  }).lines[0]!;
}

describe('splitLineIntoUnits', () => {
  it('spreads the discount, coupon and tax across units', () => {
    expect(splitLineIntoUnits(workedExampleLine())).toEqual([
      { grossCents: 1_999, discountCents: 200, couponCents: 117, taxCents: 139, totalCents: 1_821 },
      { grossCents: 1_999, discountCents: 200, couponCents: 118, taxCents: 139, totalCents: 1_820 },
      { grossCents: 1_999, discountCents: 200, couponCents: 118, taxCents: 138, totalCents: 1_819 },
    ]);
  });
});

describe('refundForUnits', () => {
  it('prorates the discount, coupon and tax with the refunded units', () => {
    const lineA = workedExampleLine();
    expect(refundForUnits(lineA, 0, 1)).toEqual({
      quantity: 1,
      grossCents: 1_999,
      discountCents: 200,
      couponCents: 117,
      taxCents: 139,
      totalCents: 1_821,
    });
    expect(refundForUnits(lineA, 1, 2)).toEqual({
      quantity: 2,
      grossCents: 3_998,
      discountCents: 400,
      couponCents: 236,
      taxCents: 277,
      totalCents: 3_639,
    });
  });

  it('returns exactly what was paid for the line when fully refunded', () => {
    const lineA = workedExampleLine();
    const full = refundForUnits(lineA, 0, 3);
    expect(full).toMatchObject({
      grossCents: lineA.grossCents,
      discountCents: lineA.discountCents,
      couponCents: lineA.couponCents,
      taxCents: lineA.taxCents,
      totalCents: lineA.totalCents,
    });
  });

  it('refuses to refund more units than remain', () => {
    const lineA = workedExampleLine();
    expect(() => refundForUnits(lineA, 2, 2)).toThrow(/1 remain/);
    expect(() => refundForUnits(lineA, 0, 0)).toThrow(RangeError);
    expect(() => refundForUnits(lineA, -1, 1)).toThrow(RangeError);
  });

  it('never returns more than was paid, however the refunds are split', () => {
    const random = new Prng(77);
    for (let run = 0; run < 200; run += 1) {
      const quantity = random.int(1, 9);
      const pricing = priceOrder({
        lines: [
          { lineId: 'x', sku: 'X', quantity, unitPriceCents: cents(random.int(0, 9_999)) },
          { lineId: 'y', sku: 'Y', quantity: random.int(1, 4), unitPriceCents: cents(random.int(0, 9_999)) },
        ],
        discountCodes: [{ code: 'D', percentOffBasisPoints: random.int(0, 10_000) }],
        coupon: { code: 'C', amountCents: cents(random.int(0, 20_000)) },
        taxRateBasisPoints: random.int(0, 2_500),
      });
      const target = pricing.lines[0]!;

      let refunded = 0;
      let totalReturned = 0;
      while (refunded < quantity) {
        const take = random.int(1, quantity - refunded);
        const refund = refundForUnits(target, refunded, take);
        for (const amount of [refund.discountCents, refund.couponCents, refund.taxCents, refund.totalCents]) {
          expect(amount).toBeGreaterThanOrEqual(0);
        }
        expect(refund.grossCents - refund.discountCents - refund.couponCents + refund.taxCents).toBe(
          refund.totalCents,
        );
        refunded += take;
        totalReturned += refund.totalCents;
        expect(totalReturned).toBeLessThanOrEqual(target.totalCents);
      }
      expect(totalReturned).toBe(target.totalCents);
    }
  });
});
