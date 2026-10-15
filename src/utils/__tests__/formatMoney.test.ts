import { describe, expect, it } from 'vitest';
import { formatEarnings, isFiniteNumber } from '../formatMoney';

describe('B1 — safe earnings display (formatMoney)', () => {
  it('renders a genuine zero balance as KES 0', () => {
    expect(formatEarnings(0)).toBe('KES 0');
  });

  it('renders a valid positive amount with thousands separators', () => {
    expect(formatEarnings(12345)).toBe('KES 12,345');
  });

  it('falls back when earnings are missing or null', () => {
    const fallback = 'Earnings temporarily unavailable';
    expect(formatEarnings(undefined)).toBe(fallback);
    expect(formatEarnings(null)).toBe(fallback);
  });

  it('falls back for non-finite and malformed numeric values', () => {
    const fallback = 'Earnings temporarily unavailable';
    expect(formatEarnings(NaN)).toBe(fallback);
    expect(formatEarnings(Infinity)).toBe(fallback);
    expect(formatEarnings(-Infinity)).toBe(fallback);
    expect(formatEarnings('500' as unknown)).toBe(fallback);
    expect(formatEarnings({} as unknown)).toBe(fallback);
  });

  it('isFiniteNumber accepts finite numbers and rejects everything else', () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(12345)).toBe(true);
    expect(isFiniteNumber(-1)).toBe(true);
    expect(isFiniteNumber(NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isFiniteNumber(null)).toBe(false);
    expect(isFiniteNumber(undefined)).toBe(false);
    expect(isFiniteNumber('123' as unknown)).toBe(false);
  });
});
