import { StoredEvent } from '../shared/events/domain-event';
import { Cents, cents } from '../shared/money';
import { Projection } from '../shared/projections/projection';
import { utcDay } from '../shared/time';
import { PAYMENT_AGGREGATE, PaymentEvent } from './payment-events';

export interface DailyRevenue {
  /** UTC calendar day, YYYY-MM-DD. */
  readonly day: string;
  readonly capturedCents: Cents;
  readonly refundedCents: Cents;
  /** Captured minus refunded on this day; negative when refunds outweigh sales. */
  readonly netCents: Cents;
  readonly paymentCount: number;
  readonly refundCount: number;
}

interface MutableDay {
  captured: number;
  refunded: number;
  payments: number;
  refunds: number;
}

/**
 * Money in and out per UTC day. Captures count on the day they happen and
 * refunds on the day they are issued, which may be a later day.
 */
export class DailyRevenueProjection implements Projection {
  readonly name = 'daily-revenue';
  readonly aggregateTypes = [PAYMENT_AGGREGATE];
  private days = new Map<string, MutableDay>();

  apply(stored: StoredEvent): void {
    const event = stored as StoredEvent<PaymentEvent>;
    const day = this.dayFor(utcDay(event.occurredAt));
    switch (event.type) {
      case 'PaymentCaptured':
        day.captured += event.payload.amountCents;
        day.payments += 1;
        break;
      case 'PaymentRefunded':
        day.refunded += event.payload.amountCents;
        day.refunds += 1;
        break;
    }
  }

  reset(): void {
    this.days = new Map();
  }

  get(day: string): DailyRevenue | undefined {
    const entry = this.days.get(day);
    return entry ? toDailyRevenue(day, entry) : undefined;
  }

  all(): DailyRevenue[] {
    return [...this.days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, entry]) => toDailyRevenue(day, entry));
  }

  private dayFor(day: string): MutableDay {
    let entry = this.days.get(day);
    if (!entry) {
      entry = { captured: 0, refunded: 0, payments: 0, refunds: 0 };
      this.days.set(day, entry);
    }
    return entry;
  }
}

function toDailyRevenue(day: string, entry: MutableDay): DailyRevenue {
  return {
    day,
    capturedCents: cents(entry.captured),
    refundedCents: cents(entry.refunded),
    netCents: cents(entry.captured - entry.refunded),
    paymentCount: entry.payments,
    refundCount: entry.refunds,
  };
}
