import { AggregateRepository, RepositoryDependencies } from '../shared/aggregates/aggregate-repository';
import { Order } from './order';
import { OrderNotFoundError } from './order-errors';
import { ORDER_AGGREGATE, OrderEvent } from './order-events';
import { OrderState } from './order-state';

export type OrderRepository = AggregateRepository<OrderState, OrderEvent, Order>;

export function createOrderRepository(dependencies: RepositoryDependencies): OrderRepository {
  return new AggregateRepository<OrderState, OrderEvent, Order>({
    ...dependencies,
    aggregateType: ORDER_AGGREGATE,
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
