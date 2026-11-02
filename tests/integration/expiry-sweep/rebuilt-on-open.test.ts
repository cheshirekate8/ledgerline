// Candidates are rebuilt when the store opens, for a JSON-file store and for
// a custom store holding earlier events, from the expiry recorded at placement rather
// than the reservation window in force after the restart.
import { join } from 'node:path';
import { countingFileStore, countingMemoryStore, expectWithinReadBound, MINUTE, openStore, Store, tempDirectory, TTL } from './harness';
import { refill } from './scenarios';

async function beforeRestart(store: Store): Promise<number> {
  await store.stock('MUG', 50);
  await store.place('E');
  await store.settle();
  store.clock.advance(TTL);
  expect(await store.app.expireReservations()).toEqual(['E']);
  await store.settle();

  const placedAt = store.clock.now();
  await store.place('A');
  await store.settle();
  await store.place('B');
  await store.paid('C');
  await store.place('D');
  await store.settle();
  await store.run('CancelOrder', { orderId: 'D', reason: 'customer-request' }, 'D-cancel');
  return placedAt;
}

describe('candidates rebuilt when the store opens', () => {
  let temp: ReturnType<typeof tempDirectory>;

  beforeEach(() => {
    temp = tempDirectory();
  });

  afterEach(() => {
    temp.remove();
  });

  it('finds the orders awaiting payment after a restart through the json-file option', async () => {
    const path = join(temp.directory, 'events.ndjson');
    const first = openStore({ jsonFilePath: path, seed: 11 });
    const placedAt = await beforeRestart(first);

    const second = openStore({ jsonFilePath: path, clock: first.clock, seed: 22, reservationTtlMs: 60 * MINUTE });
    second.clock.set(placedAt + TTL - 1);
    expect(await second.app.expireReservations()).toEqual([]);
    second.clock.set(placedAt + TTL);
    expect(await second.app.expireReservations()).toEqual(['A', 'B']);
  });

  for (const kind of ['JSON file behind a custom store', 'custom store refilled in log order'] as const) {
    it(`finds them within the read bound after a restart (${kind})`, async () => {
      const path = join(temp.directory, 'events.ndjson');
      const first = openStore({ store: countingFileStore(path), seed: 11 });
      const placedAt = await beforeRestart(first);

      first.clock.set(placedAt + MINUTE);
      const fileBacked = kind === 'JSON file behind a custom store';
      const store = fileBacked ? countingFileStore(path) : countingMemoryStore();
      if (!fileBacked) {
        refill(store, first.app.store.readAll());
      }
      const second = openStore({ store, clock: first.clock, seed: 22, reservationTtlMs: 60 * MINUTE });

      second.clock.set(placedAt + TTL - 1);
      const early = await second.sweep();
      expect(early.expired).toEqual([]);
      expectWithinReadBound(early);

      second.clock.set(placedAt + TTL);
      const sweep = await second.sweep();
      expect(sweep.expired).toEqual(['A', 'B']);
      expectWithinReadBound(sweep);
      for (const closed of ['C', 'D', 'E']) {
        expect(sweep.reads.streams.has(`order:${closed}`)).toBe(false);
      }
    });
  }
});
