import { FulfillmentProcess } from '../../../src/orders/process/fulfillment-process';
import { COMPENSATION_REFUND_REASON, PaymentProcess } from '../../../src/orders/process/payment-process';
import { MINUTE_MS } from '../../../src/shared/clock';
import { JsonLogger, MemoryLogSink } from '../../../src/shared/logger';
import { domainHarness } from '../../support/domain-harness';

async function setup() {
  const harness = domainHarness();
  const sink = new MemoryLogSink();
  const process = new PaymentProcess(harness.bus, new JsonLogger({ sink: sink.write, clock: harness.clock }));
  const fulfillment = new FulfillmentProcess({
    commands: harness.bus,
    orders: harness.orders,
    inventory: harness.inventory,
  });
  await harness.stock('MUG', 10);
  await harness.placeOrder('o-1', [['MUG', 3]]);
  await fulfillment.handle(harness.lastEvent('OrderPlaced'));
  const total = harness.orders.load('o-1')!.totalCents;
  const capture = (paymentId = 'p-1') =>
    harness.run({ type: 'CapturePayment', payload: { paymentId, orderId: 'o-1', amountCents: total, method: 'card' } });
  return { ...harness, process, sink, total, capture };
}

describe('PaymentProcess', () => {
  it('marks the order paid when its payment is captured', async () => {
    const { process, capture, lastEvent, orders } = await setup();
    await capture();
    await process.handle(lastEvent('PaymentCaptured'));
    expect(orders.load('o-1')!.status).toBe('Paid');
    expect(orders.load('o-1')!.paymentId).toBe('p-1');
  });

  it('refunds the payment in full when the order expired before it could be marked paid', async () => {
    const { process, capture, lastEvent, orders, payments, run, clock, total, sink } = await setup();
    await capture();
    clock.advance(15 * MINUTE_MS);
    await run({ type: 'ExpireOrderReservation', payload: { orderId: 'o-1' } });

    await process.handle(lastEvent('PaymentCaptured'));
    expect(orders.load('o-1')!.status).toBe('Cancelled');
    const payment = payments.load('p-1')!;
    expect(payment.status).toBe('refunded');
    expect(payment.refundedCents).toBe(total);
    expect(lastEvent('PaymentRefunded').payload).toMatchObject({ reason: COMPENSATION_REFUND_REASON });
    expect(sink.entries()[0]).toMatchObject({ msg: 'payment.compensated', paymentId: 'p-1' });
  });

  it('refunds a second payment captured for the same order before either was processed', async () => {
    const { process, capture, store, payments, orders } = await setup();
    await capture('p-1');
    await capture('p-2');
    for (const event of store.readAll().filter((candidate) => candidate.type === 'PaymentCaptured')) {
      await process.handle(event);
    }
    expect(orders.load('o-1')!.paymentId).toBe('p-1');
    expect(payments.load('p-2')!.status).toBe('refunded');
    expect(payments.load('p-1')!.status).toBe('captured');
  });

  it('refunds the payment for each refunded order line', async () => {
    const { process, capture, lastEvent, payments, run } = await setup();
    await capture();
    await process.handle(lastEvent('PaymentCaptured'));
    await run({ type: 'RefundOrderLine', payload: { orderId: 'o-1', lineId: 'o-1-l1', quantity: 1, refundId: 'r-1' } });

    const refunded = lastEvent('OrderLineRefunded');
    await process.handle(refunded);
    await process.handle(refunded);
    const payment = payments.load('p-1')!;
    expect(payment.refundedCents).toBe((refunded.payload as { refund: { totalCents: number } }).refund.totalCents);
    expect(payment.status).toBe('partially-refunded');
  });

  it('ignores events it does not act on', async () => {
    const { process, lastEvent } = await setup();
    await expect(process.handle(lastEvent('OrderCreated'))).resolves.toBeUndefined();
  });
});
