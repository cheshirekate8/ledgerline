export type OrderStatus = 'Draft' | 'Placed' | 'Paid' | 'Shipped' | 'Delivered' | 'Cancelled' | 'Refunded';

/**
 * The order lifecycle. Draft → Placed → Paid → Shipped → Delivered is the
 * happy path; an order can be cancelled before it is paid, and refunded in
 * full once it has been paid. Cancelled and Refunded are terminal.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = Object.freeze({
  Draft: ['Placed', 'Cancelled'],
  Placed: ['Paid', 'Cancelled'],
  Paid: ['Shipped', 'Refunded'],
  Shipped: ['Delivered', 'Refunded'],
  Delivered: ['Refunded'],
  Cancelled: [],
  Refunded: [],
});

/** Statuses in which individual lines may be (partially) refunded. */
export const REFUNDABLE_STATUSES: readonly OrderStatus[] = ['Paid', 'Shipped', 'Delivered'];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: OrderStatus): boolean {
  return ORDER_TRANSITIONS[status].length === 0;
}
