// Criterion 6: once every key has expired, republish() of every stored event changes
// nothing, for orders in every reachable final state. A key count of 0 first proves the
// run cannot be leaning on remembered keys.
import { buildFinalStates, HOUR, openStore, T0, tempDirectory } from './harness';

describe('criterion 6: republish() after the window', () => {
  let temp: ReturnType<typeof tempDirectory>;

  beforeEach(() => {
    temp = tempDirectory();
  });

  afterEach(() => {
    temp.remove();
  });

  it('changes nothing after a restart with every key forgotten', async () => {
    const first = openStore({ directory: temp.directory, seed: 11 });
    await buildFinalStates(first);

    first.clock.set(T0 + 25 * HOUR);
    const second = openStore({ directory: temp.directory, seed: 22, clock: first.clock });
    expect(second.keyCount()).toBe(0);
    const before = second.state();

    second.app.republish();
    await second.settle();
    expect(second.state()).toEqual(before);
  });

  it('changes nothing on the running instance once its keys have expired', async () => {
    const store = openStore({ directory: temp.directory, seed: 11 });
    await buildFinalStates(store);

    store.clock.set(T0 + 25 * HOUR);
    await store.run('RegisterInventoryItem', { sku: 'TEA', name: 'tea', initialQuantity: 1 }, 'after-window');
    await store.settle();
    expect(store.keyCount()).toBe(1);
    const before = store.state();

    store.app.republish();
    await store.settle();
    expect(store.state()).toEqual(before);
  });
});
