// Criterion 1: the order records, in a version 2 OrderLineRefunded, whether the refunded
// units return to stock; every other stored event stays at version 1.
// Updated when OrderLineRefunded moved to version 3 (DESIGN.md §5.4, change-log row
// refund-by-amount): the event is now written at v3 and still records returnsToStock.
import { openStore, payloadOf } from './harness';

describe('criterion 1: the refund event records the stock decision', () => {
  it('writes v2 with returnsToStock true for Paid, false for Shipped and Delivered', async () => {
    const store = openStore();
    await store.stock('MUG', 10);
    await store.paidOrder('paid', [['MUG', 2]]);
    await store.paidOrder('shipped', [['MUG', 2]]);
    await store.paidOrder('delivered', [['MUG', 2]]);
    await store.run('ShipOrder', { orderId: 'shipped', trackingNumber: 'T-1' });
    await store.run('ShipOrder', { orderId: 'delivered', trackingNumber: 'T-2' });
    await store.run('DeliverOrder', { orderId: 'delivered' });

    await store.refund('paid', 'paid-l1', 1, 'r-paid');
    await store.refund('shipped', 'shipped-l1', 1, 'r-shipped');
    await store.refund('delivered', 'delivered-l1', 1, 'r-delivered');
    await store.settle();

    const refunds = store.events('OrderLineRefunded');
    const byOrder = Object.fromEntries(refunds.map((event) => [event.aggregateId, event]));
    expect(refunds).toHaveLength(3);
    for (const [orderId, expected] of [
      ['paid', true],
      ['shipped', false],
      ['delivered', false],
    ] as const) {
      const event = byOrder[orderId]!;
      expect(event.version).toBe(3);
      expect(payloadOf(event)).toMatchObject({
        refundId: `r-${orderId}`,
        lineId: `${orderId}-l1`,
        paymentId: `pay-${orderId}`,
        returnsToStock: expected,
        refund: { quantity: 1, grossCents: 1_000, totalCents: 1_000 },
      });
    }
  });

  it('leaves every other stored event at version 1', async () => {
    const store = openStore();
    await store.stock('MUG', 10);
    await store.paidOrder('paid', [['MUG', 2]]);
    await store.refund('paid', 'paid-l1', 1, 'r-1');
    await store.settle();

    const others = store.app.store.readAll().filter((event) => event.type !== 'OrderLineRefunded');
    expect(others.length).toBeGreaterThan(0);
    expect(others.filter((event) => event.version !== 1).map((event) => `${event.type}@v${event.version}`)).toEqual([]);
  });
});
