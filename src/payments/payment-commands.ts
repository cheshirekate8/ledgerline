import { Command } from '../shared/commands/command';
import { Cents } from '../shared/money';

export type CapturePayment = Command<
  'CapturePayment',
  { paymentId: string; orderId: string; amountCents: number; method: string }
>;
export type RefundPayment = Command<
  'RefundPayment',
  { paymentId: string; refundId: string; amountCents: number; reason: string }
>;

export type PaymentCommand = CapturePayment | RefundPayment;

/** What a payment needs to know about the order it pays for. */
export interface PayableOrder {
  readonly orderId: string;
  readonly customerId: string;
  readonly totalCents: Cents;
}

/**
 * Port to the orders domain: returns the order if it can be paid now, and
 * throws a domain error explaining why not otherwise.
 */
export interface PayableOrderLookup {
  payableOrder(orderId: string): PayableOrder;
}
