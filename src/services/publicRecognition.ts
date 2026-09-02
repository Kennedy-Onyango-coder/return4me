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

/**
 * Masks a person's name for public display: first letter of the first
 * TWO name parts only, everything else replaced with asterisks matching
 * the original word's length. Any name parts beyond the second are
 * dropped entirely — never exposed, even masked.
 *
 * "Kennedy Onyango" -> "K****** O******"
 * "Madonna" (one name) -> "M******"
 * "A" (single letter) -> "A" (nothing left to mask without showing
 *   nothing useful at all — a bare single letter is already minimal)
 * null/undefined/empty -> null (caller should omit the name clue
 *   entirely rather than show a placeholder)
 */
export function maskPublicName(fullName: string | null | undefined): string | null {
  if (!fullName || !fullName.trim()) return null;

  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;

  const maskWord = (word: string): string => {
    if (word.length <= 1) return word;
    return word[0] + '*'.repeat(word.length - 1);
  };

  // Only the first two name parts are ever shown, even masked — a third+
  // given name or a middle name is dropped entirely rather than exposed.
  return parts.slice(0, 2).map(maskWord).join(' ');
}

/**
 * Category-aware document-number masking. The exact style is driven by
 * category.public_clue_style (admin-configurable — see schema.ts), NOT
 * hardcoded per category ID here, so new categories/policy changes don't
 * require a code change.
 *
 * 'national_id'      "12345678" -> "12******"
 * 'passport'         "A1234567" -> "A*******"
 * 'driving_licence'  "KX123456" -> "K*******"
 * 'card'             "4111111111114821" -> "•••• 4821"
 * 'none'             -> null (never show a clue for this category, period)
 * 'generic' (default) -> first character + asterisks
 */
export function maskPublicDocumentNumber(
  documentNumber: string | null | undefined,
  style: string
): string | null {
  if (style === 'none') return null;
  if (!documentNumber || !documentNumber.trim()) return null;

  const clean = documentNumber.trim().replace(/\s+/g, '');
  if (clean.length === 0) return null;

  switch (style) {
    case 'national_id': {
      if (clean.length <= 2) return clean[0] + '*'.repeat(Math.max(clean.length - 1, 0));
      return clean.slice(0, 2) + '*'.repeat(clean.length - 2);
    }
    case 'passport':
    case 'driving_licence': {
      if (clean.length <= 1) return clean;
      return clean[0] + '*'.repeat(clean.length - 1);
    }
    case 'card': {
      if (clean.length <= 4) return '•'.repeat(clean.length);
      return '•••• ' + clean.slice(-4);
    }
    case 'generic':
    default: {
      if (clean.length <= 1) return clean;
      return clean[0] + '*'.repeat(clean.length - 1);
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

  return {
    nameClue: maskPublicName(item.verified_name ?? null),
    documentNumberClue: maskPublicDocumentNumber(item.verified_document_number ?? null, category.public_clue_style ?? 'generic'),
    location,
    // Sensitive items never publish a free-text description clue at all —
    // matches the existing behavior (sensitive posts only ever showed
    // name/number/location clues, never raw description text).
    description: null,
  };
}
