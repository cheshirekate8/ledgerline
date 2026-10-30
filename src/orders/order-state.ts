import { Coupon } from '../pricing/coupons';
import { DiscountCode } from '../pricing/discount-codes';
import { LineInput, OrderPricing } from '../pricing/pricing-types';
import { Cents, cents } from '../shared/money';
import { CancellationReason, OrderEvent } from './order-events';
import { OrderStatus } from './order-status';

/** Plain, JSON-serializable order state, so that it can be snapshotted. */
export interface OrderState {
  readonly created: boolean;
  readonly customerId: string;
  readonly shippingRegion: string;
  readonly status: OrderStatus;
  readonly lines: readonly LineInput[];
  readonly discountCodes: readonly DiscountCode[];
  readonly coupon: Coupon | null;
  /** Fixed at placement; draft orders have no price yet. */
  readonly pricing: OrderPricing | null;
  readonly reservationExpiresAt: string | null;
  readonly stockReserved: boolean;
  readonly paymentId: string | null;
  readonly paidCents: Cents;
  readonly refundedUnits: Readonly<Record<string, number>>;
  /** Money given back on the order: credits plus what unit refunds paid back (§5.4). */
  readonly returnedCents: Cents;
  /** Ids already used by a unit refund or a credit; both kinds share them (§5.4). */
  readonly refundIds: readonly string[];
  readonly cancellationReason: CancellationReason | null;
  readonly trackingNumber: string | null;
}

export const INITIAL_ORDER_STATE: OrderState = Object.freeze({
  created: false,
  customerId: '',
  shippingRegion: '',
  status: 'Draft',
  lines: [],
  discountCodes: [],
  coupon: null,
  pricing: null,
  reservationExpiresAt: null,
  stockReserved: false,
  paymentId: null,
  paidCents: cents(0),
  refundedUnits: {},
  returnedCents: cents(0),
  refundIds: [],
  cancellationReason: null,
  trackingNumber: null,
});

export function evolveOrder(state: OrderState, event: OrderEvent): OrderState {
  switch (event.type) {
    case 'OrderCreated':
      return { ...state, created: true, status: 'Draft', ...event.payload };
    case 'OrderLineAdded':
      return { ...state, lines: [...state.lines, { ...event.payload }] };
    case 'OrderLineRemoved':
      return { ...state, lines: state.lines.filter((line) => line.lineId !== event.payload.lineId) };
    case 'DiscountCodeApplied':
      return { ...state, discountCodes: [...state.discountCodes, { ...event.payload }] };
    case 'CouponApplied':
      return { ...state, coupon: { ...event.payload } };
    case 'OrderPlaced':
      return {
        ...state,
        status: 'Placed',
        pricing: event.payload.pricing,
        reservationExpiresAt: event.payload.reservationExpiresAt,
      };
    case 'OrderStockReserved':
      return { ...state, stockReserved: true };
    case 'OrderPaid':
      return { ...state, status: 'Paid', paymentId: event.payload.paymentId, paidCents: event.payload.amountCents };
    case 'OrderShipped':
      return { ...state, status: 'Shipped', trackingNumber: event.payload.trackingNumber };
    case 'OrderDelivered':
      return { ...state, status: 'Delivered' };
    case 'OrderCancelled':
      return { ...state, status: 'Cancelled', cancellationReason: event.payload.reason };
    case 'OrderLineRefunded': {
      const { lineId, refund, refundId, paidBackCents } = event.payload;
      return {
        ...state,
        refundedUnits: { ...state.refundedUnits, [lineId]: (state.refundedUnits[lineId] ?? 0) + refund.quantity },
        returnedCents: cents(state.returnedCents + paidBackCents),
        refundIds: [...state.refundIds, refundId],
      };
    }
    case 'OrderCredited':
      return {
        ...state,
        returnedCents: cents(state.returnedCents + event.payload.amountCents),
        refundIds: [...state.refundIds, event.payload.creditId],
      };
    case 'OrderRefunded':
      return { ...state, status: 'Refunded' };
  }
}
