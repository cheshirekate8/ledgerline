import { ConcurrencyError } from '../../../../src/shared/errors';
import { StoredEvent } from '../../../../src/shared/events/domain-event';
import { DuplicateEventIdError, InvalidEventError } from '../../../../src/shared/events/event-store';
import { InMemoryEventStore } from '../../../../src/shared/events/in-memory-event-store';
import { newEvent } from '../../../support/counter';

describe('InMemoryEventStore', () => {
  it('assigns per-stream sequences and global positions', () => {
    const store = new InMemoryEventStore();
    store.append('order', 'a', 0, [newEvent('One'), newEvent('Two')]);
    store.append('order', 'b', 0, [newEvent('One')]);
    store.append('order', 'a', 2, [newEvent('Three')]);

    expect(store.readStream('order', 'a').map((e) => [e.type, e.sequence, e.position])).toEqual([
      ['One', 1, 1],
      ['Two', 2, 2],
      ['Three', 3, 4],
    ]);
    expect(store.readAll().map((e) => e.position)).toEqual([1, 2, 3, 4]);
    expect(store.currentSequence('order', 'a')).toBe(3);
    expect(store.currentSequence('order', 'missing')).toBe(0);
  });

  it('keeps streams of different aggregate types apart', () => {
    const store = new InMemoryEventStore();
    store.append('order', 'x', 0, [newEvent('A')]);
    store.append('payment', 'x', 0, [newEvent('B')]);
    expect(store.readStream('order', 'x')).toHaveLength(1);
    expect(store.listAggregateIds('order')).toEqual(['x']);
    expect(store.listAggregateIds('payment')).toEqual(['x']);
    expect(store.listAggregateIds('inventory')).toEqual([]);
  });

  it('rejects an append based on a stale sequence and writes nothing', () => {
    const store = new InMemoryEventStore();
    store.append('order', 'a', 0, [newEvent('One')]);
    expect(() => store.append('order', 'a', 0, [newEvent('Two')])).toThrow(ConcurrencyError);
    expect(store.readAll()).toHaveLength(1);
  });

  it('reads from a sequence or position onwards', () => {
    const store = new InMemoryEventStore();
    store.append('order', 'a', 0, [newEvent('One'), newEvent('Two'), newEvent('Three')]);
    expect(store.readStream('order', 'a', 2).map((e) => e.type)).toEqual(['Three']);
    expect(store.readAll(1).map((e) => e.type)).toEqual(['Two', 'Three']);
  });

  it('stores immutable records', () => {
    const store = new InMemoryEventStore();
    const [stored] = store.append('order', 'a', 0, [newEvent('One', { nested: { n: 1 } })]);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen((stored!.payload as { nested: object }).nested)).toBe(true);
  });

  it('refuses duplicate event ids, within and across batches', () => {
    const store = new InMemoryEventStore();
    store.append('order', 'a', 0, [newEvent('One', {}, { eventId: 'same' })]);
    expect(() => store.append('order', 'b', 0, [newEvent('One', {}, { eventId: 'same' })])).toThrow(
      DuplicateEventIdError,
    );
    expect(() =>
      store.append('order', 'c', 0, [
        newEvent('One', {}, { eventId: 'twin' }),
        newEvent('Two', {}, { eventId: 'twin' }),
      ]),
    ).toThrow(DuplicateEventIdError);
    expect(store.readAll()).toHaveLength(1);
  });

  it.each([
    ['an empty type', { type: '' }],
    ['a zero version', { version: 0 }],
    ['an unparseable timestamp', { occurredAt: 'soon' }],
    ['an empty event id', { eventId: '' }],
  ])('rejects events with %s', (_label, overrides) => {
    const store = new InMemoryEventStore();
    expect(() => store.append('order', 'a', 0, [newEvent('One', {}, overrides)])).toThrow(InvalidEventError);
  });

  it('notifies subscribers once per append with the stored batch', () => {
    const store = new InMemoryEventStore();
    const batches: StoredEvent[][] = [];
    const unsubscribe = store.subscribe((events) => batches.push([...events]));
    store.append('order', 'a', 0, [newEvent('One'), newEvent('Two')]);
    unsubscribe();
    store.append('order', 'a', 2, [newEvent('Three')]);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it('treats an empty append as a concurrency-checked no-op', () => {
    const store = new InMemoryEventStore();
    expect(store.append('order', 'a', 0, [])).toEqual([]);
    expect(() => store.append('order', 'a', 1, [])).toThrow(ConcurrencyError);
  });
});
