import {
  ConcurrencyError,
  describeError,
  DomainError,
  isDomainError,
  OutOfOrderEventError,
  ValidationError,
} from '../../../src/shared/errors';
import { hasReached, utcDay } from '../../../src/shared/time';

describe('utcDay', () => {
  it('returns the UTC calendar day', () => {
    expect(utcDay('2026-05-01T23:59:59.999Z')).toBe('2026-05-01');
    expect(utcDay('2026-05-01T23:30:00.000-02:00')).toBe('2026-05-02');
  });

  it('rejects invalid timestamps', () => {
    expect(() => utcDay('yesterday')).toThrow(RangeError);
  });
});

describe('hasReached', () => {
  it('is inclusive of the instant itself', () => {
    const instant = '2026-05-01T00:15:00.000Z';
    expect(hasReached(Date.parse(instant) - 1, instant)).toBe(false);
    expect(hasReached(Date.parse(instant), instant)).toBe(true);
  });
});

describe('errors', () => {
  it('names domain errors after their class and exposes a code', () => {
    const error = new ValidationError('bad input');
    expect(error).toBeInstanceOf(DomainError);
    expect(error.name).toBe('ValidationError');
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(isDomainError(error)).toBe(true);
  });

  it('keeps infrastructure errors apart from domain errors', () => {
    expect(isDomainError(new ConcurrencyError('order-1', 2, 3))).toBe(false);
    expect(new OutOfOrderEventError('order-1', 2, 4).message).toBe(
      'Event for order-1 has sequence 4, expected 2',
    );
  });

  it('describes unknown thrown values', () => {
    expect(describeError(new Error('x'))).toBe('x');
    expect(describeError('plain')).toBe('plain');
  });
});
