// Criterion 5: credits are allowed in the refund statuses and refused elsewhere, input is
// validated, and the checks run in order: status, then input, then balance.
import { openStore, refusal, Store } from './harness';

async function placedOrder(store: Store, orderId: string): Promise<void> {
  await store.run('CreateOrder', { orderId, customerId: `customer-${orderId}`, shippingRegion: 'US-OR' });
  await store.run('AddOrderLine', { orderId, sku: 'MUG', quantity: 1, lineId: `${orderId}-l1` });
  await store.run('PlaceOrder', { orderId });
  await store.settle();
}

describe('criterion 5: credit statuses and validation', () => {
  it('credits Paid, Shipped and Delivered orders without changing their status', async () => {
    const store = openStore();
    await store.stock('MUG', 3);
    await store.paidOrder('paid', [['MUG', 1]]);
    await store.paidOrder('shipped', [['MUG', 1]]);
    await store.run('ShipOrder', { orderId: 'shipped', trackingNumber: 'TRACK-1' });
    await store.paidOrder('delivered', [['MUG', 1]]);
    await store.run('ShipOrder', { orderId: 'delivered', trackingNumber: 'TRACK-2' });
    await store.run('DeliverOrder', { orderId: 'delivered' });
    await store.settle();

    for (const [orderId, status] of [
      ['paid', 'Paid'],
      ['shipped', 'Shipped'],
      ['delivered', 'Delivered'],
    ] as const) {
      await store.credit(orderId, 100, 'sorry', `c-${orderId}`);
      await store.settle();
      expect(store.app.readModels.orderSummary.get(orderId)!.status).toBe(status);
      expect(store.paymentRefunds(orderId)).toEqual([{ refundId: `c-${orderId}`, amountCents: 100, reason: 'sorry' }]);
    }
  });

  it('refuses credits on unpaid, cancelled and refunded orders with ORDER_NOT_REFUNDABLE', async () => {
    const store = openStore();
    await store.stock('MUG', 3);
    await placedOrder(store, 'placed');
    await placedOrder(store, 'cancelled');
    await store.run('CancelOrder', { orderId: 'cancelled', reason: 'customer-request' });
    await store.paidOrder('refunded', [['MUG', 1]]);
    await store.refund('refunded', 'refunded-l1', 1, 'r-all');
    await store.settle();
    expect(store.app.readModels.orderSummary.get('cancelled')!.status).toBe('Cancelled');
    expect(store.app.readModels.orderSummary.get('refunded')!.status).toBe('Refunded');

    for (const orderId of ['placed', 'cancelled', 'refunded']) {
      await refusal(store.credit(orderId, 100, 'sorry', `c-${orderId}`), 'ORDER_NOT_REFUNDABLE');
    }
    // Status is checked before input: a zero amount on a cancelled order is a status refusal.
    await refusal(store.credit('cancelled', 0, 'sorry', 'c-zero'), 'ORDER_NOT_REFUNDABLE');
    await store.settle();
    expect(store.events('OrderCredited')).toEqual([]);
  });

  it('refuses a bad amount or reason with VALIDATION_FAILED, before checking the balance', async () => {
    const store = openStore();
    await store.stock('MUG', 3);
    await store.paidOrder('E', [['MUG', 3]]);

    for (const amountCents of [0, -5, 1.5]) {
      await refusal(store.credit('E', amountCents, 'sorry'), 'VALIDATION_FAILED');
    }
    for (const reason of ['', '   ']) {
      await refusal(store.credit('E', 100, reason), 'VALIDATION_FAILED');
    }
    // 3000.5 is above the 3000 balance and not whole cents: input is checked first.
    await refusal(store.credit('E', 3000.5, 'sorry'), 'VALIDATION_FAILED');
    await store.settle();

    expect(store.events('OrderCredited')).toEqual([]);
    expect(store.paymentRefunds('E')).toEqual([]);
  });
});
