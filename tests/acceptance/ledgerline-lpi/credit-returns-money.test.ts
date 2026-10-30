// Criterion 1: a credit returns money to the customer's payment and changes nothing else.
import { openStore, payloadOf } from './harness';

describe('criterion 1: a credit returns money and changes nothing else', () => {
  it('records OrderCredited v1, refunds the payment, and counts it in every read model', async () => {
    const store = openStore();
    await store.stock('MUG', 3);
    await store.paidOrder('A', [['MUG', 3]]);
    const before = store.level('MUG');

    await store.credit('A', 500, 'late delivery', 'c-1');

    const credited = store.events('OrderCredited');
    expect(credited).toHaveLength(1);
    expect(credited[0]).toMatchObject({ aggregateType: 'order', aggregateId: 'A', version: 1 });
    expect(payloadOf(credited[0]!)).toEqual({
      creditId: 'c-1',
      paymentId: 'pay-A',
      amountCents: 500,
      reason: 'late delivery',
    });

    await store.settle();

    expect(store.paymentRefunds('A')).toEqual([{ refundId: 'c-1', amountCents: 500, reason: 'late delivery' }]);
    expect(store.app.readModels.orderSummary.get('A')!.status).toBe('Paid');
    expect(store.level('MUG')).toEqual(before);
    expect(store.events('StockReturned')).toEqual([]);

    const expectReadModels = () => {
      const { readModels } = store.app;
      expect(readModels.orderSummary.get('A')!.refundedCents).toBe(500);
      const history = readModels.customerHistory.get('customer-A')!;
      expect(history.orders.find((order) => order.orderId === 'A')!.refundedCents).toBe(500);
      expect(history.lifetimeSpendCents).toBe(2500);
      const days = readModels.dailyRevenue.all();
      expect(days).toHaveLength(1);
      expect(days[0]).toMatchObject({ capturedCents: 3000, refundedCents: 500, refundCount: 1 });
    };
    expectReadModels();
    store.app.rebuildReadModels();
    expectReadModels();

    expect(store.versionsOtherThanOne()).toEqual([]);
  });
});
