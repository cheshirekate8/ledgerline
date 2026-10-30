// Criterion 4: a credit larger than the balance is refused, and the balance counts what
// unit refunds have already paid back. Order D: MUG×3 paid 3000, one unit refunded (1000
// paid back), so the balance is 2000.
import { openStore, refusal } from './harness';

describe('criterion 4: a credit larger than the balance', () => {
  it('is refused with CREDIT_EXCEEDS_REFUNDABLE and records nothing', async () => {
    const store = openStore();
    await store.stock('MUG', 3);
    await store.paidOrder('D', [['MUG', 3]]);
    await store.refund('D', 'D-l1', 1, 'r-1');
    await store.settle();
    expect(store.paymentRefunds('D').map((refund) => refund.amountCents)).toEqual([1000]);

    await refusal(store.credit('D', 2001, 'too much', 'c-over'), 'CREDIT_EXCEEDS_REFUNDABLE');
    await store.settle();
    expect(store.credits('D')).toEqual([]);
    expect(store.paymentRefunds('D')).toHaveLength(1);

    await store.credit('D', 2000, 'the rest', 'c-rest');
    await store.settle();
    expect(store.credits('D').map((credit) => credit.amountCents)).toEqual([2000]);
    expect(store.paymentRefunds('D').map((refund) => [refund.refundId, refund.amountCents])).toEqual([
      ['r-1', 1000],
      ['c-rest', 2000],
    ]);
    expect(store.app.readModels.orderSummary.get('D')!.status).toBe('Paid');

    await refusal(store.credit('D', 1, 'one more', 'c-one'), 'CREDIT_EXCEEDS_REFUNDABLE');
    await store.settle();
    expect(store.credits('D')).toHaveLength(1);
    expect(store.paymentRefunds('D')).toHaveLength(2);
  });
});
