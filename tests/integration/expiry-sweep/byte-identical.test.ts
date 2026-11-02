// A mixed scenario gives exactly the recorded sweeps, event log and log output.
// golden-sweeps.json was recorded by running mixedScript once; it is compared as parsed values, and this test never writes it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from './harness';
import { mixedScript } from './scenarios';

describe('a mixed scenario matches its recording', () => {
  it('gives the recorded sweeps, event log and log output', async () => {
    const golden = JSON.parse(readFileSync(join(__dirname, 'golden-sweeps.json'), 'utf8')) as {
      sweeps: string[][];
      events: unknown[];
      lines: string[];
    };
    const store = openStore({ seed: 11 });
    const sweeps = await mixedScript(store);
    expect(sweeps).toEqual(golden.sweeps);
    expect(JSON.parse(JSON.stringify(store.app.store.readAll()))).toEqual(golden.events);
    expect(store.sink.lines).toEqual(golden.lines);
  });
});
