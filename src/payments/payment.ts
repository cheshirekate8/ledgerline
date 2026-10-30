import { AggregateRoot } from '../shared/aggregates/aggregate-root';
import { ValidationError } from '../shared/errors';
import { Cents, cents, nonNegativeCents } from '../shared/money';
import { PaymentAlreadyCapturedError, RefundExceedsCapturedError } from './payment-errors';
import { PAYMENT_AGGREGATE, PaymentEvent } from './payment-events';

export type PaymentStatus = 'pending' | 'captured' | 'partially-refunded' | 'refunded';

export interface PaymentState {
  readonly captured: boolean;
  readonly orderId: string;
  readonly customerId: string;
  readonly amountCents: Cents;
  readonly refundedCents: Cents;
  readonly refundIds: readonly string[];
}

const INITIAL_STATE: PaymentState = {
  captured: false,
  orderId: '',
  customerId: '',
  amountCents: cents(0),
  refundedCents: cents(0),
  refundIds: [],
};

/** Money taken from a customer for one order, and what has been given back. */
export class Payment extends AggregateRoot<PaymentState, PaymentEvent> {
  readonly aggregateType = PAYMENT_AGGREGATE;

  constructor(paymentId: string) {
    super(paymentId, INITIAL_STATE);
  }

  get paymentId(): string {
    return this.id;
  }

  get orderId(): string {
    return this.state.orderId;
  }

  get amountCents(): Cents {
    return this.state.amountCents;
  }

  get refundedCents(): Cents {
    return this.state.refundedCents;
  }

  get refundableCents(): Cents {
    return cents(this.state.amountCents - this.state.refundedCents);
  }

  get status(): PaymentStatus {
    if (!this.state.captured) {
      return 'pending';
    }
    if (this.state.refundedCents === 0) {
      return 'captured';
    }
    return this.state.refundedCents === this.state.amountCents ? 'refunded' : 'partially-refunded';
  }

  capture(details: { orderId: string; customerId: string; amountCents: number; method: string }): void {
    if (this.state.captured) {
      throw new PaymentAlreadyCapturedError(this.paymentId);
    }
    if (details.method.trim().length === 0) {
      throw new ValidationError('A payment method is required');
    }
    this.raise({
      type: 'PaymentCaptured',
      version: 1,
      payload: {
        paymentId: this.paymentId,
        orderId: details.orderId,
        customerId: details.customerId,
        amountCents: nonNegativeCents(details.amountCents),
        method: details.method.trim(),
      },
    });
  }

  /** Returns money to the customer. A refund id that was already applied is ignored. */
  refund(refundId: string, amountCents: number, reason: string): void {
    if (!this.state.captured) {
      throw new ValidationError(`Payment ${this.paymentId} has not been captured`);
    }
    if (this.state.refundIds.includes(refundId)) {
      return;
    }
    const amount = nonNegativeCents(amountCents);
    if (amount > this.refundableCents) {
      throw new RefundExceedsCapturedError(this.paymentId, amount, this.refundableCents);
    }
    this.raise({
      type: 'PaymentRefunded',
      version: 1,
      payload: { paymentId: this.paymentId, orderId: this.state.orderId, refundId, amountCents: amount, reason },
    });
  }

  protected evolve(state: PaymentState, event: PaymentEvent): PaymentState {
    switch (event.type) {
      case 'PaymentCaptured':
        return {
          ...state,
          captured: true,
          orderId: event.payload.orderId,
          customerId: event.payload.customerId,
          amountCents: event.payload.amountCents,
        };
      case 'PaymentRefunded':
        return {
          ...state,
          refundedCents: cents(state.refundedCents + event.payload.amountCents),
          refundIds: [...state.refundIds, event.payload.refundId],
        };
    }
  }
}
