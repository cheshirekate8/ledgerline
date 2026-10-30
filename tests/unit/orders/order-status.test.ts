import { canTransition, isTerminal, ORDER_TRANSITIONS, OrderStatus } from '../../../src/orders/order-status';

const ALL: OrderStatus[] = ['Draft', 'Placed', 'Paid', 'Shipped', 'Delivered', 'Cancelled', 'Refunded'];

describe('order status transitions', () => {
  it.each([
    ['Draft', 'Placed'],
    ['Draft', 'Cancelled'],
    ['Placed', 'Paid'],
    ['Placed', 'Cancelled'],
    ['Paid', 'Shipped'],
    ['Paid', 'Refunded'],
    ['Shipped', 'Delivered'],
    ['Shipped', 'Refunded'],
    ['Delivered', 'Refunded'],
  ] as const)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('allows nothing else', () => {
    const allowed = new Set(Object.entries(ORDER_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}>${to}`)));
    expect(allowed.size).toBe(9);
    for (const from of ALL) {
      for (const to of ALL) {
        expect(canTransition(from, to)).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it('treats Cancelled and Refunded as terminal', () => {
    expect(ALL.filter(isTerminal)).toEqual(['Cancelled', 'Refunded']);
  });
});
