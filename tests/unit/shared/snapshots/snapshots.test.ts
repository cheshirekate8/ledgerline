import {
  DEFAULT_SNAPSHOT_POLICY,
  shouldSnapshot,
  snapshotPolicy,
} from '../../../../src/shared/snapshots/snapshot-policy';
import { InMemorySnapshotStore, Snapshot } from '../../../../src/shared/snapshots/snapshot-store';

describe('snapshot policy', () => {
  it('is disabled by default', () => {
    expect(DEFAULT_SNAPSHOT_POLICY.enabled).toBe(false);
    expect(shouldSnapshot(DEFAULT_SNAPSHOT_POLICY, 0, 1_000)).toBe(false);
  });

  it('fires when a multiple of the interval is reached or crossed', () => {
    const policy = snapshotPolicy({ enabled: true, interval: 10 });
    expect(shouldSnapshot(policy, 8, 9)).toBe(false);
    expect(shouldSnapshot(policy, 9, 10)).toBe(true);
    expect(shouldSnapshot(policy, 10, 11)).toBe(false);
    expect(shouldSnapshot(policy, 18, 23)).toBe(true);
    expect(shouldSnapshot(policy, 12, 12)).toBe(false);
  });

  it('rejects a non-positive interval', () => {
    expect(() => snapshotPolicy({ interval: 0 })).toThrow(RangeError);
    expect(() => snapshotPolicy({ interval: 2.5 })).toThrow(RangeError);
  });
});

describe('InMemorySnapshotStore', () => {
  const snapshot = (sequence: number): Snapshot => ({
    aggregateType: 'order',
    aggregateId: 'o-1',
    sequence,
    schemaVersion: 1,
    takenAt: '2026-01-01T00:00:00.000Z',
    state: { sequence },
  });

  it('keeps the latest snapshot per aggregate', () => {
    const store = new InMemorySnapshotStore();
    store.save(snapshot(10));
    store.save(snapshot(20));
    store.save(snapshot(15));
    expect(store.load('order', 'o-1')!.sequence).toBe(20);
    expect(store.load('order', 'o-2')).toBeUndefined();
  });

  it('stores an isolated, frozen copy', () => {
    const store = new InMemorySnapshotStore();
    const original = { ...snapshot(5), state: { items: [1] } };
    store.save(original);
    original.state.items.push(2);
    const loaded = store.load('order', 'o-1')!;
    expect(loaded.state).toEqual({ items: [1] });
    expect(Object.isFrozen(loaded.state)).toBe(true);
  });
});
