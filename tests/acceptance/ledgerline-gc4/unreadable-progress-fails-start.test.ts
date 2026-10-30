// Criterion 7: progress that cannot be read stops start-up rather than being taken as
// "nothing handled" or "everything handled". The progress file's name and format are the
// implementer's choice, so the test damages every file in the directory except the log.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logPath, openStore, recorder, tempDirectory } from './harness';

/** Every file under `directory`, at any depth, except the event log itself. */
function progressFiles(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (path !== logPath(directory)) {
        found.push(path);
      }
    }
  };
  walk(directory);
  return found;
}

describe('criterion 7: unreadable progress stops start-up', () => {
  let temp: ReturnType<typeof tempDirectory>;

  beforeEach(async () => {
    temp = tempDirectory();
    const first = openStore(temp.directory, { seed: 11 });
    first.app.subscribe(recorder('audit'));
    await first.stock('MUG', 5);
    await first.placeOrder('A', [['MUG', 1]]);
    await first.settle();
    await first.placeOrder('B', [['MUG', 2]]);
  });

  afterEach(() => {
    temp.remove();
  });

  it('throws when every progress file holds garbage', () => {
    const files = progressFiles(temp.directory);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      writeFileSync(file, '\u0000not a record');
    }
    expect(() => openStore(temp.directory, { seed: 22 })).toThrow();
  });

  it('throws when every progress file ends part-way through its last record', () => {
    const files = progressFiles(temp.directory);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(file);
      const end = content.length > 0 && content[content.length - 1] === 0x0a ? content.length - 1 : content.length;
      expect(end).toBeGreaterThan(5);
      writeFileSync(file, content.subarray(0, end - 5));
    }
    expect(() => openStore(temp.directory, { seed: 22 })).toThrow();
  });
});
