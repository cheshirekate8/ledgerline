// Criterion 2: a credit comes off the last refunds, across the whole order rather than
// per line. Order B is MUG×2 and CUP×2 (2000 + 1000 = 3000). After a 700 credit the
// balance is 2300, so the first two unit refunds pay back in full and the last pays 300.
import { openStore, payloadOf } from './harness';

interface RefundPayload {
  refundId: string;
  refund: { totalCents: number };
  paidBackCents: number;
}

describe('criterion 2: a credit comes off the last refunds', () => {
  it('pays each refund back from the order-wide balance until it runs out', async () => {
    const store = openStore();
    await store.stock('MUG', 2);
    await store.stock('CUP', 2);
    await store.paidOrder('B', [
      ['MUG', 2],
      ['CUP', 2],
    ]);
    expect(store.app.readModels.orderSummary.get('B')!.totalCents).toBe(3000);

    await store.credit('B', 700, 'late delivery', 'c-1');
    await store.settle();
    await store.refund('B', 'B-l1', 1, 'r-1');
    await store.settle();
    await store.refund('B', 'B-l2', 2, 'r-2');
    await store.settle();
    await store.refund('B', 'B-l1', 1, 'r-3');
    await store.settle();

    const refunds = store.events('OrderLineRefunded');
    expect(refunds.map((event) => event.version)).toEqual([3, 3, 3]);
    const payloads = refunds.map((event) => payloadOf<RefundPayload>(event));
    expect(payloads.map((payload) => payload.refundId)).toEqual(['r-1', 'r-2', 'r-3']);
    expect(payloads.map((payload) => payload.refund.totalCents)).toEqual([1000, 1000, 1000]);
    expect(payloads.map((payload) => payload.paidBackCents)).toEqual([1000, 1000, 300]);

    const paidBack = Object.fromEntries(store.paymentRefunds('B').map((refund) => [refund.refundId, refund.amountCents]));
    expect(paidBack).toEqual({ 'c-1': 700, 'r-1': 1000, 'r-2': 1000, 'r-3': 300 });
    expect(store.paymentRefunds('B')).toHaveLength(4);

    const summary = store.app.readModels.orderSummary.get('B')!;
    expect(summary.status).toBe('Refunded');
    const closed = store.events('OrderRefunded');
    expect(closed).toHaveLength(1);
    // 3700 would count the credit on top of the prorated unit totals.
    expect(payloadOf(closed[0]!)).toEqual({ totalRefundedCents: 3000 });
    expect(summary.refundedCents).toBe(3000);
    expect(store.app.readModels.customerHistory.get('customer-B')!.lifetimeSpendCents).toBe(0);

    expect(store.versionsOtherThanOne()).toEqual([]);
  });
});
