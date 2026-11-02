// Scenarios shared by these tests.
import { StoredEvent } from '../../../src/shared/events/domain-event';
import { CountingStore, MINUTE, Store, TTL } from './harness';

/**
 * One order of every kind, then two placed orders: P2 overdue at the end, P1 not.
 * `extraClosed` adds that many paid orders, which a sweep must not cost anything for.
 */
export async function orderOfEveryKind(store: Store, extraClosed = 0): Promise<void> {
  const { run, settle, clock } = store;
  await store.stock('MUG', 500);
  await store.stock('CUP', 1);

  await run('CreateOrder', { orderId: 'draft', customerId: 'customer-draft', shippingRegion: 'US-OR' }, 'draft-create');
  await run('AddOrderLine', { orderId: 'draft', sku: 'MUG', quantity: 1, lineId: 'draft-l1' }, 'draft-line');

  await store.paid('paid');
  await store.paid('delivered');
  await run('ShipOrder', { orderId: 'delivered', trackingNumber: 'TRK-1' }, 'delivered-ship');
  await run('DeliverOrder', { orderId: 'delivered' }, 'delivered-deliver');
  await store.paid('refunded');
  await run('RefundOrderLine', { orderId: 'refunded', lineId: 'refunded-l1', quantity: 1, refundId: 'r1' }, 'refunded-refund');
  await store.place('cancelled');
  await settle();
  await run('CancelOrder', { orderId: 'cancelled', reason: 'customer-request' }, 'cancelled-cancel');
  await store.place('out-of-stock', 5, 'CUP');
  await settle();

  await store.place('expired-earlier');
  await settle();
  clock.advance(TTL);
  await store.app.expireReservations();
  await settle();

  for (let index = 0; index < extraClosed; index += 1) {
    await store.paid(`closed-${index}`);
  }

  await store.place('P2');
  await settle();
  clock.advance(10 * MINUTE);
  await store.place('P1');
  await settle();
  clock.advance(5 * MINUTE);
}

/**
 * A fixed script with several sweeps among payments, cancellations and an out-of-stock
 * order. Returns each sweep's result, in order.
 */
export async function mixedScript(store: Store): Promise<string[][]> {
  const { run, settle, clock } = store;
  const sweeps: string[][] = [];
  const sweep = async () => {
    sweeps.push(await store.app.expireReservations());
    await settle();
  };
  await store.stock('MUG', 6);
  await store.stock('CUP', 2);
  await store.place('m1');
  await settle();
  await store.place('m2', 2);
  clock.advance(5 * MINUTE);
  await store.place('c1', 3, 'CUP');
  await settle();
  await store.paid('p1');
  await sweep();
  clock.advance(10 * MINUTE);
  await sweep();
  await store.place('m3');
  await run('CancelOrder', { orderId: 'm3', reason: 'customer-request' }, 'm3-cancel');
  await store.place('m4');
  await settle();
  clock.advance(7 * MINUTE);
  await store.paid('p2');
  await sweep();
  clock.advance(8 * MINUTE);
  await sweep();
  await sweep();
  return sweeps;
}

/** The core fields of stored events, ready to append to a fresh store in log order. */
export function refill(target: CountingStore, events: readonly StoredEvent[]): void {
  for (const event of events) {
    const { type, version, payload, eventId, occurredAt, metadata } = event;
    target.append(event.aggregateType, event.aggregateId, event.sequence - 1, [
      { type, version, payload, eventId, occurredAt, metadata } as never,
    ]);
  }
}
