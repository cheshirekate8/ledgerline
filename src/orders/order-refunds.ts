import { ValidationError } from '../shared/errors';
import { Cents, cents, minCents, subtractCents } from '../shared/money';
import { OrderState } from './order-state';

/**
 * The money an order can still give back: what was paid, less everything
 * returned so far — credits and the amounts unit refunds actually paid back.
 * Credits and unit refunds draw on this one balance, so the money returned on
 * an order never exceeds what was paid (§5.4).
 *
 * It is computed from the order's own events, never from the payment, whose
 * totals lag behind unsettled refunds and include compensation refunds (§4.3).
 */
export function refundableBalance(state: OrderState): Cents {
  return subtractCents(state.paidCents, state.returnedCents);
}

/**
 * What a unit refund worth `refundTotalCents` actually pays back: the whole
 * prorated total, or whatever the balance has left. A credit therefore comes
 * off the last refunds, and a refund with no balance left returns no money
 * while still refunding its units (§5.4).
 */
export function paidBackFor(state: OrderState, refundTotalCents: Cents): Cents {
  return minCents(refundTotalCents, refundableBalance(state));
}

/** A credit amount is whole cents and strictly positive; anything else is invalid input. */
export function creditAmount(amountCents: number): Cents {
  if (!Number.isSafeInteger(amountCents) || amountCents < 1) {
    throw new ValidationError(`A credit amount must be a positive whole number of cents, got ${amountCents}`);
  }
  return cents(amountCents);
}

/** A credit needs a reason; it is stored trimmed. */
export function creditReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('A credit needs a reason');
  }
  return trimmed;
}
