import { StoredEvent } from '../shared/events/domain-event';
import { EventStore } from '../shared/events/event-store';
import { hasReached } from '../shared/time';
import { ORDER_AGGREGATE, OrderPlaced } from './order-events';

/** An order that is still open: created, and neither paid nor cancelled. */
interface OpenOrder {
  /** Global position of the order's first event, which is its place in creation order. */
  readonly createdPosition: number;
  /** The expiry recorded when the order was placed; null while it is still a draft. */
  readonly expiresAt: string | null;
}

/**
 * The orders a sweep still has to consider, with the reservation expiry each
 * recorded when it was placed (DESIGN §4.4). It is rebuilt from the log when the
 * store opens and then follows the store's own appends, so a sweep neither reads
 * the whole log nor walks every order id, and an order placed and already overdue
 * is a candidate before any message has been processed.
 *
 * Only open orders are kept: a paid or cancelled order is dropped, so the index
 * costs what is awaiting payment rather than what is past.
 *
 * It reads the type of `OrderCreated`, `OrderPaid` and `OrderCancelled` and the
 * `reservationExpiresAt` of `OrderPlaced`. All four are at v1, so stored payloads
 * need no upcasting; a version bump of one of them must be reflected here (§2.3).
 */
export class PendingReservationIndex {
  private readonly openOrders = new Map<string, OpenOrder>();
  private unsubscribe: (() => void) | undefined;

  /** Rebuilds the index from `store` and follows every later append. */
  constructor(store: EventStore) {
    this.apply(store.readAll());
    this.unsubscribe = store.subscribe(this.apply);
  }

  /**
   * The ids of the orders awaiting payment whose recorded expiry has been reached
   * at `now`, in the order the orders were created (§4.4). The result is a
   * snapshot, so expiring the orders it names while iterating it is safe.
   */
  dueAt(now: number): string[] {
    const due: { readonly orderId: string; readonly createdPosition: number }[] = [];
    for (const [orderId, order] of this.openOrders) {
      if (order.expiresAt !== null && hasReached(now, order.expiresAt)) {
        due.push({ orderId, createdPosition: order.createdPosition });
      }
    }
    due.sort((left, right) => left.createdPosition - right.createdPosition);
    return due.map((candidate) => candidate.orderId);
  }

  /** Stops following the store's appends. */
  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private readonly apply = (events: readonly StoredEvent[]): void => {
    for (const event of events) {
      if (event.aggregateType !== ORDER_AGGREGATE) {
        continue;
      }
      switch (event.type) {
        case 'OrderCreated':
          this.openOrders.set(event.aggregateId, { createdPosition: event.position, expiresAt: null });
          break;
        case 'OrderPlaced': {
          const createdPosition = this.openOrders.get(event.aggregateId)?.createdPosition ?? event.position;
          const { reservationExpiresAt } = event.payload as OrderPlaced['payload'];
          this.openOrders.set(event.aggregateId, { createdPosition, expiresAt: reservationExpiresAt });
          break;
        }
        case 'OrderPaid':
        case 'OrderCancelled':
          this.openOrders.delete(event.aggregateId);
          break;
        default:
          break;
      }
    }
  };
}
