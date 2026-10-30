import { HandlerMap } from '../shared/commands/command';
import { cents } from '../shared/money';
import { Payment } from './payment';
import { PayableOrderLookup, PaymentCommand } from './payment-commands';
import { PaymentAmountMismatchError, PaymentNotFoundError } from './payment-errors';
import { PaymentRepository } from './payment-repository';

export function paymentCommandHandlers(
  repository: PaymentRepository,
  orders: PayableOrderLookup,
): HandlerMap<PaymentCommand> {
  return {
    CapturePayment: ({ payload }, { metadata }) => {
      const order = orders.payableOrder(payload.orderId);
      const amount = cents(payload.amountCents);
      if (amount !== order.totalCents) {
        throw new PaymentAmountMismatchError(order.orderId, order.totalCents, amount);
      }
      const payment = repository.load(payload.paymentId) ?? new Payment(payload.paymentId);
      payment.capture({
        orderId: order.orderId,
        customerId: order.customerId,
        amountCents: amount,
        method: payload.method,
      });
      const events = repository.save(payment, metadata);
      return { aggregateId: payment.paymentId, version: payment.version, events };
    },
    RefundPayment: ({ payload }, { metadata }) => {
      const payment = repository.load(payload.paymentId);
      if (!payment) {
        throw new PaymentNotFoundError(payload.paymentId);
      }
      payment.refund(payload.refundId, payload.amountCents, payload.reason);
      const events = repository.save(payment, metadata);
      return { aggregateId: payment.paymentId, version: payment.version, events };
    },
  };
}
