// B1 — safe money formatting for the agent dashboard.
//
// An earnings figure must only ever render as a concrete "KES n" when the data
// contract actually provides a finite number. null / undefined / NaN / ±Infinity
// and any malformed value render the restrained "Earnings temporarily
// unavailable" fallback instead — never "NaN", never "Infinity", and never a
// false "KES 0". A genuine zero still renders "KES 0".

export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const formatEarnings = (value: unknown): string =>
  isFiniteNumber(value) ? `KES ${value.toLocaleString()}` : 'Earnings temporarily unavailable';
