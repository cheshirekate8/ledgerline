// Criterion 1: the default 24-hour window runs on the injected clock and ends exactly at W.
import { onHand, openStore, refusal, T0, W } from './harness';

describe('criterion 1: the window runs on the injected clock', () => {
  it('remembers a key until exactly T0+W, then runs the command as new', async () => {
    const store = openStore();
    await store.stock('MUG', 0);
    const first = await store.run('ReceiveStock', { sku: 'MUG', quantity: 3 }, 'K');
    await store.run('ReceiveStock', { sku: 'MUG', quantity: 1 }, 'K2');
    await store.settle();
    expect(store.clock.now()).toBe(T0);
    expect(onHand(store, 'MUG')).toBe(4);

    store.clock.set(T0 + W - 1);
    const repeat = await store.run('ReceiveStock', { sku: 'MUG', quantity: 3 }, 'K');
    expect(repeat).toEqual({ ...first, duplicate: true });
    await refusal(store.run('ReceiveStock', { sku: 'MUG', quantity: 5 }, 'K'), 'IDEMPOTENCY_CONFLICT');
    await store.settle();
    expect(onHand(store, 'MUG')).toBe(4);
    expect(store.clock.now()).toBe(T0 + W - 1);

    store.clock.set(T0 + W);
    const received = () => store.app.store.readAll().filter((event) => event.type === 'StockReceived').length;
    const before = received();
    const again = await store.run('ReceiveStock', { sku: 'MUG', quantity: 3 }, 'K');
    expect(again.duplicate).toBe(false);
    expect(again.eventIds).toHaveLength(1);
    expect(again.eventIds[0]).not.toBe(first.eventIds[0]);
    expect(received()).toBe(before + 1);

    const reused = await store.run('ReceiveStock', { sku: 'MUG', quantity: 5 }, 'K2');
    expect(reused.duplicate).toBe(false);
    await store.settle();
    expect(onHand(store, 'MUG')).toBe(4 + 3 + 5);
  });
});
