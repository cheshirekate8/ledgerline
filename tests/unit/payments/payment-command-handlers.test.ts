import { paymentCommandHandlers } from '../../../src/payments/payment-command-handlers';
import { PayableOrderLookup, PaymentCommand } from '../../../src/payments/payment-commands';
import { PaymentAmountMismatchError, PaymentNotFoundError } from '../../../src/payments/payment-errors';
import { PAYMENT_EVENT_TYPES } from '../../../src/payments/payment-events';
import { createPaymentRepository } from '../../../src/payments/payment-repository';
import { CommandBus } from '../../../src/shared/commands/command-bus';
import { ValidationError } from '../../../src/shared/errors';
import { cents } from '../../../src/shared/money';
import { testDependencies } from '../../support/dependencies';

class OrderNotPayable extends ValidationError {}

function setup() {
  const infrastructure = testDependencies(PAYMENT_EVENT_TYPES);
  const repository = createPaymentRepository(infrastructure.dependencies);
  const orders: PayableOrderLookup = {
    payableOrder: (orderId) => {
      if (orderId !== 'o-1') {
        throw new OrderNotPayable(`order ${orderId} cannot be paid`);
      }
      return { orderId, customerId: 'c-1', totalCents: cents(7_737) };
    },
  };
  const bus = new CommandBus<PaymentCommand>().registerAll(paymentCommandHandlers(repository, orders));
  return { ...infrastructure, repository, bus };
}

const capture = (orderId = 'o-1', amountCents = 7_737, key = 'capture-1'): PaymentCommand => ({
  type: 'CapturePayment',
  idempotencyKey: key,
  payload: { paymentId: 'p-1', orderId, amountCents, method: 'card' },
});

describe('payment command handlers', () => {
  it('captures a payment for the exact order total', async () => {
    const { bus, store } = setup();
    await bus.execute(capture());
    expect(store.readStream('payment', 'p-1')[0]).toMatchObject({
      type: 'PaymentCaptured',
      payload: { orderId: 'o-1', customerId: 'c-1', amountCents: 7_737, method: 'card' },
    });
  });

  it('refuses a payment that does not match the order total', async () => {
    const { bus } = setup();
    await expect(bus.execute(capture('o-1', 7_736))).rejects.toBeInstanceOf(PaymentAmountMismatchError);
  });

  it('refuses a payment for an order that cannot be paid', async () => {
    const { bus, store } = setup();
    await expect(bus.execute(capture('o-2'))).rejects.toBeInstanceOf(OrderNotPayable);
    expect(store.readAll()).toHaveLength(0);
  });

  it('captures a redelivered payment once', async () => {
    const { bus, store } = setup();
    await bus.execute(capture());
    expect((await bus.execute(capture())).duplicate).toBe(true);
    expect(store.readAll()).toHaveLength(1);
  });

  it('refunds a captured payment', async () => {
    const { bus, repository } = setup();
    await bus.execute(capture());
    await bus.execute({
      type: 'RefundPayment',
      idempotencyKey: 'refund-1',
      payload: { paymentId: 'p-1', refundId: 'r-1', amountCents: 1_821, reason: 'returned' },
    });
    expect(repository.load('p-1')!.refundedCents).toBe(1_821);
  });

  it('refuses a refund for an unknown payment', async () => {
    const { bus } = setup();
    await expect(
      bus.execute({
        type: 'RefundPayment',
        idempotencyKey: 'refund-1',
        payload: { paymentId: 'ghost', refundId: 'r-1', amountCents: 1, reason: 'x' },
      }),
    ).rejects.toBeInstanceOf(PaymentNotFoundError);
  });
});
