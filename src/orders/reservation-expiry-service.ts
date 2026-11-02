import { Clock } from '../shared/clock';
import { CommandDispatcher } from '../shared/commands/command';
import { isDomainError } from '../shared/errors';
import { EventStore } from '../shared/events/event-store';
import { Logger, silentLogger } from '../shared/logger';
import { hasReached } from '../shared/time';
import { ExpireOrderReservation } from './order-commands';
import { OrderRepository } from './order-repository';
import { PendingReservationIndex } from './pending-reservations';

export interface ReservationExpiryDependencies {
  readonly store: EventStore;
  readonly orders: OrderRepository;
  readonly commands: CommandDispatcher<ExpireOrderReservation>;
  readonly clock: Clock;
  readonly logger?: Logger;
}

/**
 * Finds placed orders that were not paid within their reservation window
 * and expires them. The order aggregate decides; this service only finds
 * candidates, so running it twice or concurrently with a payment is safe.
 * Expiring an order releases its stock through the fulfillment process.
 *
 * Candidates come from an index of the orders awaiting payment, so a sweep
 * costs what is pending rather than the whole order history (DESIGN §4.4).
 */
export class ReservationExpiryService {
  private readonly logger: Logger;
  private readonly pending: PendingReservationIndex;

  constructor(private readonly dependencies: ReservationExpiryDependencies) {
    this.logger = dependencies.logger ?? silentLogger;
    this.pending = new PendingReservationIndex(dependencies.store);
  }

  /** Expires every overdue order and returns their ids. */
  async expireDue(): Promise<string[]> {
    const { orders, commands, clock } = this.dependencies;
    const now = clock.now();
    const expired: string[] = [];
    for (const orderId of this.pending.dueAt(now)) {
      const order = orders.load(orderId);
      const expiresAt = order?.reservationExpiresAt;
      if (order?.status !== 'Placed' || !expiresAt || !hasReached(now, expiresAt)) {
        continue;
      }
      try {
        await commands.execute({
          type: 'ExpireOrderReservation',
          idempotencyKey: `expire-reservation:${orderId}`,
          payload: { orderId },
        });
      } catch (error) {
        if (isDomainError(error)) {
          continue;
        }
        throw error;
      }
      expired.push(orderId);
      this.logger.info('order.reservation_expired', { orderId, expiresAt });
    }
    return expired;
  }

  /** Stops following the event store's appends. */
  close(): void {
    this.pending.close();
  }
}
