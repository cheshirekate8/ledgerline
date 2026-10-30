import { OutOfOrderEventError } from '../../../../src/shared/errors';
import { SequenceTracker } from '../../../../src/shared/events/sequence-tracker';

const event = (aggregateId: string, sequence: number) => ({ aggregateType: 'order', aggregateId, sequence });

describe('SequenceTracker', () => {
  it('accepts the next sequence for each aggregate independently', () => {
    const tracker = new SequenceTracker();
    expect(tracker.classify(event('a', 1))).toBe('next');
    tracker.record(event('a', 1));
    expect(tracker.classify(event('b', 1))).toBe('next');
    expect(tracker.classify(event('a', 2))).toBe('next');
    expect(tracker.lastSequence('order', 'a')).toBe(1);
  });

  it('classifies redelivered events as duplicates', () => {
    const tracker = new SequenceTracker();
    tracker.record(event('a', 1));
    tracker.record(event('a', 2));
    expect(tracker.classify(event('a', 1))).toBe('duplicate');
    expect(tracker.classify(event('a', 2))).toBe('duplicate');
  });

  it('detects a gap as an out-of-order event', () => {
    const tracker = new SequenceTracker();
    tracker.record(event('a', 1));
    expect(() => tracker.classify(event('a', 3))).toThrow(OutOfOrderEventError);
    try {
      tracker.classify(event('a', 3));
    } catch (error) {
      expect(error).toMatchObject({ aggregateId: 'order:a', expectedSequence: 2, actualSequence: 3 });
    }
  });

  it('detects a stream that starts mid-way', () => {
    expect(() => new SequenceTracker().classify(event('a', 2))).toThrow(OutOfOrderEventError);
  });

  it('forgets everything on reset', () => {
    const tracker = new SequenceTracker();
    tracker.record(event('a', 4));
    tracker.reset();
    expect(tracker.lastSequence('order', 'a')).toBe(0);
  });
});
