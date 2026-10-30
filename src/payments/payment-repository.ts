import { AggregateRepository, RepositoryDependencies } from '../shared/aggregates/aggregate-repository';
import { Payment, PaymentState } from './payment';
import { PAYMENT_AGGREGATE, PaymentEvent } from './payment-events';

export type PaymentRepository = AggregateRepository<PaymentState, PaymentEvent, Payment>;

export function createPaymentRepository(dependencies: RepositoryDependencies): PaymentRepository {
  return new AggregateRepository<PaymentState, PaymentEvent, Payment>({
    ...dependencies,
    aggregateType: PAYMENT_AGGREGATE,
    create: (paymentId) => new Payment(paymentId),
  });
}
