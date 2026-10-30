// Criterion 3: fulfillment acts on what the refund event recorded, not on the order's
// status at the moment the event is processed.
import { openStore, payloadOf } from './harness';

describe('criterion 3: the decision is the one made at refund time', () => {
  it('returns units refunded while Paid even if the order ships before the refund is processed', async () => {
    const store = openStore();
    await store.stock('MUG', 5);
    await store.paidOrder('A', [['MUG', 4]]);
    expect(store.level('MUG').onHand).toBe(1);

    await store.refund('A', 'A-l1', 1, 'r-1');
    await store.run('ShipOrder', { orderId: 'A', trackingNumber: 'T-1' });
    await store.settle();

    expect(store.app.readModels.orderSummary.get('A')!.status).toBe('Shipped');
    expect(store.level('MUG')).toEqual({ onHand: 2, reserved: 0, available: 2 });
    expect(store.events('StockReturned')).toHaveLength(1);
  });

  it('returns nothing for a refund made after the order shipped', async () => {
    const store = openStore();
    await store.stock('MUG', 5);
    await store.paidOrder('A', [['MUG', 4]]);
    await store.refund('A', 'A-l1', 1, 'r-1');
    await store.run('ShipOrder', { orderId: 'A', trackingNumber: 'T-1' });
    await store.settle();

    await store.refund('A', 'A-l1', 1, 'r-2');
    await store.settle();

    expect(store.level('MUG')).toEqual({ onHand: 2, reserved: 0, available: 2 });
    expect(store.events('StockReturned').map((event) => payloadOf(event)['refundId'])).toEqual(['r-1']);
    const second = store.events('OrderLineRefunded').find((event) => payloadOf(event)['refundId'] === 'r-2')!;
    expect(payloadOf(second)['returnsToStock']).toBe(false);
  });
});
