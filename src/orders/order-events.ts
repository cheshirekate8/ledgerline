import { OrderPricing, RefundAmounts } from '../pricing/pricing-types';
import { EventData } from '../shared/events/domain-event';
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
export type OrderLineRefunded = EventData<
  'OrderLineRefunded',
  { refundId: string; lineId: string; paymentId: string; refund: RefundAmounts }
>;
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
  'OrderRefunded',
];
