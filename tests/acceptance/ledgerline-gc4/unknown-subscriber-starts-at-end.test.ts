// Criterion 6 [guard]: a subscriber never registered against a store starts at the end of
// its log, as a new subscriber does today, so opening a log written before this change
// re-runs nothing. pre-change-history.ndjson was written by the service as it was before
// this task: MUG stocked with 5, order A (MUG×1) placed and processed, order B (MUG×2)
// placed but not processed.
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { FULFILLMENT, logPath, openStore, PAYMENTS, recorder, storedTrail, tempDirectory, trail } from './harness';

describe('criterion 6: a never-registered subscriber starts at the end of the log', () => {
  let temp: ReturnType<typeof tempDirectory>;

  beforeEach(() => {
    temp = tempDirectory();
  });

  afterEach(() => {
    temp.remove();
  });

  it('gives a new subscriber name only events appended after it registers', async () => {
    const first = openStore(temp.directory, { seed: 11 });
    await first.stock('MUG', 5);
    await first.placeOrder('A', [['MUG', 1]]);
    await first.settle();

    const second = openStore(temp.directory, { seed: 22, clock: first.clock });
    const newcomer = recorder('newcomer');
    second.app.subscribe(newcomer);
    await second.settle();
    expect(newcomer.received).toEqual([]);

    await second.placeOrder('B', [['MUG', 2]]);
    await second.settle();
    expect(trail(newcomer.received)).toEqual(storedTrail(second.app, (event) => event.aggregateId === 'B'));
  });

  it('re-runs nothing from a log written before this change until republish()', async () => {
    copyFileSync(join(__dirname, 'pre-change-history.ndjson'), logPath(temp.directory));

    const store = openStore(temp.directory, { seed: 22 });
    await store.app.processMessages();
    expect(store.outcomes('message.handled', FULFILLMENT)).toEqual([]);
    expect(store.outcomes('message.handled', PAYMENTS)).toEqual([]);
    expect(store.app.readModels.stockLevels.get('MUG')).toMatchObject({ onHand: 5, reserved: 1 });
    expect(store.app.readModels.orderSummary.get('B')).toMatchObject({ status: 'Placed', stockReserved: false });

    store.app.republish();
    await store.settle();
    expect(store.app.readModels.orderSummary.get('B')!.stockReserved).toBe(true);
    expect(store.app.readModels.stockLevels.get('MUG')).toMatchObject({ onHand: 5, reserved: 3 });
  });
});
