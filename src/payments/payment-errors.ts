import { DomainError } from '../shared/errors';
import { Cents } from '../shared/money';

export class PaymentNotFoundError extends DomainError {
  readonly code = 'PAYMENT_NOT_FOUND';

  constructor(readonly paymentId: string) {
    super(`Payment ${paymentId} does not exist`);
  }
}

export class PaymentAlreadyCapturedError extends DomainError {
  readonly code = 'PAYMENT_ALREADY_CAPTURED';

  constructor(readonly paymentId: string) {
    super(`Payment ${paymentId} has already been captured`);
  }
}

export class PaymentAmountMismatchError extends DomainError {
  readonly code = 'PAYMENT_AMOUNT_MISMATCH';

  constructor(
    readonly orderId: string,
    readonly expectedCents: Cents,
    readonly actualCents: Cents,
  ) {
    super(`Order ${orderId} totals ${expectedCents} cents but the payment is for ${actualCents} cents`);
  }
}

export class RefundExceedsCapturedError extends DomainError {
  readonly code = 'REFUND_EXCEEDS_CAPTURED';

  constructor(
    readonly paymentId: string,
    readonly requestedCents: Cents,
    readonly refundableCents: Cents,
  ) {
    super(`Payment ${paymentId} can refund at most ${refundableCents} cents, ${requestedCents} requested`);
  }
}
