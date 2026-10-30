import { PaymentCommand } from '../../payments/payment-commands';
import { PAYMENT_AGGREGATE, PaymentCaptured, PaymentEvent } from '../../payments/payment-events';
import { CommandDispatcher } from '../../shared/commands/command';
import { isDomainError } from '../../shared/errors';
import { StoredEvent } from '../../shared/events/domain-event';
import { Logger, silentLogger } from '../../shared/logger';
import { EventSubscriber } from '../../shared/messaging/event-dispatcher';
import { OrderCommand } from '../order-commands';
import { ORDER_AGGREGATE, OrderEvent, OrderLineRefunded } from '../order-events';
import { causedBy } from './fulfillment-process';

export const COMPENSATION_REFUND_REASON = 'order-not-payable';

/**
 * Connects payments and orders. A captured payment marks its order paid;
 * if the order can no longer accept it (it expired, was cancelled or was
 * already paid by another payment) the payment is refunded in full rather
 * than kept. A refunded order line refunds the matching amount on the
 * order's payment.
 */
export class PaymentProcess implements EventSubscriber {
  readonly name = 'order-payments';
  readonly aggregateTypes = [PAYMENT_AGGREGATE, ORDER_AGGREGATE];

  constructor(
    private readonly commands: CommandDispatcher<OrderCommand | PaymentCommand>,
    private readonly logger: Logger = silentLogger,
  ) {}

  async handle(stored: StoredEvent): Promise<void> {
    const event = stored as StoredEvent<PaymentEvent | OrderEvent>;
    if (event.type === 'PaymentCaptured') {
      return this.markOrderPaid(event as StoredEvent<PaymentCaptured>);
    }
    if (event.type === 'OrderLineRefunded') {
      return this.refundPayment(event as StoredEvent<OrderLineRefunded>);
    }
    return undefined;
  }

  private async markOrderPaid(event: StoredEvent<PaymentCaptured>): Promise<void> {
    const { paymentId, orderId, amountCents } = event.payload;
    try {
      await this.commands.execute({
        type: 'MarkOrderPaid',
        idempotencyKey: `${event.eventId}:mark-paid`,
        payload: { orderId, paymentId, amountCents },
        ...causedBy(event),
      });
    } catch (error) {
      if (!isDomainError(error)) {
        throw error;
      }
      this.logger.warn('payment.compensated', { paymentId, orderId, amountCents, error });
      await this.commands.execute({
        type: 'RefundPayment',
        idempotencyKey: `${event.eventId}:compensate`,
        payload: {
          paymentId,
          refundId: `${event.eventId}:compensation`,
          amountCents,
          reason: COMPENSATION_REFUND_REASON,
        },
        ...causedBy(event),
      });
    }
  }

  private async refundPayment(event: StoredEvent<OrderLineRefunded>): Promise<void> {
    const { paymentId, refundId, refund, lineId } = event.payload;
    await this.commands.execute({
      type: 'RefundPayment',
      idempotencyKey: `${event.eventId}:refund-payment`,
      payload: { paymentId, refundId, amountCents: refund.totalCents, reason: `line ${lineId} refunded` },
      ...causedBy(event),
    });
  }
}
