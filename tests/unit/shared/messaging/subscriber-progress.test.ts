import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DeadLetterProgress,
  FileSubscriberProgress,
  LogIndex,
  noSubscriberProgress,
  ProgressCorruptionError,
  progressPathFor,
} from '../../../../src/shared/messaging/subscriber-progress';

const LOG: LogIndex = { eventIds: new Set(['evt-1', 'evt-2', 'evt-3']), length: 3 };

function deadLetter(overrides: Partial<DeadLetterProgress> = {}): DeadLetterProgress {
  return {
    subscriber: 'audit',
    eventId: 'evt-2',
    messageId: 'msg-7',
    error: 'sink down',
    deliveryCount: 3,
    enqueuedAt: 1_000,
    deadLetteredAt: 1_500,
    ...overrides,
  };
}

describe('FileSubscriberProgress', () => {
  let directory: string;
  let path: string;
  const open = (log: LogIndex = LOG) => new FileSubscriberProgress(path, log, { durable: false });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ledgerline-progress-'));
    path = progressPathFor(join(directory, 'events.ndjson'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('starts a name it has never seen at the end of the log, and remembers that baseline', () => {
    const progress = open();
    expect(progress.baseline('audit', 'order', 3)).toBe(3);
    // A later registration over a longer log keeps the position first recorded.
    expect(progress.baseline('audit', 'order', 9)).toBe(3);
    expect(open().baseline('audit', 'order', 9)).toBe(3);
  });

  it('keeps a baseline per aggregate type, so a newly added type starts at the end', () => {
    open().baseline('audit', 'order', 0);
    const reopened = open();
    expect(reopened.baseline('audit', 'order', 3)).toBe(0);
    expect(reopened.baseline('audit', 'payment', 3)).toBe(3);
  });

  it('remembers finished events across a reopen', () => {
    const progress = open();
    progress.recordFinished('audit', 'evt-1');
    expect(progress.hasFinished('audit', 'evt-1')).toBe(true);
    expect(progress.hasFinished('other', 'evt-1')).toBe(false);
    expect(open().hasFinished('audit', 'evt-1')).toBe(true);
  });

  it('writes one record per finished event, however often it is recorded', () => {
    const progress = open();
    progress.recordFinished('audit', 'evt-1');
    progress.recordFinished('audit', 'evt-1');
    expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(1);
  });

  it('lists dead letters across a reopen, with everything needed to rebuild the message', () => {
    open().recordDeadLettered(deadLetter());
    expect(open().deadLetters()).toEqual([deadLetter()]);
    expect(open().isDeadLettered('audit', 'evt-2')).toBe(true);
  });

  it('lets the latest outcome for an event win', () => {
    const progress = open();
    progress.recordDeadLettered(deadLetter());
    progress.recordFinished('audit', 'evt-2');
    expect(progress.deadLetters()).toEqual([]);
    expect(progress.isDeadLettered('audit', 'evt-2')).toBe(false);

    const reopened = open();
    expect(reopened.deadLetters()).toEqual([]);
    expect(reopened.hasFinished('audit', 'evt-2')).toBe(true);
  });

  it('dead-letters an event again after it was finished', () => {
    const progress = open();
    progress.recordFinished('audit', 'evt-2');
    progress.recordDeadLettered(deadLetter());
    expect(open().deadLetters()).toEqual([deadLetter()]);
  });

  it.each([
    ['not JSON at all', 'not a record'],
    ['a JSON array', '[1, 2, 3]'],
    ['an unknown kind', '{"kind":"guessed","subscriber":"audit"}'],
    ['a truncated record', '{"kind":"finished","subscriber":"audit","eventI'],
    ['a missing subscriber', '{"kind":"finished","eventId":"evt-1"}'],
    ['a non-integer position', '{"kind":"registered","subscriber":"a","aggregateType":"order","position":1.5}'],
    ['a position past the log', '{"kind":"registered","subscriber":"a","aggregateType":"order","position":4}'],
    ['an event the log does not hold', '{"kind":"finished","subscriber":"audit","eventId":"evt-9"}'],
    ['a dead letter without a message id', '{"kind":"dead","subscriber":"a","eventId":"evt-1","error":"x"}'],
  ])('refuses to open progress holding %s', (_case, line) => {
    writeFileSync(path, `${line}\n`);
    expect(() => open()).toThrow(ProgressCorruptionError);
    expect(() => open()).toThrow(path);
  });

  it('reports the line number of the damage and is an infrastructure fault', () => {
    open().recordFinished('audit', 'evt-1');
    writeFileSync(path, `${readFileSync(path, 'utf8')}broken\n`);
    expect(() => open()).toThrow(`${path}:2:`);
    try {
      open();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as ProgressCorruptionError).lineNumber).toBe(2);
    }
  });

  it('names the progress file after the one event log it belongs to', () => {
    expect(progressPathFor('/data/events.ndjson')).toBe('/data/events.ndjson.progress.ndjson');
    expect(progressPathFor('/data/other.ndjson')).toBe('/data/other.ndjson.progress.ndjson');
  });
});

describe('noSubscriberProgress', () => {
  it('starts every subscriber at the end of the log and remembers nothing', () => {
    expect(noSubscriberProgress.baseline('audit', 'order', 7)).toBe(7);
    noSubscriberProgress.recordFinished('audit', 'evt-1');
    noSubscriberProgress.recordDeadLettered(deadLetter());
    expect(noSubscriberProgress.hasFinished('audit', 'evt-1')).toBe(false);
    expect(noSubscriberProgress.isDeadLettered('audit', 'evt-2')).toBe(false);
    expect(noSubscriberProgress.deadLetters()).toEqual([]);
  });
});
