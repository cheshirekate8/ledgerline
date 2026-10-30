import {
  addCents,
  applyBasisPoints,
  assertBasisPoints,
  cents,
  formatCents,
  InvalidMoneyError,
  minCents,
  multiplyCents,
  nonNegativeCents,
  subtractCents,
  sumCents,
} from '../../../src/shared/money';

describe('cents', () => {
  it('accepts safe integers', () => {
    expect(cents(0)).toBe(0);
    expect(cents(-250)).toBe(-250);
  });

  it.each([1.5, 0.1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %p',
    (value) => {
      expect(() => cents(value)).toThrow(InvalidMoneyError);
    },
  );

  it('rejects negative amounts where only non-negative ones are allowed', () => {
    expect(() => nonNegativeCents(-1)).toThrow(InvalidMoneyError);
    expect(nonNegativeCents(0)).toBe(0);
  });
});

describe('arithmetic', () => {
  it('adds, subtracts and sums', () => {
    expect(addCents(cents(100), cents(250), cents(1))).toBe(351);
    expect(subtractCents(cents(100), cents(250))).toBe(-150);
    expect(sumCents([])).toBe(0);
  });

  it('multiplies only by integers', () => {
    expect(multiplyCents(cents(199), 3)).toBe(597);
    expect(() => multiplyCents(cents(199), 1.5)).toThrow(RangeError);
  });

  it('picks the smaller amount', () => {
    expect(minCents(cents(5), cents(3))).toBe(3);
  });
});

describe('applyBasisPoints', () => {
  it('rounds half to even when asked', () => {
    expect(applyBasisPoints(cents(25), 1_000, 'half-even')).toBe(2);
    expect(applyBasisPoints(cents(35), 1_000, 'half-even')).toBe(4);
  });

  it('rounds half up when asked', () => {
    expect(applyBasisPoints(cents(25), 1_000, 'half-up')).toBe(3);
  });
});

describe('assertBasisPoints', () => {
  it('accepts 0 through 10000', () => {
    expect(() => assertBasisPoints(0, 'rate')).not.toThrow();
    expect(() => assertBasisPoints(10_000, 'rate')).not.toThrow();
  });

  it.each([-1, 10_001, 12.5])('rejects %p', (value) => {
    expect(() => assertBasisPoints(value, 'rate')).toThrow(RangeError);
  });
});

describe('formatCents', () => {
  it('renders a decimal string without floating point', () => {
    expect(formatCents(cents(123_456))).toBe('1234.56');
    expect(formatCents(cents(5))).toBe('0.05');
    expect(formatCents(cents(-1_050))).toBe('-10.50');
  });
});
