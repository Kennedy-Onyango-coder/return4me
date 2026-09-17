// FOUND-ITEM COUNTY INPUT VALIDATION (Phase 9D)
// ============================================
// The ONE place the found-item reporting path decides what the Finder's county
// selection means. Extracted from the route so the rule is unit-testable
// directly (the same reason routes/lostReports.ts exposes its own
// `validateLostReportPayload` instead of hiding the logic inside a handler).
//
// WHY THE FOUND SIDE NEEDS A CANONICAL COUNTY AT ALL
//   The lost side has stored a canonical Kenyan county since Phase 9A. The
//   found side had only free text, so the matcher had to GUESS a county by
//   scanning that text for county names — which produced a real false positive:
//   "Mombasa Road" (a Nairobi street, and the A109) read as Mombasa County and
//   could then wrongly ELIMINATE a correct candidate. Asking the Finder removes
//   the guess at its source.
//
// CANONICALIZATION IS DELEGATED, NEVER DUPLICATED
//   `resolveCountyName()` from config/kenyaCounties.ts is the single 47-county
//   implementation (and the one the lost-report route already uses). This
//   module does not hold a county list, an alias table, or a spelling fix-up of
//   its own, and it never guesses a nearby county: an unrecognised value is
//   REJECTED rather than coerced.
import { resolveCountyName } from '../config/kenyaCounties.ts';

/** Bilingual, user-facing copy. Mirrors the existing route message style. */
export const FOUND_COUNTY_MESSAGES = {
  required: 'Tafadhali chagua kaunti ulipopata kitu. / Please choose the county where you found it.',
  invalid: 'Kaunti haikubaliki. / That county is not a recognised Kenyan county.',
} as const;

export interface FoundCountyResolution {
  ok: boolean;
  /** The CANONICAL county — populated exactly when `ok` is true. */
  county?: string;
  /** User-facing bilingual error — populated exactly when `ok` is false. */
  error?: string;
}

/**
 * Resolves an untrusted `foundCounty` value from a report payload.
 *
 * - a missing / blank / whitespace-only value  -> `required`
 * - a non-string value                         -> `invalid`
 * - a value that is not a Kenyan county        -> `invalid` (never coerced)
 * - a canonical name or a known alias          -> the canonical name
 *
 * Case and surrounding whitespace are tolerated (that is `resolveCountyName`'s
 * behaviour, reused rather than reimplemented).
 */
export function resolveFoundCountyInput(raw: unknown): FoundCountyResolution {
  if (raw === undefined || raw === null) return { ok: false, error: FOUND_COUNTY_MESSAGES.required };
  if (typeof raw === 'string' && raw.trim() === '') return { ok: false, error: FOUND_COUNTY_MESSAGES.required };
  if (typeof raw !== 'string') return { ok: false, error: FOUND_COUNTY_MESSAGES.invalid };

  const canonical = resolveCountyName(raw);
  if (!canonical) return { ok: false, error: FOUND_COUNTY_MESSAGES.invalid };
  return { ok: true, county: canonical };
}
