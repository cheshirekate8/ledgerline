import { DomainError } from '../shared/errors';
import { Cents } from '../shared/money';
import { OrderStatus } from './order-status';

export class OrderNotFoundError extends DomainError {
  readonly code = 'ORDER_NOT_FOUND';

  constructor(readonly orderId: string) {
    super(`Order ${orderId} does not exist`);
  }
}

export class OrderAlreadyExistsError extends DomainError {
  readonly code = 'ORDER_ALREADY_EXISTS';

  constructor(readonly orderId: string) {
    super(`Order ${orderId} already exists`);
  }
}

export class InvalidOrderTransitionError extends DomainError {
  readonly code = 'INVALID_ORDER_TRANSITION';

  constructor(
    readonly orderId: string,
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`Order ${orderId} cannot move from ${from} to ${to}`);
  }
}

export class OrderNotEditableError extends DomainError {
  readonly code = 'ORDER_NOT_EDITABLE';

  constructor(
    readonly orderId: string,
    readonly status: OrderStatus,
  ) {
    super(`Order ${orderId} is ${status}; only draft orders can be changed`);
  }
}

export class EmptyOrderError extends DomainError {
  readonly code = 'EMPTY_ORDER';

  constructor(readonly orderId: string) {
    super(`Order ${orderId} has no lines`);
  }
}

export class OrderLineNotFoundError extends DomainError {
  readonly code = 'ORDER_LINE_NOT_FOUND';

  constructor(
    readonly orderId: string,
    readonly lineId: string,
  ) {
    super(`Order ${orderId} has no line ${lineId}`);
  }
}

export class DuplicateDiscountCodeError extends DomainError {
  readonly code = 'DUPLICATE_DISCOUNT_CODE';

  constructor(readonly discountCode: string) {
    super(`Discount code ${discountCode} is already applied`);
  }
}

export class CouponAlreadyAppliedError extends DomainError {
  readonly code = 'COUPON_ALREADY_APPLIED';

  constructor(readonly couponCode: string) {
    super(`Coupon ${couponCode} is already applied; an order takes one coupon`);
  }
}

export class OrderAwaitingStockError extends DomainError {
  readonly code = 'ORDER_AWAITING_STOCK';

  constructor(readonly orderId: string) {
    super(`Order ${orderId} cannot be paid until its stock is reserved`);
  }
}

export class ReservationExpiredError extends DomainError {
  readonly code = 'RESERVATION_EXPIRED';

  constructor(
    readonly orderId: string,
    readonly expiredAt: string,
  ) {
    super(`The stock reservation for order ${orderId} expired at ${expiredAt}`);
  }
}

export class ReservationNotExpiredError extends DomainError {
  readonly code = 'RESERVATION_NOT_EXPIRED';

  constructor(
    readonly orderId: string,
    readonly expiresAt: string,
  ) {
    super(`The stock reservation for order ${orderId} does not expire until ${expiresAt}`);
  }
}

export class OrderPaymentMismatchError extends DomainError {
  readonly code = 'ORDER_PAYMENT_MISMATCH';

  constructor(
    readonly orderId: string,
    readonly totalCents: Cents,
    readonly paidCents: Cents,
  ) {
    super(`Order ${orderId} totals ${totalCents} cents but ${paidCents} cents were paid`);
  }
}

export class OrderNotRefundableError extends DomainError {
  readonly code = 'ORDER_NOT_REFUNDABLE';

  constructor(
    readonly orderId: string,
    readonly status: OrderStatus,
  ) {
    super(`Order ${orderId} is ${status}; only paid, shipped or delivered orders can be refunded`);
  }
}

/**
 * Raised when a credit asks for more than the order has left to give back.
 * Credits and unit refunds draw on one balance (§5.4).
 */
export class CreditExceedsRefundableError extends DomainError {
  readonly code = 'CREDIT_EXCEEDS_REFUNDABLE';

  constructor(
    readonly orderId: string,
    readonly requestedCents: Cents,
    readonly refundableCents: Cents,
  ) {
    super(`Order ${orderId} has ${refundableCents} cents left to give back, ${requestedCents} cents requested`);
  }
}

export class RefundExceedsPaidError extends DomainError {
  readonly code = 'REFUND_EXCEEDS_PAID';

  constructor(
    readonly orderId: string,
    readonly lineId: string,
    readonly requestedQuantity: number,
    readonly refundableQuantity: number,
  ) {
    super(
      `Line ${lineId} of order ${orderId} has ${refundableQuantity} paid unit(s) left to refund, ` +
        `${requestedQuantity} requested`,
    );
  }
}
