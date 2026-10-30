import { AggregateRepository } from '../../../../src/shared/aggregates/aggregate-repository';
import { FixedClock } from '../../../../src/shared/clock';
import { ConcurrencyError } from '../../../../src/shared/errors';
import { InMemoryEventStore } from '../../../../src/shared/events/in-memory-event-store';
import { SeededIdGenerator } from '../../../../src/shared/ids';
import { snapshotPolicy, SnapshotPolicy } from '../../../../src/shared/snapshots/snapshot-policy';
import { InMemorySnapshotStore } from '../../../../src/shared/snapshots/snapshot-store';
import { Counter, CounterEvent, CounterState, counterUpcasters } from '../../../support/counter';

function setup(policy?: SnapshotPolicy, schemaVersion?: number) {
  const store = new InMemoryEventStore();
  const snapshots = new InMemorySnapshotStore();
  const repository = new AggregateRepository<CounterState, CounterEvent, Counter>({
    aggregateType: 'counter',
    create: (id) => new Counter(id),
    store,
    upcasters: counterUpcasters(),
    ids: new SeededIdGenerator(1),
    clock: new FixedClock('2026-02-01T10:00:00.000Z'),
    snapshots,
    ...(policy ? { snapshotPolicy: policy } : {}),
    ...(schemaVersion ? { snapshotSchemaVersion: schemaVersion } : {}),
  });
  return { store, snapshots, repository };
}

function incrementAndSave(repository: ReturnType<typeof setup>['repository'], id: string, times: number) {
  for (let i = 0; i < times; i += 1) {
    const counter = repository.load(id) ?? new Counter(id);
    counter.increment(1);
    repository.save(counter);
  }
}

describe('AggregateRepository', () => {
  it('returns undefined for an aggregate with no events', () => {
    expect(setup().repository.load('nobody')).toBeUndefined();
    expect(setup().repository.exists('nobody')).toBe(false);
  });

  it('saves pending events with ids, timestamps and metadata, then reloads them', () => {
    const { repository, store } = setup();
    const counter = new Counter('c-1');
    counter.increment(4);
    const stored = repository.save(counter, { idempotencyKey: 'k-1', commandType: 'Increment' });

    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      aggregateType: 'counter',
      aggregateId: 'c-1',
      sequence: 1,
      occurredAt: '2026-02-01T10:00:00.000Z',
      metadata: { idempotencyKey: 'k-1', commandType: 'Increment' },
    });
    expect(counter.version).toBe(1);
    expect(store.readAll()).toHaveLength(1);
    expect(repository.load('c-1')!.total).toBe(4);
  });

  it('saves nothing when there are no pending events', () => {
    const { repository, store } = setup();
    expect(repository.save(new Counter('c-1'))).toEqual([]);
    expect(store.readAll()).toHaveLength(0);
  });

  it('rejects a save from a stale copy', () => {
    const { repository } = setup();
    incrementAndSave(repository, 'c-1', 1);
    const first = repository.load('c-1')!;
    const second = repository.load('c-1')!;
    first.increment(1);
    repository.save(first);
    second.increment(1);
    expect(() => repository.save(second)).toThrow(ConcurrencyError);
  });

  it('refuses to write events at anything other than their current version', () => {
    const { repository } = setup();
    const counter = new Counter('c-1');
    (counter as unknown as { raise(e: unknown): void }).raise({
      type: 'CounterIncremented',
      version: 2,
      payload: { by: 1 },
    });
    expect(() => repository.save(counter)).toThrow(/must be written at v1/);
  });

  describe('snapshots', () => {
    it('takes none by default', () => {
      const { repository, snapshots } = setup();
      incrementAndSave(repository, 'c-1', 120);
      expect(snapshots.size).toBe(0);
    });

    it('takes one each time the configured interval is crossed', () => {
      const { repository, snapshots } = setup(snapshotPolicy({ enabled: true, interval: 10 }));
      incrementAndSave(repository, 'c-1', 9);
      expect(snapshots.load('counter', 'c-1')).toBeUndefined();
      incrementAndSave(repository, 'c-1', 1);
      expect(snapshots.load('counter', 'c-1')).toMatchObject({ sequence: 10, state: { total: 10 } });
      incrementAndSave(repository, 'c-1', 15);
      expect(snapshots.load('counter', 'c-1')!.sequence).toBe(20);
    });

    it('loads from the snapshot and replays only the newer events', () => {
      const { repository, store } = setup(snapshotPolicy({ enabled: true, interval: 5 }));
      incrementAndSave(repository, 'c-1', 7);
      const readStream = jest.spyOn(store, 'readStream');
      const counter = repository.load('c-1')!;
      expect(readStream).toHaveBeenCalledWith('counter', 'c-1', 5);
      expect(counter.total).toBe(7);
      expect(counter.version).toBe(7);
    });

    it('produces the same state with and without snapshots', () => {
      const plain = setup();
      const snapshotted = setup(snapshotPolicy({ enabled: true, interval: 3 }));
      incrementAndSave(plain.repository, 'c-1', 11);
      incrementAndSave(snapshotted.repository, 'c-1', 11);
      expect(snapshotted.repository.load('c-1')!.takeSnapshot()).toEqual(
        plain.repository.load('c-1')!.takeSnapshot(),
      );
    });

    it('ignores snapshots taken with a different state schema version', () => {
      const { repository, snapshots, store } = setup(snapshotPolicy({ enabled: true, interval: 2 }), 2);
      incrementAndSave(repository, 'c-1', 2);
      snapshots.save({ ...snapshots.load('counter', 'c-1')!, schemaVersion: 1, sequence: 3 });
      const readStream = jest.spyOn(store, 'readStream');
      expect(repository.load('c-1')!.total).toBe(2);
      expect(readStream).toHaveBeenCalledWith('counter', 'c-1', 0);
    });
  });
});
