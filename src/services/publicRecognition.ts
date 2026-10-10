/**
 * PublicRecognitionService
 * =========================
 * The ONLY place private item data gets transformed into safe public
 * "recognition clues" for social media. SocialService must never mask
 * names/document numbers/locations itself — every value it publishes for
 * a sensitive item comes from here.
 *
 * Pipeline (per the design brief):
 *   private item data (Agent-VERIFIED, never raw Finder data)
 *       -> PublicRecognitionService
 *       -> safe public clues
 *       -> SocialService
 *       -> Facebook / Telegram / X / future platforms
 *
 * The core design constraint: a public post should let a genuine owner
 * think "this could be mine" WITHOUT ever containing enough information
 * to prove ownership on its own. Recognition, not authentication — the
 * private claim workflow (OTP, security questions, ID proof) remains the
 * only real ownership check. Knowing the public clues must never be
 * sufficient to claim anything.
 */

export interface SafePublicClues {
  nameClue: string | null;
  documentNumberClue: string | null;
  location: string;
  // Only meaningful (and only ever populated) for non-sensitive items —
  // sensitive items never get a description clue at all, same as they
  // never get raw description text today. See buildSafePublicClues.
  description: string | null;
}

// ---------------------------------------------------------------------------
// SENTINEL VALUES (P13 DEFECT FIX)
// ---------------------------------------------------------------------------
// Strings an extractor may emit to mean "I could not read this" rather than a
// real value. The OCR response schema types documentNumber/fullName as
// "string or null", so a model that cannot read a field commonly returns the
// literal STRING "NULL" instead of JSON null. Nothing in the pipeline
// (services/ocr.ts -> POST /api/items/analyze -> POST /api/items/report ->
// /api/agents/verify-item -> recordItemVerification) normalizes that sentinel,
// so it arrived at the maskers below looking exactly like a real name or
// document number and produced a FABRICATED public recognition clue:
//     maskPublicName("NULL")            -> "N***"
//     maskPublicDocumentNumber("NULL", …) -> "NU**" / "N***"
// A sentinel means "no value", and the established public policy for "no value"
// is to emit NO clue at all (see the null/empty handling in both functions
// below). This makes that policy hold for sentinels too.
//
// TRADE-OFF, stated deliberately: a genuine surname "Null" (attested in some
// European naming traditions) would also be suppressed. For a PUBLIC clue the
// fail-safe direction is to publish nothing rather than to publish a masked
// clue derived from a string that is overwhelmingly a sentinel.
const SENTINEL_VALUES: ReadonlySet<string> = new Set([
  'null', 'n/a', 'n.a.', 'none', 'nil', 'undefined', 'unknown', '-', '--',
]);

function isSentinelValue(value: string): boolean {
  return SENTINEL_VALUES.has(value.trim().toLowerCase());
}

/**
 * Masks a person's name for public display, under the D-2B-C privacy rule:
 *
 *   * the FIRST name part is shown in full — it is the recognition key a
 *     genuine owner needs to think "this could be mine";
 *   * the SECOND part shows only its first character, the remaining
 *     characters masked (length-matched asterisks);
 *   * the THIRD and every later part follows the same rule — masked to its
 *     first character, never dropped silently and never shown in full;
 *   * a one-part name is that person's first (only) name and stands as-is;
 *   * a single-character part has nothing left to mask and stands as-is;
 *   * null/undefined/empty/sentinel -> null (the caller omits the name clue
 *     entirely rather than showing a placeholder).
 *
 * "Kennedy Otieno Abuga" -> "Kennedy O***** A****"
 * "Madonna" (one name)   -> "Madonna"
 * "A" (single letter)    -> "A"
 *
 * This is the ONE name-masking function every social platform's post flows
 * through (Facebook, Telegram and X all receive their name clue from
 * buildSafePublicClues). It is deliberately distinct from the fuzzy-match
 * masks used for stored search data — those never reach a public post.
 *
 * For especially sensitive categories the admin can set public_clue_style
 * to 'none', which suppresses the name clue ENTIRELY (see
 * buildSafePublicClues) — a full first name can still identify a person, and
 * the privacy classification must be able to say "publish no name at all".
 */
export function maskPublicName(fullName: string | null | undefined): string | null {
  if (!fullName || !fullName.trim()) return null;
  if (isSentinelValue(fullName)) return null;

  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;

  // Iterate by Unicode code points (Array.from), not UTF-16 code units, so an
  // astral character in a name never produces a broken half surrogate at the
  // mask boundary.
  const maskWord = (word: string): string => {
    const chars = Array.from(word);
    if (chars.length <= 1) return word;
    return chars[0] + '*'.repeat(chars.length - 1);
  };

  return parts
    .map((part, index) => (index === 0 ? part : maskWord(part)))
    .join(' ');
}

// ---------------------------------------------------------------------------
// AUTHORITATIVE public_clue_style VOCABULARY (P14A / P14-05)
// ---------------------------------------------------------------------------
// The complete set of values `categories.public_clue_style` may hold. This is
// the SINGLE definition: the switch in maskPublicDocumentNumber() below
// implements exactly these cases, src/db/schema.ts documents the same set, and
// the admin category routes validate against this list rather than re-typing
// it. Order is the order the admin console offers them in, safest-first.
//
// 'none' means never publish a document-number clue for that category at all,
// whatever was extracted — the strictest of the styles.
export const PUBLIC_CLUE_STYLES = [
  'none',
  'national_id',
  'passport',
  'driving_licence',
  'card',
  'generic',
] as const;

export type PublicClueStyle = (typeof PUBLIC_CLUE_STYLES)[number];

/** True only for a value this module (and the DB column) actually supports. */
export function isPublicClueStyle(value: unknown): value is PublicClueStyle {
  return typeof value === 'string' && (PUBLIC_CLUE_STYLES as readonly string[]).includes(value);
}

/**
 * Category-aware document-number masking. The exact style is driven by
 * category.public_clue_style (admin-configurable — see schema.ts), NOT
 * hardcoded per category ID here, so new categories/policy changes don't
 * require a code change.
 *
 * D-2B-C PRIVACY RULE — a COMPLETE national ID, passport number, driving
 * licence number or card number is NEVER published, under any style. A
 * limited suffix (the last four characters, rendered `•••• 4821`) is revealed
 * only where the style explicitly permits it:
 *
 * 'national_id'      "12345678" -> "•••• 5678"  (limited suffix — the standard "ID ending …" shape)
 * 'card'             "4111111111114821" -> "•••• 4821" (PCI-style limited suffix)
 * 'passport'         "A1234567" -> "********"   (format uncertain -> mask the ENTIRE identifier)
 * 'driving_licence'  "KX123456" -> "********"   (format uncertain -> mask the ENTIRE identifier)
 * 'none'             -> null (never show a clue for this category, period)
 * 'generic' (default, and any future unmapped style) -> full mask
 */
export function maskPublicDocumentNumber(
  documentNumber: string | null | undefined,
  style: string
): string | null {
  if (style === 'none') return null;
  if (!documentNumber || !documentNumber.trim()) return null;

  const clean = documentNumber.trim().replace(/\s+/g, '');
  if (clean.length === 0) return null;
  // A provider/field sentinel ("NULL", "N/A", …) is "no value", not a document
  // number — see the SENTINEL_VALUES comment above. Compound sentinels such as
  // "N/A" are already whitespace-free by this point.
  if (isSentinelValue(clean)) return null;

  switch (style) {
    case 'national_id':
    case 'card': {
      // The two styles that explicitly permit a limited suffix reveal. A
      // value too short to yield a safe suffix is masked entirely — a short
      // number (a PIN or CVV-shaped value) is never shown in any form.
      if (clean.length <= 4) return '•'.repeat(clean.length);
      return '•••• ' + clean.slice(-4);
    }
    case 'passport':
    case 'driving_licence':
    case 'generic':
    default: {
      // Suffix reveal is not explicitly permitted for these formats (and any
      // future, unmapped style has an uncertain format), so the ENTIRE
      // identifier is masked.
      return '*'.repeat(clean.length);
    }
  }
}

/**
 * Reduces a Finder/Agent-supplied location string down to a general
 * public-safe area — "Eastleigh, Nairobi" / "Nairobi CBD" / "Likoni,
 * Mombasa" style — never an exact address, house number, or GPS
 * coordinate. This is deliberately separate from server.ts's
 * getRoughArea (used elsewhere for agent-facing search listings, a
 * different and already-hardened concern) — this is the ONLY location
 * transform PublicRecognitionService (and therefore any public social
 * post) is allowed to use.
 */
export function safePublicLocation(rawLocation: string | null | undefined): string {
  if (!rawLocation || !rawLocation.trim()) return 'Kenya';

  const clean = rawLocation.trim();

  // If the Finder/Agent already wrote something in "Area, Town" or
  // "Area, County" form, keep just that shape — it's already
  // appropriately general, not an exact address.
  const commaParts = clean.split(',').map(p => p.trim()).filter(Boolean);
  if (commaParts.length >= 2) {
    return `${commaParts[0]}, ${commaParts[commaParts.length - 1]}`;
  }
  if (commaParts.length === 1 && commaParts[0].length > 2 && commaParts[0].split(/\s+/).length <= 3) {
    return commaParts[0];
  }

  // Fall back to the first few words — avoids ever echoing back an exact
  // street address or house number that might follow later in a longer
  // free-text description.
  const words = clean.split(/\s+/).slice(0, 3).join(' ');
  return words || 'Kenya';
}

interface VerifiedItemLike {
  is_sensitive_document: boolean;
  // REQUIRED as a value (throws if not one of the verified statuses) but
  // OPTIONAL as a TypeScript key — a caller's underlying type (e.g.
  // FoundItem) may itself declare this field optional, and an
  // undefined/missing value is treated identically to any other
  // non-verified status by the runtime check below: it throws. See the
  // fail-closed guarantee on buildSafePublicClues.
  verification_status?: string | null;
  verified_name?: string | null;
  verified_document_number?: string | null;
  verified_found_area?: string | null;
  verified_description?: string | null;
}

interface CategoryLike {
  public_clue_style?: string;
}

const VERIFIED_STATUSES = new Set(['confirmed_as_reported', 'corrected']);

/**
 * Builds the full set of safe public clues for an item.
 *
 * P0 FAIL-CLOSED GUARANTEE: throws (never silently substitutes) if
 * verification_status is not 'confirmed_as_reported' or 'corrected'. This
 * used to fall back to ocr_extracted_name/ocr_extracted_number/
 * location_description — raw, Agent-unverified Finder/OCR data — whenever
 * the verified_* fields were null, on the theory that verification simply
 * "hadn't happened yet" for this call. That reasoning was backwards: per
 * the VerifiedItemLike comment above, once verification has genuinely
 * happened the verified_* fields are always populated (possibly with
 * nulls that are themselves the correct, final answer) — so a null
 * verified_* field is never actually evidence that verification is
 * incomplete, and silently substituting raw data risked publishing
 * unverified information under the guise of "verified public recognition"
 * with no signal that anything unusual had happened. Now the ONLY thing
 * that decides whether this function proceeds at all is
 * verification_status itself, checked explicitly and rejected loudly.
 * Applies identically to sensitive and non-sensitive items — see the
 * location clue below, which used to fall back to raw location_description
 * for exactly the items (non-sensitive) that skipped the sensitive-only
 * name/number fallback check entirely.
 */
export function buildSafePublicClues(item: VerifiedItemLike, category: CategoryLike): SafePublicClues {
  if (!VERIFIED_STATUSES.has(item.verification_status ?? '')) {
    throw new Error(
      `PublicRecognitionService.buildSafePublicClues called for an item with verification_status='${item.verification_status ?? 'null'}' — only 'confirmed_as_reported' or 'corrected' items may enter public recognition. Refusing rather than falling back to unverified data.`
    );
  }

  const location = safePublicLocation(item.verified_found_area ?? null);

  if (!item.is_sensitive_document) {
    // Non-sensitive items don't get identity/document clues — there's no
    // PII-shaped data to mask for a backpack or a phone — but DO get a
    // description clue, sourced only from verified_description (never
    // raw, Agent-unverified description text).
    return { nameClue: null, documentNumberClue: null, location, description: item.verified_description ?? null };
  }

  // D-2B-C: 'none' is the STRICTEST classification and now suppresses the
  // name clue too. A full first name can still identify a person, so a
  // category whose policy says "publish no document-number clue, period"
  // is understood to mean "publish no identity clue at all" — name
  // included. Every other style keeps the masked recognition name under
  // the one shared masking rule (maskPublicName).
  const style = category.public_clue_style ?? 'generic';
  return {
    nameClue: style === 'none' ? null : maskPublicName(item.verified_name ?? null),
    documentNumberClue: maskPublicDocumentNumber(item.verified_document_number ?? null, style),
    location,
    // Sensitive items never publish a free-text description clue at all —
    // matches the existing behavior (sensitive posts only ever showed
    // name/number/location clues, never raw description text).
    description: null,
  };
}
