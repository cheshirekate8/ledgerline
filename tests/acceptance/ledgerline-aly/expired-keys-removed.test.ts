// Criterion 3: keys past their window are removed, not just ignored, after any command that
// reaches its key check, including one refused by a business rule. Only client commands
// that trigger no process manager are used, so every key counted is one the test sent;
// the stock registration is the first of the five keys at T0.
import { HOUR, openStore, refusal, T0 } from './harness';

describe('criterion 3: expired keys are removed', () => {
  it('counts exactly the keys still inside their window after each command', async () => {
    const store = openStore();
    await store.stock('MUG', 0);
    for (const key of ['a2', 'a3', 'a4', 'a5']) {
      await store.run('ReceiveStock', { sku: 'MUG', quantity: 1 }, key);
    }
    expect(store.keyCount()).toBe(5);

    store.clock.set(T0 + 12 * HOUR);
    for (const key of ['b1', 'b2', 'b3']) {
      await store.run('ReceiveStock', { sku: 'MUG', quantity: 1 }, key);
    }
    expect(store.keyCount()).toBe(8);

    store.clock.set(T0 + 24 * HOUR);
    await store.run('ReceiveStock', { sku: 'MUG', quantity: 1 }, 'c1');
    expect(store.keyCount()).toBe(4);

    // A refused command prunes too: only c1 (T0+24h) is still inside its window.
    store.clock.set(T0 + 36 * HOUR);
    await refusal(store.run('ReceiveStock', { sku: 'TEA', quantity: 1 }, 'd1'), 'INVENTORY_ITEM_NOT_FOUND');
    expect(store.keyCount()).toBe(1);
  });
});
