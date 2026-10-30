import { OrderAwaitingStockError } from '../../src/orders/order-errors';
import { createTestApp, payOrder, placeOrder, stockItems } from '../support/test-app';

describe('order lifecycle through the queue', () => {
  it('takes an order from draft to a partial refund and keeps every read model in step', async () => {
    const testApp = createTestApp();
    const { app, run, settle } = testApp;
    await stockItems(testApp, { MUG: 10, TEE: 5 });
    await placeOrder(testApp, 'o-1', [['MUG', 3], ['TEE', 1]], { discountCodes: ['TEN'], coupon: 'FIVE' });

    const earlyPayment = run({
      type: 'CapturePayment',
      payload: { paymentId: 'too-soon', orderId: 'o-1', amountCents: 7_737, method: 'card' },
    });
    await expect(earlyPayment).rejects.toBeInstanceOf(OrderAwaitingStockError);
    expect(app.readModels.orderSummary.get('o-1')).toBeUndefined();
    await settle();
    expect(app.readModels.stockLevels.get('MUG')).toMatchObject({ onHand: 10, reserved: 3, available: 7 });
    expect(app.readModels.orderSummary.get('o-1')).toMatchObject({ status: 'Placed', stockReserved: true });

    await payOrder(testApp, 'o-1');
    await settle();
    expect(app.readModels.orderSummary.get('o-1')).toMatchObject({ status: 'Paid', paymentId: 'pay-o-1' });
    expect(app.readModels.stockLevels.get('MUG')).toMatchObject({ onHand: 7, reserved: 0, available: 7 });
    expect(app.readModels.stockLevels.get('TEE')).toMatchObject({ onHand: 4, reserved: 0, available: 4 });

    await run({ type: 'ShipOrder', payload: { orderId: 'o-1', trackingNumber: 'TRK-1' } });
    await run({ type: 'DeliverOrder', payload: { orderId: 'o-1' } });
    await run({ type: 'RefundOrderLine', payload: { orderId: 'o-1', lineId: 'o-1-l1', quantity: 1, refundId: 'r-1' } });
    await settle();

    expect(app.readModels.orderSummary.get('o-1')).toMatchObject({
      status: 'Delivered',
      totalCents: 7_737,
      refundedCents: 1_821,
    });
    expect(app.readModels.dailyRevenue.get('2026-06-01')).toEqual({
      day: '2026-06-01',
      capturedCents: 7_737,
      refundedCents: 1_821,
      netCents: 5_916,
      paymentCount: 1,
      refundCount: 1,
    });
    expect(app.readModels.customerHistory.get('alice')).toMatchObject({
      orderCount: 1,
      lifetimeSpendCents: 5_916,
    });
  });

  it('moves a fully refunded order to Refunded and returns every cent paid', async () => {
    const testApp = createTestApp();
    const { app, run, settle } = testApp;
    await stockItems(testApp, { MUG: 10, TEE: 5 });
    await placeOrder(testApp, 'o-1', [['MUG', 3], ['TEE', 1]], { discountCodes: ['TEN'], coupon: 'FIVE' });
    await settle();
    await payOrder(testApp, 'o-1');
    await settle();

    for (const [refundId, lineId, quantity] of [
      ['r-1', 'o-1-l1', 1],
      ['r-2', 'o-1-l2', 1],
      ['r-3', 'o-1-l1', 2],
    ] as const) {
      await run({ type: 'RefundOrderLine', payload: { orderId: 'o-1', lineId, quantity, refundId } });
    }
    await settle();

    expect(app.readModels.orderSummary.get('o-1')).toMatchObject({ status: 'Refunded', refundedCents: 7_737 });
    expect(app.readModels.dailyRevenue.get('2026-06-01')).toMatchObject({ netCents: 0, refundCount: 3 });
  });

  it('credits an order by amount and takes the credit off the last refunds', async () => {
    const testApp = createTestApp();
    const { app, run, settle } = testApp;
    await stockItems(testApp, { MUG: 10, TEE: 5 });
    await placeOrder(testApp, 'o-1', [['MUG', 3], ['TEE', 1]], { discountCodes: ['TEN'], coupon: 'FIVE' });
    await settle();
    await payOrder(testApp, 'o-1');
    await settle();

    const credit = { orderId: 'o-1', amountCents: 7_000, reason: 'late delivery', creditId: 'c-1' };
    await run({ type: 'CreditOrder', payload: credit });
    await settle();
    // The credit moves money without moving units, stock or status.
    expect(app.readModels.orderSummary.get('o-1')).toMatchObject({ status: 'Paid', refundedCents: 7_000 });
    expect(app.readModels.stockLevels.get('MUG')).toMatchObject({ onHand: 7, available: 7 });

    for (const [refundId, lineId, quantity] of [
      ['r-1', 'o-1-l1', 3],
      ['r-2', 'o-1-l2', 1],
    ] as const) {
      await run({ type: 'RefundOrderLine', payload: { orderId: 'o-1', lineId, quantity, refundId } });
    }
    await settle();

    // 5_463 of goods were worth refunding but only 737 was left to give back.
    expect(app.readModels.orderSummary.get('o-1')).toMatchObject({ status: 'Refunded', refundedCents: 7_737 });
    expect(app.readModels.stockLevels.get('MUG')).toMatchObject({ onHand: 10, available: 10 });
    expect(app.readModels.dailyRevenue.get('2026-06-01')).toMatchObject({ netCents: 0, refundCount: 2 });
    expect(app.readModels.customerHistory.get('alice')).toMatchObject({ lifetimeSpendCents: 0 });
  });

  it('cancels an order as out of stock when another order took the last units', async () => {
    const testApp = createTestApp();
    const { app, settle } = testApp;
    await stockItems(testApp, { MUG: 4, TEE: 5 });
    await placeOrder(testApp, 'first', [['MUG', 3]]);
    await placeOrder(testApp, 'second', [['TEE', 2], ['MUG', 2]], { customerId: 'bob' });
    await settle();

    expect(app.readModels.orderSummary.get('first')).toMatchObject({ status: 'Placed', stockReserved: true });
    expect(app.readModels.orderSummary.get('second')).toMatchObject({
      status: 'Cancelled',
      cancellationReason: 'out-of-stock',
    });
    expect(app.readModels.stockLevels.all()).toEqual([
      { sku: 'MUG', name: 'mug', onHand: 4, reserved: 3, available: 1 },
      { sku: 'TEE', name: 'tee', onHand: 5, reserved: 0, available: 5 },
    ]);
  });

  it('writes one structured log line per handled event', async () => {
    const testApp = createTestApp();
    await stockItems(testApp, { MUG: 10 });
    await placeOrder(testApp, 'o-1', [['MUG', 1]]);
    const report = await testApp.settle();

    const handled = testApp.logs.entries().filter((entry) => entry['msg'] === 'message.handled');
    expect(handled).toHaveLength(report.handled);
    expect(handled[0]).toEqual(
      expect.objectContaining({
        ts: '2026-06-01T09:00:00.000Z',
        level: 'info',
        component: 'worker-pool',
        subscriber: expect.any(String),
        eventType: expect.any(String),
        eventVersion: 1,
        aggregateId: expect.any(String),
        sequence: expect.any(Number),
        attempt: 1,
      }),
    );
    expect(testApp.logs.lines.every((line) => !line.includes('\n'))).toBe(true);
  });
});
