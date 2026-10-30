import { StoredEvent } from '../shared/events/domain-event';
import { Cents, cents } from '../shared/money';
import { Projection } from '../shared/projections/projection';
import { CancellationReason, ORDER_AGGREGATE, OrderEvent } from './order-events';
import { OrderStatus } from './order-status';

export interface OrderSummary {
  readonly orderId: string;
  readonly customerId: string;
  readonly shippingRegion: string;
  readonly status: OrderStatus;
  readonly lineCount: number;
  readonly itemCount: number;
  readonly subtotalCents: Cents;
  readonly discountCents: Cents;
  readonly couponCents: Cents;
  readonly taxCents: Cents;
  readonly totalCents: Cents;
  readonly refundedCents: Cents;
  readonly stockReserved: boolean;
  readonly reservationExpiresAt: string | null;
  readonly paymentId: string | null;
  readonly trackingNumber: string | null;
  readonly cancellationReason: CancellationReason | null;
  readonly createdAt: string;
  readonly placedAt: string | null;
  readonly paidAt: string | null;
  readonly shippedAt: string | null;
  readonly deliveredAt: string | null;
  readonly closedAt: string | null;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** One row per order with its status, money and lifecycle timestamps. */
export class OrderSummaryProjection implements Projection {
  readonly name: string = 'order-summary';
  readonly aggregateTypes = [ORDER_AGGREGATE];
  private orders = new Map<string, Mutable<OrderSummary>>();
  private draftLines = new Map<string, Map<string, number>>();

  apply(stored: StoredEvent): void {
    const event = stored as StoredEvent<OrderEvent>;
    const at = event.occurredAt;
    if (event.type === 'OrderCreated') {
      this.orders.set(event.aggregateId, emptySummary(event.aggregateId, event.payload, at));
      this.draftLines.set(event.aggregateId, new Map());
      return;
    }
    const summary = this.orders.get(event.aggregateId);
    if (!summary) {
      return;
    }
    switch (event.type) {
      case 'OrderLineAdded':
        this.draftLines.get(event.aggregateId)!.set(event.payload.lineId, event.payload.quantity);
        this.recountLines(summary);
        break;
      case 'OrderLineRemoved':
        this.draftLines.get(event.aggregateId)!.delete(event.payload.lineId);
        this.recountLines(summary);
        break;
      case 'OrderPlaced': {
        const { pricing, reservationExpiresAt } = event.payload;
        Object.assign(summary, {
          status: 'Placed',
          placedAt: at,
          reservationExpiresAt,
          subtotalCents: pricing.subtotalCents,
          discountCents: pricing.discountCents,
          couponCents: pricing.couponCents,
          taxCents: pricing.taxCents,
          totalCents: pricing.totalCents,
        });
        break;
      }
      case 'OrderStockReserved':
        summary.stockReserved = true;
        break;
      case 'OrderPaid':
        Object.assign(summary, { status: 'Paid', paidAt: at, paymentId: event.payload.paymentId });
        break;
      case 'OrderShipped':
        Object.assign(summary, { status: 'Shipped', shippedAt: at, trackingNumber: event.payload.trackingNumber });
        break;
      case 'OrderDelivered':
        Object.assign(summary, { status: 'Delivered', deliveredAt: at });
        break;
      case 'OrderCancelled':
        Object.assign(summary, { status: 'Cancelled', closedAt: at, cancellationReason: event.payload.reason });
        break;
      case 'OrderLineRefunded':
        summary.refundedCents = cents(summary.refundedCents + event.payload.refund.totalCents);
        break;
      case 'OrderRefunded':
        Object.assign(summary, { status: 'Refunded', closedAt: at });
        break;
      case 'DiscountCodeApplied':
      case 'CouponApplied':
        break;
    }
  }

  reset(): void {
    this.orders = new Map();
    this.draftLines = new Map();
  }

  get(orderId: string): OrderSummary | undefined {
    const summary = this.orders.get(orderId);
    return summary ? { ...summary } : undefined;
  }

  all(): OrderSummary[] {
    return [...this.orders.values()].map((summary) => ({ ...summary }));
  }

  withStatus(status: OrderStatus): OrderSummary[] {
    return this.all().filter((summary) => summary.status === status);
  }

  private recountLines(summary: Mutable<OrderSummary>): void {
    const lines = this.draftLines.get(summary.orderId)!;
    summary.lineCount = lines.size;
    summary.itemCount = [...lines.values()].reduce((total, quantity) => total + quantity, 0);
  }
}

function emptySummary(
  orderId: string,
  payload: { customerId: string; shippingRegion: string },
  createdAt: string,
): Mutable<OrderSummary> {
  return {
    orderId,
    customerId: payload.customerId,
    shippingRegion: payload.shippingRegion,
    status: 'Draft',
    lineCount: 0,
    itemCount: 0,
    subtotalCents: cents(0),
    discountCents: cents(0),
    couponCents: cents(0),
    taxCents: cents(0),
    totalCents: cents(0),
    refundedCents: cents(0),
    stockReserved: false,
    reservationExpiresAt: null,
    paymentId: null,
    trackingNumber: null,
    cancellationReason: null,
    createdAt,
    placedAt: null,
    paidAt: null,
    shippedAt: null,
    deliveredAt: null,
    closedAt: null,
  };
}
