// Criterion 2: refunded units of a Paid order go back into stock, recorded as one
// StockReturned per refund, and the returned units really are sellable again.
import { openStore, payloadOf } from './harness';

describe('criterion 2: a Paid order refund returns its units to stock', () => {
  it('raises on-hand and available by the refunded quantity, recorded as StockReturned', async () => {
    const store = openStore();
    await store.stock('MUG', 3);
    await store.paidOrder('A', [['MUG', 3]]);
    expect(store.level('MUG')).toEqual({ onHand: 0, reserved: 0, available: 0 });
    const receivedBefore = store.events('StockReceived').length;

    await store.refund('A', 'A-l1', 2, 'r-1');
    await store.settle();

    expect(store.level('MUG')).toEqual({ onHand: 2, reserved: 0, available: 2 });
    const returned = store.events('StockReturned');
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({ aggregateType: 'inventory-item', aggregateId: 'MUG', version: 1 });
    expect(payloadOf(returned[0]!)).toEqual({ orderId: 'A', refundId: 'r-1', quantity: 2 });
    expect(store.events('StockReceived')).toHaveLength(receivedBefore);

    store.app.rebuildReadModels();
    expect(store.level('MUG')).toEqual({ onHand: 2, reserved: 0, available: 2 });
  });

  it('lets a later order reserve the returned units, but no more than were returned', async () => {
    const store = openStore();
    await store.stock('MUG', 3);
    await store.paidOrder('A', [['MUG', 3]]);
    await store.refund('A', 'A-l1', 2, 'r-1');
    await store.settle();

    for (const [orderId, quantity] of [
      ['B', 2],
      ['C', 1],
    ] as const) {
      await store.run('CreateOrder', { orderId, customerId: 'bob', shippingRegion: 'US-OR' });
      await store.run('AddOrderLine', { orderId, sku: 'MUG', quantity, lineId: `${orderId}-l1` });
      await store.run('PlaceOrder', { orderId });
      await store.settle();
    }

    expect(store.app.readModels.orderSummary.get('B')).toMatchObject({ status: 'Placed', stockReserved: true });
    expect(store.app.readModels.orderSummary.get('C')).toMatchObject({
      status: 'Cancelled',
      cancellationReason: 'out-of-stock',
    });
    expect(store.level('MUG')).toEqual({ onHand: 2, reserved: 2, available: 0 });
  });

  it('returns every line of a fully refunded Paid order, which moves to Refunded', async () => {
    const store = openStore();
    await store.stock('MUG', 5);
    await store.stock('CUP', 5);
    await store.paidOrder('A', [
      ['MUG', 2],
      ['CUP', 3],
    ]);
    expect(store.level('MUG').onHand).toBe(3);
    expect(store.level('CUP').onHand).toBe(2);

    await store.refund('A', 'A-l1', 2, 'r-mug');
    await store.refund('A', 'A-l2', 3, 'r-cup');
    await store.settle();

    expect(store.app.readModels.orderSummary.get('A')!.status).toBe('Refunded');
    expect(store.level('MUG')).toEqual({ onHand: 5, reserved: 0, available: 5 });
    expect(store.level('CUP')).toEqual({ onHand: 5, reserved: 0, available: 5 });
    const returned = store.events('StockReturned').map((event) => [event.aggregateId, payloadOf(event)]);
    expect(returned).toHaveLength(2);
    expect(returned).toEqual(
      expect.arrayContaining([
        ['MUG', { orderId: 'A', refundId: 'r-mug', quantity: 2 }],
        ['CUP', { orderId: 'A', refundId: 'r-cup', quantity: 3 }],
      ]),
    );
  });
});
