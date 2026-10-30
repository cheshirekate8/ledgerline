import { AggregateRoot } from '../../src/shared/aggregates/aggregate-root';
import { EventData, NewEvent } from '../../src/shared/events/domain-event';
import { UpcasterRegistry } from '../../src/shared/events/upcaster-registry';

/** A minimal aggregate used to exercise the shared event-sourcing machinery. */
export type CounterEvent =
  | EventData<'CounterIncremented', { by: number }>
  | EventData<'CounterReset', Record<string, never>>;

export interface CounterState {
  total: number;
  increments: number;
}

export class Counter extends AggregateRoot<CounterState, CounterEvent> {
  readonly aggregateType = 'counter';

  constructor(id: string) {
    super(id, { total: 0, increments: 0 });
  }

  get total(): number {
    return this.state.total;
  }

  get increments(): number {
    return this.state.increments;
  }

  increment(by: number): void {
    this.raise({ type: 'CounterIncremented', version: 1, payload: { by } });
  }

  reset(): void {
    this.raise({ type: 'CounterReset', version: 1, payload: {} });
  }

  protected evolve(state: CounterState, event: CounterEvent): CounterState {
    switch (event.type) {
      case 'CounterIncremented':
        return { total: state.total + event.payload.by, increments: state.increments + 1 };
      case 'CounterReset':
        return { total: 0, increments: state.increments };
    }
  }
}

export function counterUpcasters(): UpcasterRegistry {
  return new UpcasterRegistry().declareAll(['CounterIncremented', 'CounterReset']);
}

let eventCounter = 0;

export function newEvent(type: string, payload: unknown = {}, overrides: Partial<NewEvent> = {}): NewEvent {
  eventCounter += 1;
  return {
    type,
    version: 1,
    payload,
    eventId: `evt-${eventCounter}`,
    occurredAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}
