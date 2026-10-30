import { PayableOrder, PayableOrderLookup } from '../payments/payment-commands';
import { Clock } from '../shared/clock';
import { loadExistingOrder, OrderRepository } from './order-repository';

/** Lets the payments domain ask whether an order can be paid, without seeing its internals. */
export function createPayableOrderLookup(repository: OrderRepository, clock: Clock): PayableOrderLookup {
  return {
    payableOrder(orderId: string): PayableOrder {
      const order = loadExistingOrder(repository, orderId);
      order.assertPayable(clock.now());
      return { orderId: order.orderId, customerId: order.customerId, totalCents: order.totalCents };
    },
  };
}
