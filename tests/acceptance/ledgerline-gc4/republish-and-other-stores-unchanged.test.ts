// Criterion 8 [guard]: republish(), custom event stores and determinism are unchanged.
import { readdirSync, readFileSync } from 'node:fs';
import { JsonFileEventStore } from '../../../src/shared/events/json-file-event-store';
import { logPath, openStore, recorder, storedTrail, tempDirectory, trail } from './harness';

describe('criterion 8: republish, other stores and determinism', () => {
  const temps: Array<ReturnType<typeof tempDirectory>> = [];
  const temp = () => {
    const created = tempDirectory();
    temps.push(created);
    return created.directory;
  };

  afterEach(() => {
    temps.splice(0).forEach((created) => created.remove());
  });

  it('still sends every stored event to every subscriber after a restart that resumed work', async () => {
    const directory = temp();
    const first = openStore(directory, { seed: 11 });
    first.app.subscribe(recorder('audit'));
    await first.stock('MUG', 5);
    await first.placeOrder('A', [['MUG', 1]]);
    await first.settle();
    await first.placeOrder('B', [['MUG', 2]]);

    const second = openStore(directory, { seed: 22, clock: first.clock });
    const audit = recorder('audit');
    second.app.subscribe(audit);
    await second.settle();

    expect(second.app.republish()).toBe(second.app.store.readAll().length);
    await second.settle();
    const received = new Set(trail(audit.received));
    expect(storedTrail(second.app).filter((entry) => !received.has(entry))).toEqual([]);
  });

  it('writes nothing beside a JSON file store passed as a custom store', async () => {
    const directory = temp();
    const store = openStore(directory, {
      seed: 11,
      persistence: { kind: 'custom', store: new JsonFileEventStore(logPath(directory), { durable: false }) },
    });
    store.app.subscribe(recorder('audit'));
    await store.stock('MUG', 5);
    await store.placeOrder('A', [['MUG', 1]]);
    await store.settle();
    expect(readdirSync(directory)).toEqual(['events.ndjson']);
  });

  it('gives a byte-identical log and identical log lines when a restart scenario runs twice', async () => {
    const scenario = async (directory: string) => {
      const first = openStore(directory, { seed: 11 });
      await first.stock('MUG', 5);
      await first.placeOrder('A', [['MUG', 1]]);
      await first.settle();
      await first.placeOrder('B', [['MUG', 2]]);
      const second = openStore(directory, { seed: 22, clock: first.clock });
      await second.settle();
      return { log: readFileSync(logPath(directory)), before: first.sink.lines, after: second.sink.lines };
    };
    const one = await scenario(temp());
    const two = await scenario(temp());
    expect(one.log.equals(two.log)).toBe(true);
    expect(two.before).toEqual(one.before);
    expect(two.after).toEqual(one.after);
  });
});
