// Criterion 4: start-up rebuilds only keys still inside their window, measured from when
// their commands ran, and a key reused after its window belongs to its latest use.
import { HOUR, openStore, refusal, T0, tempDirectory } from './harness';

describe('criterion 4: rebuilding keys at start-up', () => {
  let temp: ReturnType<typeof tempDirectory>;

  beforeEach(() => {
    temp = tempDirectory();
  });

  afterEach(() => {
    temp.remove();
  });

  it('rebuilds live keys only, and a reused key as its latest use', async () => {
    const receive = (quantity: number) => ({ sku: 'MUG', quantity });
    const first = openStore({ directory: temp.directory, seed: 11 });
    await first.run('RegisterInventoryItem', { sku: 'MUG', name: 'mug', initialQuantity: 0 }, 'a1');
    const a2First = await first.run('ReceiveStock', receive(2), 'a2');
    await first.run('ReceiveStock', receive(3), 'a3');
    first.clock.set(T0 + 12 * HOUR);
    await first.run('ReceiveStock', receive(1), 'b1');
    await first.run('ReceiveStock', receive(1), 'b2');

    first.clock.set(T0 + 23 * HOUR);
    const second = openStore({ directory: temp.directory, seed: 22, clock: first.clock });
    expect(second.keyCount()).toBe(5);
    expect(await second.run('ReceiveStock', receive(2), 'a2')).toEqual({ ...a2First, duplicate: true });

    second.clock.set(T0 + 24 * HOUR);
    await second.run('ReceiveStock', receive(1), 'c1');
    expect(second.keyCount()).toBe(3);
    const a2Second = await second.run('ReceiveStock', receive(2), 'a2');
    expect(a2Second.duplicate).toBe(false);

    second.clock.set(T0 + 30 * HOUR);
    const third = openStore({ directory: temp.directory, seed: 33, clock: second.clock });
    expect(third.keyCount()).toBe(4);
    const repeat = await third.run('ReceiveStock', receive(2), 'a2');
    expect(repeat.duplicate).toBe(true);
    expect(repeat.eventIds).toEqual(a2Second.eventIds);
    await refusal(third.run('ReceiveStock', receive(9), 'a2'), 'IDEMPOTENCY_CONFLICT');
  });

  it('keeps a key restarted at T0+W−1 and drops one restarted at exactly T0+W', async () => {
    const first = openStore({ directory: temp.directory, seed: 11 });
    await first.run('RegisterInventoryItem', { sku: 'MUG', name: 'mug', initialQuantity: 0 }, 'register');
    const original = await first.run('ReceiveStock', { sku: 'MUG', quantity: 2 }, 'k');

    first.clock.set(T0 + 24 * HOUR - 1);
    const justBefore = openStore({ directory: temp.directory, seed: 22, clock: first.clock });
    expect(justBefore.keyCount()).toBe(2);

    first.clock.set(T0 + 24 * HOUR);
    const atBoundary = openStore({ directory: temp.directory, seed: 33, clock: first.clock });
    expect(atBoundary.keyCount()).toBe(0);
    const again = await atBoundary.run('ReceiveStock', { sku: 'MUG', quantity: 2 }, 'k');
    expect(again.duplicate).toBe(false);
    expect(again.eventIds).not.toEqual(original.eventIds);
  });

  it('after a restart, a key reused with a different command belongs to the new command', async () => {
    const first = openStore({ directory: temp.directory, seed: 11 });
    await first.run('RegisterInventoryItem', { sku: 'MUG', name: 'mug', initialQuantity: 0 }, 'register');
    await first.run('ReceiveStock', { sku: 'MUG', quantity: 2 }, 'k');
    first.clock.set(T0 + 25 * HOUR);
    const reused = await first.run('ReceiveStock', { sku: 'MUG', quantity: 7 }, 'k');
    expect(reused.duplicate).toBe(false);

    first.clock.set(T0 + 26 * HOUR);
    const second = openStore({ directory: temp.directory, seed: 22, clock: first.clock });
    expect(await second.run('ReceiveStock', { sku: 'MUG', quantity: 7 }, 'k')).toEqual({ ...reused, duplicate: true });
    await refusal(second.run('ReceiveStock', { sku: 'MUG', quantity: 2 }, 'k'), 'IDEMPOTENCY_CONFLICT');
  });
});
