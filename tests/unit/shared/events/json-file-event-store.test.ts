import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConcurrencyError } from '../../../../src/shared/errors';
import { EventStoreCorruptionError, JsonFileEventStore } from '../../../../src/shared/events/json-file-event-store';
import { newEvent } from '../../../support/counter';

describe('JsonFileEventStore', () => {
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ledgerline-store-'));
    filePath = join(directory, 'nested', 'events.ndjson');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('writes one JSON line per event and reloads them on open', () => {
    const store = new JsonFileEventStore(filePath, { durable: false });
    store.append('order', 'a', 0, [newEvent('One', { n: 1 }), newEvent('Two', { n: 2 })]);
    store.append('order', 'b', 0, [newEvent('Three')]);

    const lines = readFileSync(filePath, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'One', aggregateId: 'a', sequence: 1, position: 1 });

    const reopened = new JsonFileEventStore(filePath);
    expect(reopened.readAll()).toEqual(store.readAll());
    expect(reopened.currentSequence('order', 'a')).toBe(2);
    expect(reopened.listAggregateIds('order')).toEqual(['a', 'b']);
  });

  it('continues sequences and positions after a reopen', () => {
    new JsonFileEventStore(filePath).append('order', 'a', 0, [newEvent('One')]);
    const reopened = new JsonFileEventStore(filePath);
    const [stored] = reopened.append('order', 'a', 1, [newEvent('Two')]);
    expect(stored).toMatchObject({ sequence: 2, position: 2 });
    expect(() => reopened.append('order', 'a', 1, [newEvent('Three')])).toThrow(ConcurrencyError);
  });

  it('only ever appends to the file', () => {
    const store = new JsonFileEventStore(filePath, { durable: false });
    store.append('order', 'a', 0, [newEvent('One')]);
    const before = readFileSync(filePath, 'utf8');
    store.append('order', 'a', 1, [newEvent('Two')]);
    expect(readFileSync(filePath, 'utf8').startsWith(before)).toBe(true);
  });

  it('does not replay loaded events to new subscribers', () => {
    new JsonFileEventStore(filePath).append('order', 'a', 0, [newEvent('One')]);
    const reopened = new JsonFileEventStore(filePath);
    const listener = jest.fn();
    reopened.subscribe(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it('reports a line that is not JSON', () => {
    new JsonFileEventStore(filePath).append('order', 'a', 0, [newEvent('One')]);
    appendFileSync(filePath, '{"truncated":\n');
    expect(() => new JsonFileEventStore(filePath)).toThrow(EventStoreCorruptionError);
    expect(() => new JsonFileEventStore(filePath)).toThrow(/:2: line is not valid JSON/);
  });

  it('reports records with missing fields', () => {
    const flat = join(directory, 'flat.ndjson');
    writeFileSync(flat, `${JSON.stringify({ type: 'One' })}\n`);
    expect(() => new JsonFileEventStore(flat)).toThrow(/missing or invalid eventId/);
  });

  it('reports a gap in a stream', () => {
    const store = new JsonFileEventStore(filePath);
    store.append('order', 'a', 0, [newEvent('One'), newEvent('Two')]);
    const [first, second] = readFileSync(filePath, 'utf8').trimEnd().split('\n');
    const tampered = { ...JSON.parse(second!), sequence: 3 };
    writeFileSync(filePath, `${first}\n${JSON.stringify(tampered)}\n`);
    expect(() => new JsonFileEventStore(filePath)).toThrow(/expected sequence 2 for order:a, found 3/);
  });

  it('reports a gap in global positions', () => {
    const store = new JsonFileEventStore(filePath);
    store.append('order', 'a', 0, [newEvent('One')]);
    store.append('order', 'b', 0, [newEvent('Two')]);
    const [, second] = readFileSync(filePath, 'utf8').trimEnd().split('\n');
    writeFileSync(filePath, `${second}\n`);
    expect(() => new JsonFileEventStore(filePath)).toThrow(/expected position 1, found 2/);
  });
});
