import { EventData } from '../shared/events/domain-event';
import { Cents } from '../shared/money';

export const PAYMENT_AGGREGATE = 'payment';

export type PaymentCaptured = EventData<
  'PaymentCaptured',
  { paymentId: string; orderId: string; customerId: string; amountCents: Cents; method: string }
>;
export type PaymentRefunded = EventData<
  'PaymentRefunded',
  { paymentId: string; orderId: string; refundId: string; amountCents: Cents; reason: string }
>;

export type PaymentEvent = PaymentCaptured | PaymentRefunded;

export const PAYMENT_EVENT_TYPES: readonly PaymentEvent['type'][] = ['PaymentCaptured', 'PaymentRefunded'];
