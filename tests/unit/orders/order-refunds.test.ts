import { creditAmount, creditReason, paidBackFor, refundableBalance } from '../../../src/orders/order-refunds';
import { INITIAL_ORDER_STATE, OrderState } from '../../../src/orders/order-state';
import { ValidationError } from '../../../src/shared/errors';
import { cents } from '../../../src/shared/money';

const state = (paidCents: number, returnedCents: number): OrderState => ({
  ...INITIAL_ORDER_STATE,
  paidCents: cents(paidCents),
  returnedCents: cents(returnedCents),
});

describe('refundableBalance', () => {
  it('is what was paid less everything already given back', () => {
    expect(refundableBalance(state(3_000, 0))).toBe(3_000);
    expect(refundableBalance(state(3_000, 700))).toBe(2_300);
    expect(refundableBalance(state(3_000, 3_000))).toBe(0);
  });
});

describe('paidBackFor', () => {
  it('pays a refund in full while the balance covers it', () => {
    expect(paidBackFor(state(3_000, 700), cents(1_000))).toBe(1_000);
  });

  it('pays only what the balance has left, down to nothing', () => {
    expect(paidBackFor(state(3_000, 2_700), cents(1_000))).toBe(300);
    expect(paidBackFor(state(3_000, 3_000), cents(1_000))).toBe(0);
  });
});

describe('credit input', () => {
  it('accepts a positive whole number of cents', () => {
    expect(creditAmount(500)).toBe(500);
    expect(creditAmount(1)).toBe(1);
  });

  it('refuses zero, a negative amount and a fraction of a cent', () => {
    for (const amount of [0, -5, 1.5, Number.NaN]) {
      expect(() => creditAmount(amount)).toThrow(ValidationError);
    }
  });

  it('stores a reason trimmed and refuses an empty one', () => {
    expect(creditReason('  late delivery  ')).toBe('late delivery');
    expect(() => creditReason('')).toThrow(ValidationError);
    expect(() => creditReason('   ')).toThrow(ValidationError);
  });
});
