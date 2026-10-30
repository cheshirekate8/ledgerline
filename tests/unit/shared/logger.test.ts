import { FixedClock } from '../../../src/shared/clock';
import { JsonLogger, MemoryLogSink, silentLogger } from '../../../src/shared/logger';

function createLogger(level?: 'debug' | 'info' | 'warn' | 'error') {
  const sink = new MemoryLogSink();
  const logger = new JsonLogger({
    sink: sink.write,
    clock: new FixedClock('2026-05-01T08:30:00.000Z'),
    ...(level ? { level } : {}),
  });
  return { sink, logger };
}

describe('JsonLogger', () => {
  it('writes exactly one JSON line per entry', () => {
    const { sink, logger } = createLogger();
    logger.info('order.placed', { orderId: 'o-1', totalCents: 1_099 });
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).not.toContain('\n');
    expect(JSON.parse(sink.lines[0]!)).toEqual({
      ts: '2026-05-01T08:30:00.000Z',
      level: 'info',
      msg: 'order.placed',
      orderId: 'o-1',
      totalCents: 1_099,
    });
  });

  it('suppresses entries below the configured level', () => {
    const { sink, logger } = createLogger('warn');
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    expect(sink.messages()).toEqual(['c', 'd']);
  });

  it('carries child fields onto every entry', () => {
    const { sink, logger } = createLogger();
    logger.child({ component: 'queue' }).child({ worker: 2 }).warn('retry');
    expect(sink.entries()[0]).toMatchObject({ component: 'queue', worker: 2, msg: 'retry', level: 'warn' });
  });

  it('serializes errors by name and message', () => {
    const { sink, logger } = createLogger();
    logger.error('failed', { error: new TypeError('boom') });
    expect(sink.entries()[0]!['error']).toEqual({ name: 'TypeError', message: 'boom' });
  });
});

describe('silentLogger', () => {
  it('accepts calls without output', () => {
    expect(() => silentLogger.child({ a: 1 }).info('nothing')).not.toThrow();
  });
});
