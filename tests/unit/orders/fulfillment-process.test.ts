import { FulfillmentProcess, quantitiesBySku } from '../../../src/orders/process/fulfillment-process';
import { LinePricing } from '../../../src/pricing/pricing-types';
import { domainHarness } from '../../support/domain-harness';

function setup() {
  const harness = domainHarness();
  const process = new FulfillmentProcess({
    commands: harness.bus,
    orders: harness.orders,
    inventory: harness.inventory,
  });
  return { ...harness, process };
}

describe('FulfillmentProcess', () => {
  it('reserves stock for a placed order and makes it payable', async () => {
    const { stock, placeOrder, process, lastEvent, inventory, orders } = setup();
    await stock('MUG', 10);
    await stock('TEE', 5);
    await placeOrder('o-1', [
      ['MUG', 2],
      ['TEE', 1],
      ['MUG', 1],
    ]);

    await process.handle(lastEvent('OrderPlaced'));
    expect(inventory.load('MUG')!.reservationFor('o-1')).toEqual({
      quantity: 3,
      expiresAt: '2026-06-01T09:15:00.000Z',
    });
    expect(inventory.load('TEE')!.reserved).toBe(1);
    expect(orders.load('o-1')!.stockReserved).toBe(true);
  });

  it('cancels the order as out of stock when any SKU cannot be reserved', async () => {
    const { stock, placeOrder, process, lastEvent, inventory, orders } = setup();
    await stock('MUG', 10);
    await stock('TEE', 0);
    await placeOrder('o-1', [
      ['MUG', 2],
      ['TEE', 1],
    ]);

    await process.handle(lastEvent('OrderPlaced'));
    const order = orders.load('o-1')!;
    expect(order.status).toBe('Cancelled');
    expect(order.stockReserved).toBe(false);

    await process.handle(lastEvent('OrderCancelled'));
    expect(inventory.load('MUG')!.available).toBe(10);
  });

  it('treats a SKU with no inventory record as out of stock', async () => {
    const { stock, placeOrder, process, lastEvent, orders } = setup();
    await stock('MUG', 10);
    await placeOrder('o-1', [['POSTER', 1]]);
    await process.handle(lastEvent('OrderPlaced'));
    expect(orders.load('o-1')!.status).toBe('Cancelled');
    await expect(process.handle(lastEvent('OrderCancelled'))).resolves.toBeUndefined();
  });

  it('does nothing for a redelivered OrderPlaced', async () => {
    const { stock, placeOrder, process, lastEvent, inventory, store } = setup();
    await stock('MUG', 10);
    await placeOrder('o-1', [['MUG', 2]]);
    const placed = lastEvent('OrderPlaced');
    await process.handle(placed);
    const eventCount = store.readAll().length;
    await process.handle(placed);
    expect(store.readAll()).toHaveLength(eventCount);
    expect(inventory.load('MUG')!.reserved).toBe(2);
  });

  it('skips reserving for an order cancelled before the event was handled', async () => {
    const { stock, placeOrder, process, lastEvent, inventory, run } = setup();
    await stock('MUG', 10);
    await placeOrder('o-1', [['MUG', 2]]);
    await run({ type: 'CancelOrder', payload: { orderId: 'o-1', reason: 'customer-request' } });
    await process.handle(lastEvent('OrderPlaced'));
    expect(inventory.load('MUG')!.reserved).toBe(0);
  });

  it('confirms reservations once the order is paid', async () => {
    const { stock, placeOrder, process, lastEvent, inventory, run, orders } = setup();
    await stock('MUG', 10);
    await placeOrder('o-1', [['MUG', 2]]);
    await process.handle(lastEvent('OrderPlaced'));
    const total = orders.load('o-1')!.totalCents;
    await run({ type: 'MarkOrderPaid', payload: { orderId: 'o-1', paymentId: 'p-1', amountCents: total } });

    await process.handle(lastEvent('OrderPaid'));
    const item = inventory.load('MUG')!;
    expect({ onHand: item.onHand, reserved: item.reserved }).toEqual({ onHand: 8, reserved: 0 });
  });

  it('releases reservations of an expired order with the expiry reason', async () => {
    const { stock, placeOrder, process, lastEvent, inventory, run, clock } = setup();
    await stock('MUG', 10);
    await placeOrder('o-1', [['MUG', 2]]);
    await process.handle(lastEvent('OrderPlaced'));
    clock.advance(15 * 60_000);
    await run({ type: 'ExpireOrderReservation', payload: { orderId: 'o-1' } });

    await process.handle(lastEvent('OrderCancelled'));
    expect(inventory.load('MUG')!.available).toBe(10);
    expect(lastEvent('StockReservationReleased').payload).toMatchObject({ reason: 'reservation-expired' });
  });

  it('carries correlation and causation ids onto the commands it sends', async () => {
    const { stock, placeOrder, process, lastEvent } = setup();
    await stock('MUG', 10);
    await placeOrder('o-1', [['MUG', 1]]);
    const placed = lastEvent('OrderPlaced');
    await process.handle(placed);
    expect(lastEvent('StockReserved').metadata).toMatchObject({ correlationId: 'o-1', causationId: placed.eventId });
  });
});

describe('quantitiesBySku', () => {
  it('sums quantities of lines that share a SKU', () => {
    const lines = [
      { sku: 'A', quantity: 2 },
      { sku: 'B', quantity: 1 },
      { sku: 'A', quantity: 3 },
    ] as LinePricing[];
    expect([...quantitiesBySku(lines)]).toEqual([
      ['A', 5],
      ['B', 1],
    ]);
  });
});
