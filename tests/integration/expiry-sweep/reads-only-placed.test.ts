// A sweep reads only orders awaiting payment, and its cost does not grow with
// the store's history. The history is written by one service, then copied in log order
// into a fresh counting store that a second service opens, so every event of it is
// history rather than "appended since opening".
import { countingMemoryStore, expectWithinReadBound, openStore, Store } from './harness';
import { orderOfEveryKind, refill } from './scenarios';

async function reopenAfter(extraClosed: number): Promise<Store> {
  const builder = openStore({ seed: 11 });
  await orderOfEveryKind(builder, extraClosed);
  const store = countingMemoryStore();
  refill(store, builder.app.store.readAll());
  return openStore({ store, clock: builder.clock, seed: 22 });
}

describe('a sweep reads only orders awaiting payment', () => {
  it('expires the overdue order within the read bound, whatever the history', async () => {
    const small = await reopenAfter(0);
    const first = await small.sweep();
    expect(first.expired).toEqual(['P2']);
    expect([...first.placedAtStart].sort()).toEqual(['P1', 'P2']);
    expectWithinReadBound(first);
    expect(first.reads.readAllEvents).toBe(0);

    const large = await reopenAfter(40);
    const firstLarge = await large.sweep();
    expect(firstLarge.reads.readAllEvents).toBe(0);
    expect(firstLarge.expired).toEqual(['P2']);
    expectWithinReadBound(firstLarge);
    expect(new Map([...firstLarge.reads.streams].sort())).toEqual(new Map([...first.reads.streams].sort()));

    const again = await small.sweep();
    expect(again.expired).toEqual([]);
    expectWithinReadBound(again);
    expect(again.reads.streams.has('order:P2')).toBe(false);
  });
});
