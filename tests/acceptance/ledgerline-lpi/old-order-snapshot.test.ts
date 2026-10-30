// Criterion 8: an order snapshot taken before this change is not misread.
// v2-order-snapshot.json is order "legacy"'s snapshot exactly as the service wrote it
// before this task, taken from v2-history.ndjson at sequence 6 (state schema version 1):
// Paid, 3000 paid, 1000 returned. If the task changes the order state's shape, that
// snapshot must be ignored, not misread.
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedClock } from '../../../src/shared/clock';
import { InMemorySnapshotStore, Snapshot } from '../../../src/shared/snapshots/snapshot-store';
import { openStore, payloadOf, refusal } from './harness';

describe('criterion 8: order snapshots written before this change', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ledgerline-order-snapshot-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('keeps the balance right with snapshots enabled, including after a restart', async () => {
    const path = join(directory, 'events.ndjson');
    copyFileSync(join(__dirname, 'v2-history.ndjson'), path);
    const snapshotStore = new InMemorySnapshotStore();
    snapshotStore.save(JSON.parse(readFileSync(join(__dirname, 'v2-order-snapshot.json'), 'utf8')) as Snapshot);

    const options = {
      persistence: { kind: 'json-file', path, durable: false } as const,
      snapshots: { enabled: true, interval: 1 },
      snapshotStore,
      clock: new FixedClock('2026-06-01T10:00:00.000Z'),
    };
    const store = openStore({ ...options, seed: 77 });

    await refusal(store.credit('legacy', 2001, 'too much', 'c-over'), 'CREDIT_EXCEEDS_REFUNDABLE');
    await store.credit('legacy', 2000, 'the rest', 'c-rest');
    await store.settle();
    await store.refund('legacy', 'legacy-l1', 2, 'r-last');
    await store.settle();

    const newest = store.events('OrderLineRefunded').at(-1)!;
    expect(payloadOf(newest)).toMatchObject({ refundId: 'r-last', paidBackCents: 0 });
    expect(store.app.readModels.orderSummary.get('legacy')!.status).toBe('Refunded');
    const total = () => store.paymentRefunds('legacy').reduce((sum, refund) => sum + refund.amountCents, 0);
    expect(total()).toBe(3000);
    store.app.close();

    const restarted = openStore({ ...options, clock: store.clock, seed: 78 });
    restarted.app.republish();
    await restarted.settle();
    expect(restarted.paymentRefunds('legacy').reduce((sum, refund) => sum + refund.amountCents, 0)).toBe(3000);
    expect(restarted.app.readModels.orderSummary.get('legacy')!.status).toBe('Refunded');
    expect(restarted.credits('legacy')).toHaveLength(1);
  });
});
