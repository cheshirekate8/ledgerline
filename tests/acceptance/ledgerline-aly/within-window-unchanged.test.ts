// Criterion 7 [guard]: inside the window, keys behave exactly as they do today.
import { openStore, refusal } from './harness';

describe('criterion 7: inside the window nothing changes', () => {
  it('runs two concurrent deliveries of one key once', async () => {
    const store = openStore();
    await store.stock('MUG', 0);
    const received = () => store.app.store.readAll().filter((event) => event.type === 'StockReceived').length;
    const before = received();
    const results = await Promise.all([
      store.run('ReceiveStock', { sku: 'MUG', quantity: 4 }, 'K'),
      store.run('ReceiveStock', { sku: 'MUG', quantity: 4 }, 'K'),
    ]);
    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
    expect(received()).toBe(before + 1);
    expect(results[0]!.eventIds).toEqual(results[1]!.eventIds);
  });

  it('does not remember a command refused by a business rule', async () => {
    const store = openStore();
    await refusal(store.run('ReceiveStock', { sku: 'TEA', quantity: 2 }, 'K'), 'INVENTORY_ITEM_NOT_FOUND');
    await store.stock('TEA', 0);
    const retried = await store.run('ReceiveStock', { sku: 'TEA', quantity: 2 }, 'K');
    expect(retried.duplicate).toBe(false);
    expect(retried.eventIds).toHaveLength(1);
  });
});
