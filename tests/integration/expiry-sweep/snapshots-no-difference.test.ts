// Snapshots on or off make no difference to what a sweep expires, records,
// logs or reads.
import { expectWithinReadBound, openStore } from './harness';
import { orderOfEveryKind } from './scenarios';

async function run(snapshots?: { enabled: boolean; interval: number }) {
  const store = openStore({ seed: 11, ...(snapshots ? { snapshots } : {}) });
  await orderOfEveryKind(store, 3);
  const sweep = await store.sweep();
  expectWithinReadBound(sweep);
  return { expired: sweep.expired, log: JSON.stringify(store.app.store.readAll()), lines: store.sink.lines };
}

describe('snapshots make no difference', () => {
  it('gives the same result with snapshots off, on every event and on every second event', async () => {
    const off = await run();
    const everyEvent = await run({ enabled: true, interval: 1 });
    const everySecond = await run({ enabled: true, interval: 2 });
    expect(off.expired).toEqual(['P2']);
    expect(everyEvent).toEqual(off);
    expect(everySecond).toEqual(off);
  });
});
