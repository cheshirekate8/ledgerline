import { Payment } from '../../../src/payments/payment';
import { PaymentAlreadyCapturedError, RefundExceedsCapturedError } from '../../../src/payments/payment-errors';
import { ValidationError } from '../../../src/shared/errors';
import { InvalidMoneyError } from '../../../src/shared/money';

function capturedPayment(amountCents = 5_000): Payment {
  const payment = new Payment('p-1');
  payment.capture({ orderId: 'o-1', customerId: 'c-1', amountCents, method: 'card' });
  return payment;
}

describe('Payment', () => {
  it('captures once', () => {
    const payment = capturedPayment();
    expect(payment.status).toBe('captured');
    expect(payment.orderId).toBe('o-1');
    expect(payment.amountCents).toBe(5_000);
    expect(() =>
      payment.capture({ orderId: 'o-1', customerId: 'c-1', amountCents: 5_000, method: 'card' }),
    ).toThrow(PaymentAlreadyCapturedError);
  });

  it('starts pending and refuses refunds before capture', () => {
    const payment = new Payment('p-1');
    expect(payment.status).toBe('pending');
    expect(() => payment.refund('r-1', 1, 'x')).toThrow(ValidationError);
  });

  it('refuses fractional amounts and a missing method', () => {
    expect(() =>
      new Payment('p').capture({ orderId: 'o', customerId: 'c', amountCents: 10.5, method: 'card' }),
    ).toThrow(InvalidMoneyError);
    expect(() =>
      new Payment('p').capture({ orderId: 'o', customerId: 'c', amountCents: 10, method: ' ' }),
    ).toThrow(ValidationError);
  });

  it('allows partial refunds up to the captured amount', () => {
    const payment = capturedPayment(5_000);
    payment.refund('r-1', 1_200, 'damaged');
    expect(payment.status).toBe('partially-refunded');
    expect(payment.refundableCents).toBe(3_800);
    payment.refund('r-2', 3_800, 'returned');
    expect(payment.status).toBe('refunded');
    expect(payment.refundedCents).toBe(5_000);
  });

  it('never refunds more than was captured', () => {
    const payment = capturedPayment(5_000);
    payment.refund('r-1', 4_000, 'x');
    expect(() => payment.refund('r-2', 1_001, 'x')).toThrow(RefundExceedsCapturedError);
    expect(payment.refundedCents).toBe(4_000);
  });

  it('ignores a refund id it has already applied', () => {
    const payment = capturedPayment(5_000);
    payment.refund('r-1', 1_000, 'x');
    payment.refund('r-1', 1_000, 'x');
    expect(payment.refundedCents).toBe(1_000);
    expect(payment.peekPendingEvents().filter((e) => e.type === 'PaymentRefunded')).toHaveLength(1);
  });
});
