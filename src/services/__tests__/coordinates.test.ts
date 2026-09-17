import { describe, it, expect } from 'vitest';
import {
  isFiniteNumber,
  isValidLatitude,
  isValidLongitude,
  isValidCoordinatePair,
  parseCoordinateInput,
  normalizeCoordinateInput,
  LATITUDE_MIN,
  LATITUDE_MAX,
  LONGITUDE_MIN,
  LONGITUDE_MAX,
} from '../coordinates';

// ---------------------------------------------------------------------------
// PHASE 9D — coordinate VALIDATION.
//
// These tests pin the fixes for the Phase 9D audit's findings C1-C4:
//   C1 no range check         -> out-of-range is now refused
//   C2 no finiteness check    -> NaN/Infinity are now refused
//   C3 zero treated as absent -> 0 is now a VALID coordinate
//   C4 lenient parsing        -> '1.29junk' is now refused, not truncated
//
// They also pin the SCOPE: this module validates a PAIR. It never claims the
// pair means anything (a found location, a county, a residence). Nothing here
// asserts a meaning, because the module must not create one.
// ---------------------------------------------------------------------------

describe('bounds are the real geographic bounds', () => {
  it('exposes the conventional inclusive ranges', () => {
    expect(LATITUDE_MIN).toBe(-90);
    expect(LATITUDE_MAX).toBe(90);
    expect(LONGITUDE_MIN).toBe(-180);
    expect(LONGITUDE_MAX).toBe(180);
  });
});

describe('isFiniteNumber refuses everything that is not a real number', () => {
  it('accepts finite numbers including 0 and negatives', () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-1.2921)).toBe(true);
    expect(isFiniteNumber(36.8219)).toBe(true);
  });

  it('refuses NaN, infinities and non-numbers', () => {
    expect(isFiniteNumber(NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isFiniteNumber(-Infinity)).toBe(false);
    expect(isFiniteNumber('1.29')).toBe(false);
    expect(isFiniteNumber(null)).toBe(false);
    expect(isFiniteNumber(undefined)).toBe(false);
  });
});

describe('latitude / longitude range checks', () => {
  it('accepts in-range values including the exact boundaries', () => {
    expect(isValidLatitude(0)).toBe(true);
    expect(isValidLatitude(-90)).toBe(true);
    expect(isValidLatitude(90)).toBe(true);
    expect(isValidLongitude(-180)).toBe(true);
    expect(isValidLongitude(180)).toBe(true);
  });

  it('refuses out-of-range values (audit finding C1)', () => {
    expect(isValidLatitude(90.000001)).toBe(false);
    expect(isValidLatitude(-91)).toBe(false);
    expect(isValidLatitude(5000)).toBe(false);
    expect(isValidLongitude(181)).toBe(false);
    expect(isValidLongitude(-180.5)).toBe(false);
    expect(isValidLongitude(5000)).toBe(false);
  });

describe('a coordinate is a PAIR — half a coordinate is not a location', () => {
  it('accepts a complete, valid pair', () => {
    expect(isValidCoordinatePair(-1.2921, 36.8219)).toBe(true);
  });

  it('accepts a pair containing a legitimate zero (audit finding C3)', () => {
    // The equator crosses Kenya. 0 must be a coordinate, not an absence.
    expect(isValidCoordinatePair(0, 36.8219)).toBe(true);
    expect(isValidCoordinatePair(-1.2921, 0)).toBe(true);
    expect(isValidCoordinatePair(0, 0)).toBe(true);
  });

  it('refuses a pair with either half missing or unusable', () => {
    expect(isValidCoordinatePair(null, 36.8219)).toBe(false);
    expect(isValidCoordinatePair(-1.2921, null)).toBe(false);
    expect(isValidCoordinatePair(undefined, undefined)).toBe(false);
    expect(isValidCoordinatePair(NaN, 36.8219)).toBe(false);
    expect(isValidCoordinatePair(-1.2921, 999)).toBe(false);
  });
});

describe('parseCoordinateInput is STRICT (audit finding C4)', () => {
  it('accepts an exact numeric string', () => {
    expect(parseCoordinateInput('1.29')).toBe(1.29);
    expect(parseCoordinateInput('-1.2921')).toBe(-1.2921);
    expect(parseCoordinateInput(' 36.8219 ')).toBe(36.8219);
    expect(parseCoordinateInput('0')).toBe(0);
    expect(parseCoordinateInput('1e2')).toBe(100);
  });

  it('accepts a real number', () => {
    expect(parseCoordinateInput(-1.2921)).toBe(-1.2921);
    expect(parseCoordinateInput(0)).toBe(0);
  });

  it('REFUSES trailing garbage instead of silently truncating it', () => {
    // parseFloat('1.2921junk') used to return 1.2921. That lenient behaviour is
    // exactly what this replaces.
    expect(parseCoordinateInput('1.2921junk')).toBeNull();
    expect(parseCoordinateInput('12abc')).toBeNull();
    expect(parseCoordinateInput('1,29')).toBeNull();
  });

  it('refuses blank, non-numeric and non-finite input', () => {
    expect(parseCoordinateInput('')).toBeNull();
    expect(parseCoordinateInput('   ')).toBeNull();
    expect(parseCoordinateInput('abc')).toBeNull();
    expect(parseCoordinateInput('NaN')).toBeNull();
    expect(parseCoordinateInput('Infinity')).toBeNull();
    expect(parseCoordinateInput(null)).toBeNull();
    expect(parseCoordinateInput(undefined)).toBeNull();
    expect(parseCoordinateInput({})).toBeNull();
  });
});

describe('normalizeCoordinateInput returns a pair or nothing at all', () => {
  it('returns the validated pair for a good input', () => {
    expect(normalizeCoordinateInput('-1.2921', '36.8219')).toEqual({ latitude: -1.2921, longitude: 36.8219 });
  });

  it('preserves a legitimate zero', () => {
    expect(normalizeCoordinateInput('0', '36.8219')).toEqual({ latitude: 0, longitude: 36.8219 });
    expect(normalizeCoordinateInput(0, 0)).toEqual({ latitude: 0, longitude: 0 });
  });

  it('returns null (never half a pair) when either half is unusable', () => {
    expect(normalizeCoordinateInput('abc', '36.8219')).toBeNull();
    expect(normalizeCoordinateInput('-1.2921', 'abc')).toBeNull();
    expect(normalizeCoordinateInput('-1.2921', null)).toBeNull();
    expect(normalizeCoordinateInput(null, '36.8219')).toBeNull();
    expect(normalizeCoordinateInput('91', '36.8219')).toBeNull();
    expect(normalizeCoordinateInput('-1.2921', '181')).toBeNull();
  });

  it('does not CLAMP an out-of-range value into a valid one', () => {
    // Clamping would invent a location the caller never supplied. The pair must
    // be refused outright so no location claim can be manufactured from it.
    expect(normalizeCoordinateInput('95', '36.8219')).toBeNull();
    expect(normalizeCoordinateInput('-1.2921', '200')).toBeNull();
  });
});


  it('refuses non-finite values (audit finding C2)', () => {
    expect(isValidLatitude(NaN)).toBe(false);
    expect(isValidLatitude(Infinity)).toBe(false);
    expect(isValidLongitude(NaN)).toBe(false);
  });
});
