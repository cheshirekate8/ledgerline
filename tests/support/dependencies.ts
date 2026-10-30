import { ALL_UPCASTERS, EVENT_VERSIONS } from '../../src/app/ledgerline-commands';
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
  const upcasters = new UpcasterRegistry();
  for (const type of eventTypes) {
    upcasters.declare(type, EVENT_VERSIONS[type] ?? 1);
  }
  for (const upcaster of ALL_UPCASTERS.filter((candidate) => eventTypes.includes(candidate.type))) {
    upcasters.register(upcaster);
  }
  const ids = new SeededIdGenerator(seed);
  const dependencies: RepositoryDependencies = { clock, store, upcasters, ids };
  return { clock, store, upcasters, ids, dependencies };
}

export const context = (idempotencyKey = 'test-key') => ({ metadata: { idempotencyKey } });
