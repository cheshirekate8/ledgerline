import { OutOfOrderEventError } from '../../../../src/shared/errors';
import { StoredEvent } from '../../../../src/shared/events/domain-event';
import { InMemoryEventStore } from '../../../../src/shared/events/in-memory-event-store';
import { UpcasterRegistry } from '../../../../src/shared/events/upcaster-registry';
import { Projection, ProjectionHost } from '../../../../src/shared/projections/projection';
import { newEvent } from '../../../support/counter';

class EventCount implements Projection {
  readonly name = 'event-count';
  readonly aggregateTypes = ['order'];
  counts = new Map<string, number>();

  apply(event: StoredEvent): void {
    this.counts.set(event.aggregateId, (this.counts.get(event.aggregateId) ?? 0) + 1);
  }

  reset(): void {
    this.counts = new Map();
  }
}

function setup() {
  const store = new InMemoryEventStore();
  const host = new ProjectionHost(new EventCount(), new UpcasterRegistry().declareAll(['A', 'B']));
  return { store, host };
}

describe('ProjectionHost', () => {
  it('applies events in sequence and ignores redeliveries', () => {
    const { store, host } = setup();
    const [first, second] = store.append('order', 'o-1', 0, [newEvent('A'), newEvent('B')]);
    host.handle(first!);
    host.handle(second!);
    host.handle(first!);
    host.handle(second!);
    expect(host.projection.counts.get('o-1')).toBe(2);
    expect(host.lastSequence('order', 'o-1')).toBe(2);
  });

  it('refuses an event that skips ahead of its stream', () => {
    const { store, host } = setup();
    const [first, , third] = store.append('order', 'o-1', 0, [newEvent('A'), newEvent('B'), newEvent('A')]);
    host.handle(first!);
    expect(() => host.handle(third!)).toThrow(OutOfOrderEventError);
    expect(host.projection.counts.get('o-1')).toBe(1);
  });

  it('ignores aggregate types it does not follow', () => {
    const { store, host } = setup();
    const [event] = store.append('payment', 'p-1', 0, [newEvent('A')]);
    host.handle(event!);
    expect(host.projection.counts.size).toBe(0);
  });

  it('rebuilds from the store to the same state as live handling', () => {
    const { store, host } = setup();
    for (const event of [
      ...store.append('order', 'o-1', 0, [newEvent('A'), newEvent('B')]),
      ...store.append('payment', 'p-1', 0, [newEvent('A')]),
      ...store.append('order', 'o-2', 0, [newEvent('A')]),
    ]) {
      host.handle(event);
    }
    const live = new Map(host.projection.counts);
    host.rebuild(store);
    expect(host.projection.counts).toEqual(live);
  });

  it('skips live deliveries already covered by a rebuild', () => {
    const { store, host } = setup();
    const [event] = store.append('order', 'o-1', 0, [newEvent('A')]);
    host.rebuild(store);
    host.handle(event!);
    expect(host.projection.counts.get('o-1')).toBe(1);
  });
});
