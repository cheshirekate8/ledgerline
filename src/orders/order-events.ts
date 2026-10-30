import { OrderPricing, RefundAmounts } from '../pricing/pricing-types';
import { EventData } from '../shared/events/domain-event';
import { Upcaster } from '../shared/events/upcaster-registry';
import { Cents } from '../shared/money';

export const ORDER_AGGREGATE = 'order';

export type CancellationReason = 'customer-request' | 'out-of-stock' | 'reservation-expired';

export type OrderCreated = EventData<'OrderCreated', { customerId: string; shippingRegion: string }>;
export type OrderLineAdded = EventData<
  'OrderLineAdded',
  { lineId: string; sku: string; quantity: number; unitPriceCents: Cents }
>;
export type OrderLineRemoved = EventData<'OrderLineRemoved', { lineId: string }>;
export type DiscountCodeApplied = EventData<'DiscountCodeApplied', { code: string; percentOffBasisPoints: number }>;
export type CouponApplied = EventData<'CouponApplied', { code: string; amountCents: Cents }>;
export type OrderPlaced = EventData<'OrderPlaced', { pricing: OrderPricing; reservationExpiresAt: string }>;
export type OrderStockReserved = EventData<'OrderStockReserved', Record<string, never>>;
export type OrderPaid = EventData<'OrderPaid', { paymentId: string; amountCents: Cents }>;
export type OrderShipped = EventData<'OrderShipped', { trackingNumber: string }>;
export type OrderDelivered = EventData<'OrderDelivered', Record<string, never>>;
export type OrderCancelled = EventData<'OrderCancelled', { reason: CancellationReason }>;
/**
 * `returnsToStock` is the order's answer, at refund time, to whether these units
 * go back into stock: true only while the order is Paid, because nothing has
 * shipped yet. Fulfillment reads it instead of the order's current status (§3.2).
 *
 * `refund` says what the units were worth; `paidBackCents` says how much money
 * this refund actually returns, which is smaller once a credit has eaten into
 * the order's balance (§5.4).
 */
export type OrderLineRefunded = EventData<
  'OrderLineRefunded',
  {
    refundId: string;
    lineId: string;
    paymentId: string;
    refund: RefundAmounts;
    returnsToStock: boolean;
    paidBackCents: Cents;
  }
>;
/** Money given back without returning any units (§5.4). */
export type OrderCredited = EventData<
  'OrderCredited',
  { creditId: string; paymentId: string; amountCents: Cents; reason: string }
>;
/** `totalRefundedCents` is the money returned on the order: credits plus amounts paid back. */
export type OrderRefunded = EventData<'OrderRefunded', { totalRefundedCents: Cents }>;

export type OrderEvent =
  | OrderCreated
  | OrderLineAdded
  | OrderLineRemoved
  | DiscountCodeApplied
  | CouponApplied
  | OrderPlaced
  | OrderStockReserved
  | OrderPaid
  | OrderShipped
  | OrderDelivered
  | OrderCancelled
  | OrderLineRefunded
  | OrderCredited
  | OrderRefunded;

export const ORDER_EVENT_TYPES: readonly OrderEvent['type'][] = [
  'OrderCreated',
  'OrderLineAdded',
  'OrderLineRemoved',
  'DiscountCodeApplied',
  'CouponApplied',
  'OrderPlaced',
  'OrderStockReserved',
  'OrderPaid',
  'OrderShipped',
  'OrderDelivered',
  'OrderCancelled',
  'OrderLineRefunded',
  'OrderCredited',
  'OrderRefunded',
];

/** Order event types whose payload shape has moved past version 1. */
export const ORDER_EVENT_VERSIONS: Readonly<Record<string, number>> = Object.freeze({ OrderLineRefunded: 3 });

/**
 * Before the restocking rule existed no refund put units back, so a stored v1
 * refund becomes a v2 refund that returns nothing: replay must not invent stock
 * for history (§5.3). Before credits existed every refund paid back its full
 * prorated total, so a v2 refund becomes a v3 refund that paid all of it (§5.4).
 */
export const ORDER_UPCASTERS: readonly Upcaster[] = Object.freeze([
  {
    type: 'OrderLineRefunded',
    fromVersion: 1,
    upcast: (payload: unknown) => ({ ...(payload as Record<string, unknown>), returnsToStock: false }),
  },
  {
    type: 'OrderLineRefunded',
    fromVersion: 2,
    upcast: (payload: unknown) => {
      const refunded = payload as { refund: RefundAmounts };
      return { ...refunded, paidBackCents: refunded.refund.totalCents };
    },
  },
]);
