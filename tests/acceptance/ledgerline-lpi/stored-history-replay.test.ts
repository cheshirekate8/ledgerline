// Criterion 7: refunds stored before this change read as having paid back their full
// prorated total, and nothing stored is rewritten. Both fixtures were written by the
// service as it was before this task: MUG stocked with 5, order "legacy" (customer alice)
// paid 3000 for MUG×3 on payment pay-legacy, then 1 unit refunded with id r-legacy-1.
//   v1-history.ndjson: written before ledgerline-kml; the refund is a version 1
//     OrderLineRefunded and nothing was restocked (MUG on-hand 2).
//   v2-history.ndjson: written before this task; the refund is a version 2
//     OrderLineRefunded with returnsToStock true, and one unit was restocked (on-hand 3).
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedClock } from '../../../src/shared/clock';
import { StoredEvent } from '../../../src/shared/events/domain-event';
import { openStore, payloadOf, refusal } from './harness';

const FIXTURES = [
  { fixture: 'v1-history.ndjson', storedVersion: 1, onHandBefore: 2, onHandAfter: 4 },
  { fixture: 'v2-history.ndjson', storedVersion: 2, onHandBefore: 3, onHandAfter: 5 },
] as const;

describe.each(FIXTURES)('criterion 7: replaying $fixture', ({ fixture, storedVersion, onHandBefore, onHandAfter }) => {
  let directory: string;
  let path: string;
  let original: Buffer;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ledgerline-history-'));
    path = join(directory, 'events.ndjson');
    copyFileSync(join(__dirname, fixture), path);
    original = readFileSync(path);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const open = () =>
    openStore({
      persistence: { kind: 'json-file', path, durable: false },
      clock: new FixedClock('2026-06-01T10:00:00.000Z'),
      seed: 77,
    });

  it('delivers the stored refund as version 3 paid back in full, without rewriting it', async () => {
    const store = open();
    const delivered: StoredEvent[] = [];
    store.app.subscribe({
      name: 'recorder',
      aggregateTypes: ['order'],
      handle: (event) => {
        delivered.push(event);
      },
    });
    store.app.republish();
    await store.settle();

    const upcast = delivered.filter((event) => event.type === 'OrderLineRefunded');
    expect(upcast).toHaveLength(1);
    expect(upcast[0]!.version).toBe(3);
    expect(payloadOf(upcast[0]!)).toMatchObject({
      refundId: 'r-legacy-1',
      refund: { totalCents: 1000 },
      paidBackCents: 1000,
      returnsToStock: storedVersion === 2,
    });

    const stored = store.events('OrderLineRefunded');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.version).toBe(storedVersion);
    expect(Object.keys(payloadOf(stored[0]!))).not.toContain('paidBackCents');
    const fixtureLine = original
      .toString('utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as StoredEvent)
      .find((event) => event.type === 'OrderLineRefunded');
    expect(stored[0]).toEqual(fixtureLine);

    expect(store.app.readModels.orderSummary.get('legacy')!.refundedCents).toBe(1000);
    expect(store.level('MUG').onHand).toBe(onHandBefore);
    expect(readFileSync(path).equals(original)).toBe(true);
  });

  it('counts the stored refund against the balance of new credits and refunds', async () => {
    const store = open();

    await refusal(store.credit('legacy', 2001, 'too much', 'c-over'), 'CREDIT_EXCEEDS_REFUNDABLE');
    await store.credit('legacy', 2000, 'the rest', 'c-rest');
    await store.settle();
    expect(store.paymentRefunds('legacy').map((refund) => [refund.refundId, refund.amountCents])).toEqual([
      ['r-legacy-1', 1000],
      ['c-rest', 2000],
    ]);

    await store.refund('legacy', 'legacy-l1', 2, 'r-last');
    await store.settle();

    const newest = store.events('OrderLineRefunded').at(-1)!;
    expect(newest.version).toBe(3);
    expect(payloadOf(newest)).toMatchObject({ refundId: 'r-last', refund: { quantity: 2 }, paidBackCents: 0 });
    expect(store.paymentRefunds('legacy')).toHaveLength(2);
    expect(store.paymentRefunds('legacy').reduce((total, refund) => total + refund.amountCents, 0)).toBe(3000);
    expect(store.app.readModels.orderSummary.get('legacy')!.status).toBe('Refunded');
    expect(store.level('MUG').onHand).toBe(onHandAfter);
    expect(readFileSync(path).subarray(0, original.length).equals(original)).toBe(true);
  });
});
