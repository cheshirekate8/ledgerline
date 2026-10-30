import { AggregateRepository, RepositoryDependencies } from '../shared/aggregates/aggregate-repository';
import { Order } from './order';
import { OrderNotFoundError } from './order-errors';
import { ORDER_AGGREGATE, OrderEvent } from './order-events';
import { OrderState } from './order-state';

export type OrderRepository = AggregateRepository<OrderState, OrderEvent, Order>;

/**
 * 2 since `OrderState` replaced `refundedCents` with `returnedCents`, which
 * counts credits as well as what refunds paid back; v1 snapshots are ignored,
 * not misread (§6.3).
 */
export const ORDER_SNAPSHOT_SCHEMA_VERSION = 2;

export function createOrderRepository(dependencies: RepositoryDependencies): OrderRepository {
  return new AggregateRepository<OrderState, OrderEvent, Order>({
    ...dependencies,
    aggregateType: ORDER_AGGREGATE,
    snapshotSchemaVersion: ORDER_SNAPSHOT_SCHEMA_VERSION,
    create: (orderId) => new Order(orderId),
  });
}

export function loadExistingOrder(repository: OrderRepository, orderId: string): Order {
  const order = repository.load(orderId);
  if (!order || !order.exists) {
    throw new OrderNotFoundError(orderId);
  }
  return order;
}
