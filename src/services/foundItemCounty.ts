// FOUND-ITEM COUNTY RULES (Phase 9D; extended by Phase 16.1 / GEO-16-01)
// ======================================================================
// The ONE place the found-item county means something: what the Finder's
// selection is allowed to become when REPORTING (validation below), and what a
// requested county is allowed to MATCH when SEARCHING (`itemMatchesCanonicalCounty`
// below). Extracted from the routes so both rules are unit-testable directly
// (the same reason routes/lostReports.ts exposes its own
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

/**
 * Does a found item's DECLARED county match a requested canonical county?
 * (Phase 16.1 / GEO-16-01.)
 *
 * This is the public county filter's whole matching rule, and it is deliberately
 * a single equality against `items.found_county` — the value the Finder chose
 * from the canonical selector and the API boundary canonicalised. It compares
 * the item's DECLARED county and nothing else: never `location_description`,
 * never coordinates, never an agent's address, never a geocode. So
 *
 *   county=Mombasa  vs  found_county='Mombasa', location_description='Nyali'
 *     -> MATCH          (the declared county counts, even though the words
 *                        "Mombasa" and "Nyali" have nothing in common)
 *
 *   county=Mombasa  vs  found_county=NULL, location_description='Mombasa Road'
 *     -> NO MATCH       ('Mombasa Road' is a Nairobi street; it is the exact
 *                        false positive Phase 9D removed, and re-introducing it
 *                        here would repeat that bug)
 *
 * LEGACY NULL POLICY (deliberate, documented): rows written before Phase 9D have
 * `found_county IS NULL` — Phase 9D intentionally did not backfill them, because
 * a county is a fact about an item that only a reporter can supply and guessing
 * it is precisely what must never happen. Such a row therefore matches no county
 * filter at all. It is NOT excluded from an UNFILTERED search: with no `county`
 * parameter the caller never reaches this function, so historical items stay
 * searchable exactly as before.
 */
export function itemMatchesCanonicalCounty(
  item: { found_county?: string | null } | null | undefined,
  canonicalCounty: string,
): boolean {
  if (!item) return false;
  return String(item.found_county || '') === canonicalCounty;
}
