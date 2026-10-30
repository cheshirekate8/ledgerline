import { Order } from '../../../src/orders/order';
import {
  CouponAlreadyAppliedError,
  DuplicateDiscountCodeError,
  EmptyOrderError,
  InvalidOrderTransitionError,
  OrderAlreadyExistsError,
  OrderAwaitingStockError,
  OrderLineNotFoundError,
  OrderNotEditableError,
  OrderNotRefundableError,
  OrderPaymentMismatchError,
  RefundExceedsPaidError,
  ReservationExpiredError,
  ReservationNotExpiredError,
} from '../../../src/orders/order-errors';
import { ValidationError } from '../../../src/shared/errors';
import { cents } from '../../../src/shared/money';

const PLACED_AT = Date.parse('2026-06-01T09:00:00.000Z');
const EXPIRES_AT = '2026-06-01T09:15:00.000Z';
const BEFORE_EXPIRY = Date.parse(EXPIRES_AT) - 1;

function draft(): Order {
  const order = new Order('o-1');
  order.create('c-1', 'US-CA');
  order.addLine({ lineId: 'a', sku: 'MUG', quantity: 3, unitPriceCents: cents(1_999) });
  order.addLine({ lineId: 'b', sku: 'TEE', quantity: 1, unitPriceCents: cents(2_500) });
  return order;
}

function placed(): Order {
  const order = draft();
  order.applyDiscountCode({ code: 'TEN', percentOffBasisPoints: 1_000 });
  order.applyCoupon({ code: 'FIVE', amountCents: cents(500) });
  order.place(825, EXPIRES_AT);
  order.recordStockReserved();
  return order;
}

function paid(): Order {
  const order = placed();
  order.markPaid('p-1', cents(7_737), PLACED_AT);
  return order;
}

const types = (order: Order) => order.peekPendingEvents().map((event) => event.type);

describe('Order', () => {
  describe('drafting', () => {
    it('is created once with a customer and region', () => {
      const order = draft();
      expect(order.status).toBe('Draft');
      expect(order.customerId).toBe('c-1');
      expect(() => order.create('c-2', 'DE')).toThrow(OrderAlreadyExistsError);
      expect(() => new Order('o-2').create('', 'DE')).toThrow(ValidationError);
    });

    it('adds and removes lines', () => {
      const order = draft();
      order.removeLine('b');
      expect(order.lines.map((line) => line.lineId)).toEqual(['a']);
      expect(() => order.removeLine('b')).toThrow(OrderLineNotFoundError);
      expect(() => order.addLine({ lineId: 'a', sku: 'MUG', quantity: 1, unitPriceCents: cents(1) })).toThrow(
        ValidationError,
      );
      expect(() => order.addLine({ lineId: 'z', sku: 'MUG', quantity: 0, unitPriceCents: cents(1) })).toThrow(
        RangeError,
      );
    });

    it('takes each discount code once and a single coupon', () => {
      const order = draft();
      order.applyDiscountCode({ code: 'TEN', percentOffBasisPoints: 1_000 });
      expect(() => order.applyDiscountCode({ code: 'TEN', percentOffBasisPoints: 1_000 })).toThrow(
        DuplicateDiscountCodeError,
      );
      order.applyCoupon({ code: 'FIVE', amountCents: cents(500) });
      expect(() => order.applyCoupon({ code: 'TWO', amountCents: cents(200) })).toThrow(CouponAlreadyAppliedError);
    });

    it('cannot be placed empty', () => {
      const order = new Order('o-1');
      order.create('c-1', 'US-CA');
      expect(() => order.place(825, EXPIRES_AT)).toThrow(EmptyOrderError);
    });
  });

  describe('placing', () => {
    it('fixes the price and the reservation expiry', () => {
      const order = placed();
      expect(order.status).toBe('Placed');
      expect(order.totalCents).toBe(7_737);
      expect(order.reservationExpiresAt).toBe(EXPIRES_AT);
      expect(order.pricing!.lines.map((line) => line.totalCents)).toEqual([5_460, 2_277]);
    });

    it('can no longer be edited', () => {
      const order = placed();
      expect(() => order.addLine({ lineId: 'c', sku: 'MUG', quantity: 1, unitPriceCents: cents(1) })).toThrow(
        OrderNotEditableError,
      );
      expect(() => order.applyCoupon({ code: 'X', amountCents: cents(1) })).toThrow(OrderNotEditableError);
      expect(() => order.place(825, EXPIRES_AT)).toThrow(InvalidOrderTransitionError);
    });
  });

  describe('paying', () => {
    it('is not payable until stock is reserved', () => {
      const order = draft();
      order.place(825, EXPIRES_AT);
      expect(() => order.assertPayable(PLACED_AT)).toThrow(OrderAwaitingStockError);
      order.recordStockReserved();
      order.recordStockReserved();
      expect(types(order).filter((type) => type === 'OrderStockReserved')).toHaveLength(1);
      expect(() => order.assertPayable(PLACED_AT)).not.toThrow();
    });

    it('is paid for its exact total before the reservation expires', () => {
      const order = placed();
      expect(() => order.markPaid('p-1', cents(7_736), PLACED_AT)).toThrow(OrderPaymentMismatchError);
      order.markPaid('p-1', cents(7_737), BEFORE_EXPIRY);
      expect(order.status).toBe('Paid');
      expect(order.paymentId).toBe('p-1');
    });

    it('refuses payment once the reservation has expired', () => {
      expect(() => placed().markPaid('p-1', cents(7_737), Date.parse(EXPIRES_AT))).toThrow(ReservationExpiredError);
    });

    it('accepts the same payment twice but not a second payment', () => {
      const order = paid();
      order.markPaid('p-1', cents(7_737), PLACED_AT);
      expect(types(order).filter((type) => type === 'OrderPaid')).toHaveLength(1);
      expect(() => order.markPaid('p-2', cents(7_737), PLACED_AT)).toThrow(InvalidOrderTransitionError);
    });
  });

  describe('lifecycle', () => {
    it('moves Paid → Shipped → Delivered', () => {
      const order = paid();
      expect(() => order.ship(' ')).toThrow(ValidationError);
      order.ship('TRACK-1');
      order.deliver();
      expect(order.status).toBe('Delivered');
    });

    it.each([
      ['ship a draft', (order: Order) => order.ship('T')],
      ['deliver a draft', (order: Order) => order.deliver()],
    ])('refuses to %s', (_label, act) => {
      expect(() => act(draft())).toThrow(InvalidOrderTransitionError);
    });

    it('refuses to deliver an order that has not shipped', () => {
      expect(() => paid().deliver()).toThrow(InvalidOrderTransitionError);
    });

    it('cancels drafts and placed orders, once', () => {
      const order = placed();
      order.cancel('customer-request');
      order.cancel('out-of-stock');
      expect(order.status).toBe('Cancelled');
      expect(types(order).filter((type) => type === 'OrderCancelled')).toHaveLength(1);
      const another = draft();
      another.cancel('customer-request');
      expect(another.status).toBe('Cancelled');
    });

    it('refuses to cancel a paid order', () => {
      expect(() => paid().cancel('customer-request')).toThrow(InvalidOrderTransitionError);
    });

    it('refuses any transition out of a terminal state', () => {
      const order = placed();
      order.cancel('customer-request');
      expect(() => order.markPaid('p-1', cents(7_737), PLACED_AT)).toThrow(InvalidOrderTransitionError);
      expect(() => order.ship('T')).toThrow(InvalidOrderTransitionError);
    });
  });

  describe('reservation expiry', () => {
    it('expires a placed order once its window has passed', () => {
      const order = placed();
      expect(() => order.expireReservation(BEFORE_EXPIRY)).toThrow(ReservationNotExpiredError);
      order.expireReservation(Date.parse(EXPIRES_AT));
      expect(order.status).toBe('Cancelled');
      expect(order.peekPendingEvents().at(-1)).toMatchObject({ payload: { reason: 'reservation-expired' } });
      order.expireReservation(Date.parse(EXPIRES_AT));
      expect(types(order).filter((type) => type === 'OrderCancelled')).toHaveLength(1);
    });

    it('never expires a paid order', () => {
      expect(() => paid().expireReservation(Date.parse(EXPIRES_AT) + 1)).toThrow(InvalidOrderTransitionError);
    });
  });

  describe('refunds', () => {
    it('refunds part of a line with prorated discount, coupon and tax', () => {
      const order = paid();
      order.refundLine('r-1', 'a', 1);
      expect(order.peekPendingEvents().at(-1)).toMatchObject({
        type: 'OrderLineRefunded',
        payload: {
          refundId: 'r-1',
          lineId: 'a',
          paymentId: 'p-1',
          refund: { quantity: 1, grossCents: 1_999, discountCents: 200, couponCents: 117, taxCents: 139, totalCents: 1_821 },
        },
      });
      expect(order.refundedQuantity('a')).toBe(1);
      expect(order.refundedCents).toBe(1_821);
      expect(order.status).toBe('Paid');
    });

    it('never refunds more units than were paid for', () => {
      const order = paid();
      order.refundLine('r-1', 'a', 2);
      expect(() => order.refundLine('r-2', 'a', 2)).toThrow(RefundExceedsPaidError);
      expect(() => order.refundLine('r-3', 'a', 0)).toThrow(ValidationError);
      expect(() => order.refundLine('r-4', 'nope', 1)).toThrow(OrderLineNotFoundError);
    });

    it('ignores a refund id it has already applied', () => {
      const order = paid();
      order.refundLine('r-1', 'a', 1);
      order.refundLine('r-1', 'a', 1);
      expect(order.refundedQuantity('a')).toBe(1);
    });

    it('moves to Refunded once every unit is refunded, having returned exactly the total', () => {
      const order = paid();
      order.ship('T');
      order.refundLine('r-1', 'a', 1);
      order.refundLine('r-2', 'b', 1);
      order.refundLine('r-3', 'a', 2);
      expect(order.status).toBe('Refunded');
      expect(order.refundedCents).toBe(7_737);
      expect(order.peekPendingEvents().at(-1)).toMatchObject({
        type: 'OrderRefunded',
        payload: { totalRefundedCents: 7_737 },
      });
      expect(() => order.refundLine('r-4', 'a', 1)).toThrow(OrderNotRefundableError);
    });

    it('refuses refunds before payment', () => {
      expect(() => placed().refundLine('r-1', 'a', 1)).toThrow(OrderNotRefundableError);
    });

    it('records at v2 that only units refunded while Paid return to stock', () => {
      const paidRefund = paid();
      paidRefund.refundLine('r-1', 'a', 1);
      expect(paidRefund.peekPendingEvents().at(-1)).toMatchObject({
        type: 'OrderLineRefunded',
        version: 2,
        payload: { returnsToStock: true },
      });

      const shipped = paid();
      shipped.ship('T');
      shipped.refundLine('r-1', 'a', 1);
      expect(shipped.peekPendingEvents().at(-1)).toMatchObject({ version: 2, payload: { returnsToStock: false } });

      const delivered = paid();
      delivered.ship('T');
      delivered.deliver();
      delivered.refundLine('r-1', 'a', 1);
      expect(delivered.peekPendingEvents().at(-1)).toMatchObject({ version: 2, payload: { returnsToStock: false } });
    });
  });

  it('rebuilds identically from its own events', () => {
    const original = paid();
    original.refundLine('r-1', 'a', 1);
    const events = original.peekPendingEvents().map((event, index) => ({
      ...event,
      eventId: `e-${index}`,
      occurredAt: '2026-06-01T09:00:00.000Z',
      metadata: {},
      aggregateType: 'order',
      aggregateId: 'o-1',
      sequence: index + 1,
      position: index + 1,
    }));
    original.markCommitted(events.length);
    const rebuilt = new Order('o-1');
    rebuilt.rehydrate(events);
    expect(rebuilt.takeSnapshot()).toEqual(original.takeSnapshot());
  });
});
