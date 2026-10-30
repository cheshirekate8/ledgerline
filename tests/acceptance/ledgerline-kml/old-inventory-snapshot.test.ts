// Criterion 6: an inventory snapshot taken before this change does not break returns.
// v1-inventory-snapshot.json is MUG's snapshot exactly as the service wrote it before this
// task, taken from v1-history.ndjson at sequence 4 (state schema version 1). If the task
// changes the inventory state's shape, that snapshot must be ignored, not misread.
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedClock } from '../../../src/shared/clock';
import { InMemorySnapshotStore, Snapshot } from '../../../src/shared/snapshots/snapshot-store';
import { openStore, payloadOf } from './harness';

describe('criterion 6: snapshots written before this change', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ledgerline-snapshot-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('still returns a new refund exactly once with snapshots enabled', async () => {
    const path = join(directory, 'events.ndjson');
    copyFileSync(join(__dirname, 'v1-history.ndjson'), path);
    const snapshotStore = new InMemorySnapshotStore();
    snapshotStore.save(JSON.parse(readFileSync(join(__dirname, 'v1-inventory-snapshot.json'), 'utf8')) as Snapshot);

    const options = {
      persistence: { kind: 'json-file', path, durable: false } as const,
      snapshots: { enabled: true, interval: 1 },
      snapshotStore,
      clock: new FixedClock('2026-06-01T10:00:00.000Z'),
    };
    const store = openStore({ ...options, seed: 77 });
    await store.refund('legacy', 'legacy-l1', 1, 'r-new');
    await store.settle();

    expect(store.events('StockReturned').map((event) => payloadOf(event))).toEqual([
      { orderId: 'legacy', refundId: 'r-new', quantity: 1 },
    ]);
    expect(store.level('MUG')).toEqual({ onHand: 3, reserved: 0, available: 3 });
    store.app.close();

    const restarted = openStore({ ...options, clock: store.clock, seed: 78 });
    restarted.app.republish();
    await restarted.settle();
    expect(restarted.events('StockReturned')).toHaveLength(1);
    expect(restarted.level('MUG')).toEqual({ onHand: 3, reserved: 0, available: 3 });
  });
});
