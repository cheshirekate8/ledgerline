import { RepositoryDependencies } from '../../src/shared/aggregates/aggregate-repository';
import { FixedClock } from '../../src/shared/clock';
import { InMemoryEventStore } from '../../src/shared/events/in-memory-event-store';
import { UpcasterRegistry } from '../../src/shared/events/upcaster-registry';
import { SeededIdGenerator } from '../../src/shared/ids';

export const START_TIME = '2026-06-01T09:00:00.000Z';

/** Deterministic infrastructure for testing one domain in isolation. */
export function testDependencies(eventTypes: readonly string[], seed = 1) {
  const clock = new FixedClock(START_TIME);
  const store = new InMemoryEventStore();
  const upcasters = new UpcasterRegistry().declareAll(eventTypes);
  const ids = new SeededIdGenerator(seed);
  const dependencies: RepositoryDependencies = { clock, store, upcasters, ids };
  return { clock, store, upcasters, ids, dependencies };
}

export const context = (idempotencyKey = 'test-key') => ({ metadata: { idempotencyKey } });
