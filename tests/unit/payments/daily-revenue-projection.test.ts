import { DailyRevenueProjection } from '../../../src/payments/daily-revenue-projection';
import { Payment } from '../../../src/payments/payment';
import { PAYMENT_EVENT_TYPES } from '../../../src/payments/payment-events';
import { createPaymentRepository } from '../../../src/payments/payment-repository';
import { HOUR_MS } from '../../../src/shared/clock';
import { ProjectionHost } from '../../../src/shared/projections/projection';
import { testDependencies } from '../../support/dependencies';

function setup() {
  const infrastructure = testDependencies(PAYMENT_EVENT_TYPES);
  const repository = createPaymentRepository(infrastructure.dependencies);
  const host = new ProjectionHost(new DailyRevenueProjection(), infrastructure.upcasters);
  const capture = (paymentId: string, amountCents: number) => {
    const payment = new Payment(paymentId);
    payment.capture({ orderId: `order-${paymentId}`, customerId: 'c-1', amountCents, method: 'card' });
    repository.save(payment);
  };
  const refund = (paymentId: string, refundId: string, amountCents: number) => {
    const payment = repository.load(paymentId)!;
    payment.refund(refundId, amountCents, 'returned');
    repository.save(payment);
  };
  return { ...infrastructure, host, capture, refund };
}

describe('DailyRevenueProjection', () => {
  it('totals captures and refunds per UTC day', () => {
    const { clock, store, host, capture, refund } = setup();
    capture('p-1', 5_000);
    capture('p-2', 2_500);
    refund('p-1', 'r-1', 1_000);
    clock.advance(24 * HOUR_MS);
    refund('p-2', 'r-2', 2_500);
    capture('p-3', 900);

    host.rebuild(store);
    expect(host.projection.all()).toEqual([
      {
        day: '2026-06-01',
        capturedCents: 7_500,
        refundedCents: 1_000,
        netCents: 6_500,
        paymentCount: 2,
        refundCount: 1,
      },
      {
        day: '2026-06-02',
        capturedCents: 900,
        refundedCents: 2_500,
        netCents: -1_600,
        paymentCount: 1,
        refundCount: 1,
      },
    ]);
  });

  it('splits days at midnight UTC', () => {
    const { clock, store, host, capture } = setup();
    clock.set('2026-06-01T23:59:59.999Z');
    capture('p-1', 100);
    clock.advance(1);
    capture('p-2', 200);
    host.rebuild(store);
    expect(host.projection.get('2026-06-01')!.capturedCents).toBe(100);
    expect(host.projection.get('2026-06-02')!.capturedCents).toBe(200);
    expect(host.projection.get('2026-06-03')).toBeUndefined();
  });

  it('is empty after a reset', () => {
    const { store, host, capture } = setup();
    capture('p-1', 100);
    host.rebuild(store);
    host.projection.reset();
    expect(host.projection.all()).toEqual([]);
  });
});
