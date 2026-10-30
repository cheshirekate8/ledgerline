// Criterion 8 [guard]: with the same clock and seeds, runs that cross expiries, a restart
// and republish() still give byte-identical event logs and identical log output.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFinalStates, HOUR, openStore, T0, tempDirectory } from './harness';

async function scenario(directory: string) {
  const first = openStore({ directory, seed: 11 });
  await buildFinalStates(first);
  first.clock.set(T0 + 12 * HOUR);
  await first.run('ReceiveStock', { sku: 'MUG', quantity: 1 }, 'midway');
  first.clock.set(T0 + 25 * HOUR);
  await first.run('ReceiveStock', { sku: 'MUG', quantity: 1 }, 'midway');
  await first.settle();

  first.clock.set(T0 + 30 * HOUR);
  const second = openStore({ directory, seed: 22, clock: first.clock });
  second.app.republish();
  await second.settle();
  await second.run('ReceiveStock', { sku: 'MUG', quantity: 1 }, 'midway');
  await second.settle();
  return { log: readFileSync(join(directory, 'events.ndjson')), lines: [...first.sink.lines, ...second.sink.lines] };
}

describe('criterion 8: determinism', () => {
  it('gives the same log and log output twice', async () => {
    const temps = [tempDirectory(), tempDirectory()];
    try {
      const one = await scenario(temps[0]!.directory);
      const two = await scenario(temps[1]!.directory);
      expect(one.log.equals(two.log)).toBe(true);
      expect(two.lines).toEqual(one.lines);
    } finally {
      temps.forEach((temp) => temp.remove());
    }
  });
});
