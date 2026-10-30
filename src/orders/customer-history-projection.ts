import { StoredEvent } from '../shared/events/domain-event';
import { Cents, cents } from '../shared/money';
import { Projection } from '../shared/projections/projection';
import { ORDER_AGGREGATE, OrderEvent } from './order-events';
import { OrderStatus } from './order-status';

export interface CustomerOrder {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly placedAt: string;
  readonly totalCents: Cents;
  readonly paidCents: Cents;
  readonly refundedCents: Cents;
}

export interface CustomerHistory {
  readonly customerId: string;
  /** Placed orders, oldest first. Drafts are not part of a customer's history. */
  readonly orders: readonly CustomerOrder[];
  readonly orderCount: number;
  /** Everything paid, less everything refunded. */
  readonly lifetimeSpendCents: Cents;
}

type MutableOrder = { -readonly [K in keyof CustomerOrder]: CustomerOrder[K] };

/** Each customer's placed orders and what they have spent overall. */
export class CustomerHistoryProjection implements Projection {
  readonly name = 'customer-history';
  readonly aggregateTypes = [ORDER_AGGREGATE];
  private customerOf = new Map<string, string>();
  private ordersByCustomer = new Map<string, MutableOrder[]>();

  apply(stored: StoredEvent): void {
    const event = stored as StoredEvent<OrderEvent>;
    if (event.type === 'OrderCreated') {
      this.customerOf.set(event.aggregateId, event.payload.customerId);
      return;
    }
    const customerId = this.customerOf.get(event.aggregateId);
    if (!customerId) {
      return;
    }
    if (event.type === 'OrderPlaced') {
      const orders = this.ordersByCustomer.get(customerId) ?? [];
      orders.push({
        orderId: event.aggregateId,
        status: 'Placed',
        placedAt: event.occurredAt,
        totalCents: event.payload.pricing.totalCents,
        paidCents: cents(0),
        refundedCents: cents(0),
      });
      this.ordersByCustomer.set(customerId, orders);
      return;
    }
    const order = this.ordersByCustomer.get(customerId)?.find((entry) => entry.orderId === event.aggregateId);
    if (!order) {
      return;
    }
    switch (event.type) {
      case 'OrderPaid':
        order.status = 'Paid';
        order.paidCents = event.payload.amountCents;
        break;
      case 'OrderShipped':
        order.status = 'Shipped';
        break;
      case 'OrderDelivered':
        order.status = 'Delivered';
        break;
      case 'OrderCancelled':
        order.status = 'Cancelled';
        break;
      case 'OrderRefunded':
        order.status = 'Refunded';
        break;
      case 'OrderLineRefunded':
        order.refundedCents = cents(order.refundedCents + event.payload.refund.totalCents);
        break;
      default:
        break;
    }
  }

  reset(): void {
    this.customerOf = new Map();
    this.ordersByCustomer = new Map();
  }

  get(customerId: string): CustomerHistory | undefined {
    const orders = this.ordersByCustomer.get(customerId);
    if (!orders) {
      return undefined;
    }
    const spend = orders.reduce((total, order) => total + order.paidCents - order.refundedCents, 0);
    return {
      customerId,
      orders: orders.map((order) => ({ ...order })),
      orderCount: orders.length,
      lifetimeSpendCents: cents(spend),
    };
  }

  customerIds(): string[] {
    return [...this.ordersByCustomer.keys()].sort();
  }
}
