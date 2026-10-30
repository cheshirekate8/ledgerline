// Criterion 5: MarkOrderPaid for the payment an order already accepted is a no-op in every
// later status, decided by the order itself rather than by a remembered key. The second
// test is a [guard]: naming any other payment is still refused, so a second payment for
// an already-paid order is still compensated (§4.3).
import { openStore, refusal } from './harness';

async function ordersInLaterStatuses() {
  const store = openStore();
  await store.stock('MUG', 10);
  await store.paidOrder('paid', [['MUG', 1]]);
  await store.paidOrder('shipped', [['MUG', 1]]);
  await store.run('ShipOrder', { orderId: 'shipped', trackingNumber: 'TRK-1' }, 'ship-shipped');
  await store.paidOrder('delivered', [['MUG', 1]]);
  await store.run('ShipOrder', { orderId: 'delivered', trackingNumber: 'TRK-2' }, 'ship-delivered');
  await store.run('DeliverOrder', { orderId: 'delivered' }, 'deliver-delivered');
  await store.paidOrder('refunded', [['MUG', 1]]);
  await store.run('ShipOrder', { orderId: 'refunded', trackingNumber: 'TRK-3' }, 'ship-refunded');
  await store.run('DeliverOrder', { orderId: 'refunded' }, 'deliver-refunded');
  await store.run('RefundOrderLine', { orderId: 'refunded', lineId: 'refunded-l1', quantity: 1, refundId: 'r1' }, 'refund-refunded');
  await store.settle();
  return store;
}

describe('criterion 5: MarkOrderPaid for the accepted payment', () => {
  it('does nothing for a Shipped, a Delivered or a Refunded order, under a fresh key', async () => {
    const store = await ordersInLaterStatuses();
    const refunds = () => store.app.store.readAll().filter((event) => event.type === 'PaymentRefunded').length;
    const refundsBefore = refunds();

    for (const [orderId, status] of [
      ['shipped', 'Shipped'],
      ['delivered', 'Delivered'],
      ['refunded', 'Refunded'],
    ] as const) {
      expect(store.app.readModels.orderSummary.get(orderId)!.status).toBe(status);
      const logLength = store.app.store.readAll().length;
      const result = await store.run(
        'MarkOrderPaid',
        { orderId, paymentId: `pay-${orderId}`, amountCents: 1_000 },
        `fresh-mark-${orderId}`,
      );
      expect(result.duplicate).toBe(false);
      expect(result.eventIds).toEqual([]);
      expect(store.app.store.readAll()).toHaveLength(logLength);
    }
    await store.settle();
    expect(refunds()).toBe(refundsBefore);
    expect(store.app.deadLetters.list()).toEqual([]);
  });

  it('[guard] still refuses a different payment in every paid status', async () => {
    const store = await ordersInLaterStatuses();
    for (const orderId of ['paid', 'shipped', 'delivered', 'refunded']) {
      await refusal(
        store.run('MarkOrderPaid', { orderId, paymentId: 'pay-other', amountCents: 1_000 }, `other-mark-${orderId}`),
        'INVALID_ORDER_TRANSITION',
      );
    }
  });
});
