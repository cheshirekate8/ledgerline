import { InvalidOrderTransitionError, ReservationExpiredError } from '../../src/orders/order-errors';
import { MINUTE_MS } from '../../src/shared/clock';
import { createTestApp, payOrder, placeOrder, stockItems } from '../support/test-app';

describe('stock reservation expiry', () => {
  it('releases the stock of an order left unpaid for 15 minutes', async () => {
    const testApp = createTestApp();
    const { app, clock, settle } = testApp;
    await stockItems(testApp, { MUG: 5 });
    await placeOrder(testApp, 'o-1', [['MUG', 2]]);
    await settle();
    expect(app.readModels.stockLevels.get('MUG')!.available).toBe(3);

    clock.advance(15 * MINUTE_MS - 1);
    expect(await app.expireReservations()).toEqual([]);
    clock.advance(1);
    expect(await app.expireReservations()).toEqual(['o-1']);
    await settle();

    expect(app.readModels.orderSummary.get('o-1')).toMatchObject({
      status: 'Cancelled',
      cancellationReason: 'reservation-expired',
      closedAt: '2026-06-01T09:15:00.000Z',
    });
    expect(app.readModels.stockLevels.get('MUG')).toMatchObject({ onHand: 5, reserved: 0, available: 5 });
    await expect(payOrder(testApp, 'o-1')).rejects.toBeInstanceOf(InvalidOrderTransitionError);
  });

  it('refuses payment once the window has closed even before the expiry sweep runs', async () => {
    const testApp = createTestApp();
    await stockItems(testApp, { MUG: 5 });
    await placeOrder(testApp, 'o-1', [['MUG', 2]]);
    await testApp.settle();
    testApp.clock.advance(15 * MINUTE_MS);
    await expect(payOrder(testApp, 'o-1')).rejects.toBeInstanceOf(ReservationExpiredError);
  });

  it('refunds a payment captured just before the window closed but processed after expiry', async () => {
    const testApp = createTestApp();
    const { app, clock, settle } = testApp;
    await stockItems(testApp, { MUG: 5 });
    await placeOrder(testApp, 'o-1', [['MUG', 2]]);
    await settle();

    clock.advance(15 * MINUTE_MS - 1);
    await payOrder(testApp, 'o-1');
    clock.advance(1);
    await app.expireReservations();
    await settle();

    expect(app.readModels.orderSummary.get('o-1')!.status).toBe('Cancelled');
    expect(app.readModels.stockLevels.get('MUG')!.available).toBe(5);
    expect(app.readModels.dailyRevenue.get('2026-06-01')).toMatchObject({
      capturedCents: 4_328,
      refundedCents: 4_328,
      netCents: 0,
    });
    expect(testApp.logs.messages()).toContain('payment.compensated');
  });

  it('keeps stock held for an order paid in time', async () => {
    const testApp = createTestApp();
    const { app, clock, settle } = testApp;
    await stockItems(testApp, { MUG: 5 });
    await placeOrder(testApp, 'o-1', [['MUG', 2]]);
    await settle();
    clock.advance(10 * MINUTE_MS);
    await payOrder(testApp, 'o-1');
    await settle();
    clock.advance(10 * MINUTE_MS);
    expect(await app.expireReservations()).toEqual([]);
    expect(app.readModels.stockLevels.get('MUG')).toMatchObject({ onHand: 3, reserved: 0, available: 3 });
  });

  it('honours a configured reservation window', async () => {
    const testApp = createTestApp({ reservationTtlMs: 5 * MINUTE_MS });
    await stockItems(testApp, { MUG: 5 });
    await placeOrder(testApp, 'o-1', [['MUG', 2]]);
    testApp.clock.advance(5 * MINUTE_MS);
    expect(await testApp.app.expireReservations()).toEqual(['o-1']);
  });
});
