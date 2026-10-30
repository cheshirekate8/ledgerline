// Criterion 3: once a credit has used the whole balance, a unit refund still refunds its
// units, restocks them (the order is Paid) and closes the order, but moves no money.
import { openStore, payloadOf, refusal } from './harness';

describe('criterion 3: a refund with no balance left', () => {
  it('moves units, stock and status but sends no payment refund', async () => {
    const store = openStore();
    await store.stock('MUG', 3);
    await store.paidOrder('C', [['MUG', 3]]);

    await store.credit('C', 3000, 'everything arrived broken', 'c-all', 'credit-all');
    await store.settle();
    expect(store.app.readModels.orderSummary.get('C')!.status).toBe('Paid');

    await store.refund('C', 'C-l1', 3, 'r-1');
    await store.settle();

    const refunds = store.events('OrderLineRefunded');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.version).toBe(3);
    expect(payloadOf(refunds[0]!)).toMatchObject({
      refundId: 'r-1',
      refund: { quantity: 3, totalCents: 3000 },
      paidBackCents: 0,
      returnsToStock: true,
    });
    expect(store.events('StockReturned').map((event) => payloadOf(event))).toEqual([
      { orderId: 'C', refundId: 'r-1', quantity: 3 },
    ]);
    expect(store.level('MUG')).toEqual({ onHand: 3, reserved: 0, available: 3 });

    const summary = store.app.readModels.orderSummary.get('C')!;
    expect(summary.status).toBe('Refunded');
    expect(summary.refundedCents).toBe(3000);
    expect(store.paymentRefunds('C')).toEqual([
      { refundId: 'c-all', amountCents: 3000, reason: 'everything arrived broken' },
    ]);

    await refusal(store.credit('C', 1, 'one more'), 'ORDER_NOT_REFUNDABLE');

    // A retried credit must be recognised by its id before the status is checked.
    await store.credit('C', 3000, 'everything arrived broken', 'c-all', 'credit-all-retry');
    await store.settle();
    expect(store.credits('C')).toHaveLength(1);
    expect(store.paymentRefunds('C')).toHaveLength(1);

    expect(store.versionsOtherThanOne()).toEqual([]);
  });
});
