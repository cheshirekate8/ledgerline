import { PendingReservationIndex } from '../../../src/orders/pending-reservations';
import { InMemoryEventStore } from '../../../src/shared/events/in-memory-event-store';
import { newEvent } from '../../support/counter';

const T0 = Date.parse('2026-06-01T09:00:00.000Z');
const MINUTE = 60_000;

function expiresAt(offsetMinutes: number): string {
  return new Date(T0 + offsetMinutes * MINUTE).toISOString();
}

/** Appends the next event of an order's stream, tracking its sequence. */
function appender(store: InMemoryEventStore) {
  const sequences = new Map<string, number>();
  return (orderId: string, type: string, payload: unknown = {}) => {
    const sequence = sequences.get(orderId) ?? 0;
    store.append('order', orderId, sequence, [newEvent(type, payload)]);
    sequences.set(orderId, sequence + 1);
  };
}

/** Creates `orderId`, then places it with an expiry `offsetMinutes` after T0. */
function placedOrder(append: ReturnType<typeof appender>, orderId: string, offsetMinutes: number): void {
  append(orderId, 'OrderCreated', { customerId: `customer-${orderId}`, shippingRegion: 'US-OR' });
  append(orderId, 'OrderPlaced', { pricing: null, reservationExpiresAt: expiresAt(offsetMinutes) });
}

describe('PendingReservationIndex', () => {
  it('offers only orders awaiting payment whose recorded expiry has been reached', () => {
    const store = new InMemoryEventStore();
    const append = appender(store);
    const index = new PendingReservationIndex(store);

    append('draft', 'OrderCreated', { customerId: 'c-1', shippingRegion: 'US-OR' });
    placedOrder(append, 'soon', 10);
    placedOrder(append, 'later', 20);
    placedOrder(append, 'paid', 5);
    append('paid', 'OrderPaid', { paymentId: 'pay-1', amountCents: 1_000 });
    placedOrder(append, 'cancelled', 5);
    append('cancelled', 'OrderCancelled', { reason: 'customer-request' });

    expect(index.dueAt(T0 + 10 * MINUTE - 1)).toEqual([]);
    expect(index.dueAt(T0 + 10 * MINUTE)).toEqual(['soon']);
    expect(index.dueAt(T0 + 20 * MINUTE)).toEqual(['soon', 'later']);
  });

  it('offers candidates in the order the orders were created, not the order they were placed', () => {
    const store = new InMemoryEventStore();
    const append = appender(store);
    const index = new PendingReservationIndex(store);

    append('X', 'OrderCreated', { customerId: 'c-x', shippingRegion: 'US-OR' });
    append('Y', 'OrderCreated', { customerId: 'c-y', shippingRegion: 'US-OR' });
    append('Y', 'OrderPlaced', { pricing: null, reservationExpiresAt: expiresAt(10) });
    append('X', 'OrderPlaced', { pricing: null, reservationExpiresAt: expiresAt(11) });

    expect(index.dueAt(T0 + 20 * MINUTE)).toEqual(['X', 'Y']);
  });

  it('rebuilds from the log when it is opened over a store that already has events', () => {
    const store = new InMemoryEventStore();
    const append = appender(store);
    placedOrder(append, 'open', 15);
    placedOrder(append, 'closed', 15);
    append('closed', 'OrderCancelled', { reason: 'reservation-expired' });

    expect(new PendingReservationIndex(store).dueAt(T0 + 15 * MINUTE)).toEqual(['open']);
  });

  it('drops an order the moment it is cancelled, so a sweep cannot offer it twice', () => {
    const store = new InMemoryEventStore();
    const append = appender(store);
    const index = new PendingReservationIndex(store);
    placedOrder(append, 'o-1', 15);

    expect(index.dueAt(T0 + 15 * MINUTE)).toEqual(['o-1']);
    append('o-1', 'OrderCancelled', { reason: 'reservation-expired' });
    expect(index.dueAt(T0 + 15 * MINUTE)).toEqual([]);
  });

  it('stops following the store once closed', () => {
    const store = new InMemoryEventStore();
    const append = appender(store);
    const index = new PendingReservationIndex(store);
    index.close();

    placedOrder(append, 'o-1', 15);
    expect(index.dueAt(T0 + 15 * MINUTE)).toEqual([]);
    expect(() => index.close()).not.toThrow();
  });
});
