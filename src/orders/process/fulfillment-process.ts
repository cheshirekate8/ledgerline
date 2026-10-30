import { InventoryCommand } from '../../inventory/inventory-commands';
import { InventoryItemNotFoundError } from '../../inventory/inventory-errors';
import { ReleaseReason } from '../../inventory/inventory-events';
import { InventoryRepository } from '../../inventory/inventory-repository';
import { LinePricing } from '../../pricing/pricing-types';
import { CommandDispatcher } from '../../shared/commands/command';
import { StoredEvent } from '../../shared/events/domain-event';
import { EventSubscriber } from '../../shared/messaging/event-dispatcher';
import { OrderCommand } from '../order-commands';
import { ORDER_AGGREGATE, OrderCancelled, OrderEvent, OrderLineRefunded, OrderPaid, OrderPlaced } from '../order-events';
import { OrderRepository } from '../order-repository';

export interface FulfillmentProcessDependencies {
  readonly commands: CommandDispatcher<OrderCommand | InventoryCommand>;
  readonly orders: OrderRepository;
  readonly inventory: InventoryRepository;
}

/**
 * Keeps inventory in step with orders. A placed order reserves stock for
 * each SKU and becomes payable once every reservation is held, or is
 * cancelled as out of stock; a paid order confirms its reservations; a
 * cancelled or expired order releases them; and a refund of units that never
 * shipped returns them.
 *
 * Every command it sends uses an idempotency key derived from the event
 * that caused it, so a redelivered event repeats nothing.
 */
export class FulfillmentProcess implements EventSubscriber {
  readonly name = 'order-fulfillment';
  readonly aggregateTypes = [ORDER_AGGREGATE];

  constructor(private readonly dependencies: FulfillmentProcessDependencies) {}

  async handle(stored: StoredEvent): Promise<void> {
    const event = stored as StoredEvent<OrderEvent>;
    switch (event.type) {
      case 'OrderPlaced':
        return this.reserveStock(event);
      case 'OrderPaid':
        return this.confirmStock(event);
      case 'OrderCancelled':
        return this.releaseStock(event);
      case 'OrderLineRefunded':
        return this.returnStock(event);
      default:
        return undefined;
    }
  }

  private async reserveStock(event: StoredEvent<OrderPlaced>): Promise<void> {
    const { commands, orders, inventory } = this.dependencies;
    const orderId = event.aggregateId;
    if (orders.load(orderId)?.status !== 'Placed') {
      return;
    }
    let shortfall = false;
    for (const [sku, quantity] of quantitiesBySku(event.payload.pricing.lines)) {
      try {
        await commands.execute({
          type: 'ReserveStock',
          idempotencyKey: `${event.eventId}:reserve:${sku}`,
          payload: { sku, orderId, quantity, expiresAt: event.payload.reservationExpiresAt },
          ...causedBy(event),
        });
      } catch (error) {
        if (!(error instanceof InventoryItemNotFoundError)) {
          throw error;
        }
        shortfall = true;
        continue;
      }
      const item = inventory.load(sku);
      if (!item?.reservationFor(orderId) && item?.outcomeFor(orderId) !== 'confirmed') {
        shortfall = true;
      }
    }

    if (shortfall) {
      await commands.execute({
        type: 'CancelOrder',
        idempotencyKey: `${event.eventId}:cancel-out-of-stock`,
        payload: { orderId, reason: 'out-of-stock' },
        ...causedBy(event),
      });
      return;
    }
    await commands.execute({
      type: 'RecordOrderStockReserved',
      idempotencyKey: `${event.eventId}:stock-reserved`,
      payload: { orderId },
      ...causedBy(event),
    });
  }

  private async confirmStock(event: StoredEvent<OrderPaid>): Promise<void> {
    for (const sku of this.orderSkus(event.aggregateId)) {
      await this.dependencies.commands.execute({
        type: 'ConfirmStockReservation',
        idempotencyKey: `${event.eventId}:confirm:${sku}`,
        payload: { sku, orderId: event.aggregateId },
        ...causedBy(event),
      });
    }
  }

  private async releaseStock(event: StoredEvent<OrderCancelled>): Promise<void> {
    const reason: ReleaseReason =
      event.payload.reason === 'reservation-expired' ? 'reservation-expired' : 'order-cancelled';
    for (const sku of this.orderSkus(event.aggregateId)) {
      try {
        await this.dependencies.commands.execute({
          type: 'ReleaseStock',
          idempotencyKey: `${event.eventId}:release:${sku}`,
          payload: { sku, orderId: event.aggregateId, reason },
          ...causedBy(event),
        });
      } catch (error) {
        if (!(error instanceof InventoryItemNotFoundError)) {
          throw error;
        }
      }
    }
  }

  /**
   * Returns refunded units to stock when the refund event says they never
   * shipped. The answer is the one the order gave at refund time (§3.2): by now
   * the order may well have shipped, and reading its status would get it wrong.
   */
  private async returnStock(event: StoredEvent<OrderLineRefunded>): Promise<void> {
    const { lineId, refundId, refund, returnsToStock } = event.payload;
    if (!returnsToStock) {
      return;
    }
    const sku = this.lineSku(event.aggregateId, lineId);
    await this.dependencies.commands.execute({
      type: 'ReturnStock',
      idempotencyKey: `${event.eventId}:return:${sku}`,
      payload: { sku, orderId: event.aggregateId, refundId, quantity: refund.quantity },
      ...causedBy(event),
    });
  }

  /** The SKU a refunded line was priced for; pricing is fixed at placement. */
  private lineSku(orderId: string, lineId: string): string {
    const pricing = this.dependencies.orders.load(orderId)?.pricing;
    const sku = pricing?.lines.find((line) => line.lineId === lineId)?.sku;
    if (sku === undefined) {
      throw new Error(`Order ${orderId} has no priced line ${lineId}`);
    }
    return sku;
  }

  private orderSkus(orderId: string): string[] {
    const pricing = this.dependencies.orders.load(orderId)?.pricing;
    return pricing ? [...quantitiesBySku(pricing.lines).keys()] : [];
  }
}

/** Total quantity per SKU; an order may hold several lines of the same SKU. */
export function quantitiesBySku(lines: readonly LinePricing[]): Map<string, number> {
  const quantities = new Map<string, number>();
  for (const line of lines) {
    quantities.set(line.sku, (quantities.get(line.sku) ?? 0) + line.quantity);
  }
  return quantities;
}

export function causedBy(event: StoredEvent): { correlationId: string; causationId: string } {
  return { correlationId: event.metadata.correlationId ?? event.aggregateId, causationId: event.eventId };
}
