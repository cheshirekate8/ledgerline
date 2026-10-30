import { Coupon } from '../pricing/coupons';
import { DiscountCode } from '../pricing/discount-codes';
import { assertQuantity } from '../pricing/line-pricing';
import { priceOrder } from '../pricing/order-pricing';
import { LineInput, LinePricing, OrderPricing } from '../pricing/pricing-types';
import { refundForUnits } from '../pricing/refund-pricing';
import { AggregateRoot } from '../shared/aggregates/aggregate-root';
import { ValidationError } from '../shared/errors';
import { Cents, cents, nonNegativeCents } from '../shared/money';
import { hasReached } from '../shared/time';
import {
  CouponAlreadyAppliedError,
  CreditExceedsRefundableError,
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
} from './order-errors';
import { ORDER_AGGREGATE, OrderEvent } from './order-events';
import { creditAmount, creditReason, paidBackFor, refundableBalance } from './order-refunds';
import { evolveOrder, INITIAL_ORDER_STATE, OrderState } from './order-state';
import { canTransition, OrderStatus, REFUNDABLE_STATUSES } from './order-status';

/**
 * A customer's order. Lines, discount codes and the coupon can only change
 * while it is a draft; placing it fixes the price and starts the stock
 * reservation clock. Every lifecycle method either moves the order along
 * a legal transition or throws a typed domain error. Methods that an
 * at-least-once delivery may repeat (cancel, mark paid, refund or credit with
 * a known refund id) are no-ops the second time.
 */
export class Order extends AggregateRoot<OrderState, OrderEvent> {
  readonly aggregateType = ORDER_AGGREGATE;

  constructor(orderId: string) {
    super(orderId, INITIAL_ORDER_STATE);
  }

  get orderId(): string {
    return this.id;
  }

  get exists(): boolean {
    return this.state.created;
  }

  get status(): OrderStatus {
    return this.state.status;
  }

  get customerId(): string {
    return this.state.customerId;
  }

  get shippingRegion(): string {
    return this.state.shippingRegion;
  }

  get lines(): readonly LineInput[] {
    return this.state.lines;
  }

  get pricing(): OrderPricing | null {
    return this.state.pricing;
  }

  get totalCents(): Cents {
    return this.state.pricing?.totalCents ?? cents(0);
  }

  get reservationExpiresAt(): string | null {
    return this.state.reservationExpiresAt;
  }

  get stockReserved(): boolean {
    return this.state.stockReserved;
  }

  get paymentId(): string | null {
    return this.state.paymentId;
  }

  /** Money given back on this order: credits plus what unit refunds paid back. */
  get returnedCents(): Cents {
    return this.state.returnedCents;
  }

  /** What is still left to give back: paid minus {@link returnedCents}. */
  get refundableCents(): Cents {
    return refundableBalance(this.state);
  }

  refundedQuantity(lineId: string): number {
    return this.state.refundedUnits[lineId] ?? 0;
  }

  create(customerId: string, shippingRegion: string): void {
    if (this.state.created) {
      throw new OrderAlreadyExistsError(this.orderId);
    }
    if (customerId.trim().length === 0 || shippingRegion.trim().length === 0) {
      throw new ValidationError('An order needs a customer and a shipping region');
    }
    this.raise({ type: 'OrderCreated', version: 1, payload: { customerId, shippingRegion } });
  }

  addLine(line: LineInput): void {
    this.assertDraft();
    assertQuantity(line.quantity);
    if (this.state.lines.some((existing) => existing.lineId === line.lineId)) {
      throw new ValidationError(`Order ${this.orderId} already has a line ${line.lineId}`);
    }
    this.raise({
      type: 'OrderLineAdded',
      version: 1,
      payload: { ...line, unitPriceCents: nonNegativeCents(line.unitPriceCents) },
    });
  }

  removeLine(lineId: string): void {
    this.assertDraft();
    if (!this.state.lines.some((line) => line.lineId === lineId)) {
      throw new OrderLineNotFoundError(this.orderId, lineId);
    }
    this.raise({ type: 'OrderLineRemoved', version: 1, payload: { lineId } });
  }

  applyDiscountCode(discount: DiscountCode): void {
    this.assertDraft();
    if (this.state.discountCodes.some((applied) => applied.code === discount.code)) {
      throw new DuplicateDiscountCodeError(discount.code);
    }
    this.raise({ type: 'DiscountCodeApplied', version: 1, payload: { ...discount } });
  }

  applyCoupon(coupon: Coupon): void {
    this.assertDraft();
    if (this.state.coupon) {
      throw new CouponAlreadyAppliedError(this.state.coupon.code);
    }
    this.raise({ type: 'CouponApplied', version: 1, payload: { ...coupon } });
  }

  place(taxRateBasisPoints: number, reservationExpiresAt: string): void {
    this.assertTransition('Placed');
    if (this.state.lines.length === 0) {
      throw new EmptyOrderError(this.orderId);
    }
    const pricing = priceOrder({
      lines: this.state.lines,
      discountCodes: this.state.discountCodes,
      ...(this.state.coupon ? { coupon: this.state.coupon } : {}),
      taxRateBasisPoints,
    });
    this.raise({ type: 'OrderPlaced', version: 1, payload: { pricing, reservationExpiresAt } });
  }

  /** Records that every line's stock is held, which makes the order payable. */
  recordStockReserved(): void {
    if (this.state.status !== 'Placed' || this.state.stockReserved) {
      return;
    }
    this.raise({ type: 'OrderStockReserved', version: 1, payload: {} });
  }

  /** Throws unless a payment could be taken for this order right now. */
  assertPayable(now: number): void {
    this.assertTransition('Paid');
    if (!this.state.stockReserved) {
      throw new OrderAwaitingStockError(this.orderId);
    }
    const expiresAt = this.state.reservationExpiresAt!;
    if (hasReached(now, expiresAt)) {
      throw new ReservationExpiredError(this.orderId, expiresAt);
    }
  }

  markPaid(paymentId: string, amountCents: Cents, now: number): void {
    if (this.state.status === 'Paid' && this.state.paymentId === paymentId) {
      return;
    }
    this.assertPayable(now);
    if (amountCents !== this.totalCents) {
      throw new OrderPaymentMismatchError(this.orderId, this.totalCents, amountCents);
    }
    this.raise({ type: 'OrderPaid', version: 1, payload: { paymentId, amountCents } });
  }

  ship(trackingNumber: string): void {
    this.assertTransition('Shipped');
    if (trackingNumber.trim().length === 0) {
      throw new ValidationError('A tracking number is required to ship an order');
    }
    this.raise({ type: 'OrderShipped', version: 1, payload: { trackingNumber: trackingNumber.trim() } });
  }

  deliver(): void {
    this.assertTransition('Delivered');
    this.raise({ type: 'OrderDelivered', version: 1, payload: {} });
  }

  cancel(reason: 'customer-request' | 'out-of-stock'): void {
    if (this.state.status === 'Cancelled') {
      return;
    }
    this.assertTransition('Cancelled');
    this.raise({ type: 'OrderCancelled', version: 1, payload: { reason } });
  }

  /** Cancels a placed, unpaid order whose stock reservation has run out. */
  expireReservation(now: number): void {
    if (this.state.status === 'Cancelled') {
      return;
    }
    if (this.state.status !== 'Placed') {
      throw new InvalidOrderTransitionError(this.orderId, this.state.status, 'Cancelled');
    }
    const expiresAt = this.state.reservationExpiresAt!;
    if (!hasReached(now, expiresAt)) {
      throw new ReservationNotExpiredError(this.orderId, expiresAt);
    }
    this.raise({ type: 'OrderCancelled', version: 1, payload: { reason: 'reservation-expired' } });
  }

  /**
   * Refunds `quantity` units of one line. The refund carries the line's
   * discount, coupon and tax prorated to those units, so the total refunded
   * for a line can never exceed what was paid for it. Refunding the last
   * paid unit of the order moves it to Refunded.
   *
   * The event also records whether the units go back into stock, which is true
   * only while the order is Paid and nothing has shipped. The order decides it
   * here rather than letting fulfillment read the status later, because by then
   * the order may have shipped (§5.3, §3.2).
   *
   * It records separately how much money the refund actually pays back: a
   * credit comes off the last refunds, so once the balance is spent a refund
   * still moves its units, restocks them and closes the order, but returns
   * nothing (§5.4).
   */
  refundLine(refundId: string, lineId: string, quantity: number): void {
    if (this.state.refundIds.includes(refundId)) {
      return;
    }
    if (!REFUNDABLE_STATUSES.includes(this.state.status)) {
      throw new OrderNotRefundableError(this.orderId, this.state.status);
    }
    const line = this.pricedLine(lineId);
    const alreadyRefunded = this.refundedQuantity(lineId);
    const refundable = line.quantity - alreadyRefunded;
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new ValidationError(`Refund quantity must be a positive integer, got ${quantity}`);
    }
    if (quantity > refundable) {
      throw new RefundExceedsPaidError(this.orderId, lineId, quantity, refundable);
    }
    const refund = refundForUnits(line, alreadyRefunded, quantity);
    this.raise({
      type: 'OrderLineRefunded',
      version: 3,
      payload: {
        refundId,
        lineId,
        paymentId: this.state.paymentId!,
        refund,
        returnsToStock: this.state.status === 'Paid',
        paidBackCents: paidBackFor(this.state, refund.totalCents),
      },
    });
    if (this.allUnitsRefunded()) {
      this.raise({ type: 'OrderRefunded', version: 1, payload: { totalRefundedCents: this.state.returnedCents } });
    }
  }

  /**
   * Gives money back without refunding any units, such as a goodwill credit
   * for a late delivery. It is allowed in the same statuses as a unit refund,
   * changes neither the status nor stock, and draws on the same balance: a
   * credit larger than what is left to give back is refused (§5.4).
   *
   * The checks run in the same order as a unit refund's: an id the order has
   * already used — by a credit or by a refund — is a no-op before anything
   * else, then the status, then the input, then the balance.
   */
  credit(creditId: string, amountCents: number, reason: string): void {
    if (this.state.refundIds.includes(creditId)) {
      return;
    }
    if (!REFUNDABLE_STATUSES.includes(this.state.status)) {
      throw new OrderNotRefundableError(this.orderId, this.state.status);
    }
    const amount = creditAmount(amountCents);
    const trimmedReason = creditReason(reason);
    const refundable = this.refundableCents;
    if (amount > refundable) {
      throw new CreditExceedsRefundableError(this.orderId, amount, refundable);
    }
    this.raise({
      type: 'OrderCredited',
      version: 1,
      payload: { creditId, paymentId: this.state.paymentId!, amountCents: amount, reason: trimmedReason },
    });
  }

  protected evolve(state: OrderState, event: OrderEvent): OrderState {
    return evolveOrder(state, event);
  }

  private pricedLine(lineId: string): LinePricing {
    const line = this.state.pricing?.lines.find((candidate) => candidate.lineId === lineId);
    if (!line) {
      throw new OrderLineNotFoundError(this.orderId, lineId);
    }
    return line;
  }

  private allUnitsRefunded(): boolean {
    return (this.state.pricing?.lines ?? []).every((line) => this.refundedQuantity(line.lineId) >= line.quantity);
  }

  private assertDraft(): void {
    if (this.state.status !== 'Draft') {
      throw new OrderNotEditableError(this.orderId, this.state.status);
    }
  }

  private assertTransition(to: OrderStatus): void {
    if (!canTransition(this.state.status, to)) {
      throw new InvalidOrderTransitionError(this.orderId, this.state.status, to);
    }
  }
}
