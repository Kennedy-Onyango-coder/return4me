// LOST ↔ FOUND MATCHING ENGINE (Phase 9B)
// ======================================
// Deterministic, explainable, server-side comparison of ONE customer's lost
// report against found items that are CURRENTLY claimable, producing a
// conservative set of "possible match" candidates.
//
// WHAT THIS ENGINE IS NOT
//  - It is NOT an ownership engine. A candidate is a HINT, never a conclusion.
//    `ownership_confirmed` is always false (see services/lostReportMatchView.ts)
//    and no candidate ever changes a claim, an item status or a lost report's
//    status.
//  - It is NOT an AI/statistical matcher. There is no Gemini/Groq/embedding
//    call, no vector store and no opaque score. Every decision below is a
//    deterministic rule over fields that actually exist in this repository, and
//    every internal signal is enumerated for tests.
//  - It is NOT a privacy surface. The engine's output is internal evidence; the
//    customer-facing shape lives in services/lostReportMatchView.ts and is
//    built from the EXISTING public item DTO (services/publicItemView.ts).
//
// FORENSIC FIELD INVENTORY (this is why the signals are shaped as they are)
// -------------------------------------------------------------------------
//   lost_reports                items
//   --------------------------  ------------------------------------------
//   category_id                 category_id + verified_category_id
//   document_number_hash        document_number_hash
//   document_type               (NO equivalent column)
//   county                      (NO county column — free-text location only)
//   location_area               location_description / verified_found_area
//   location_landmark           location_description / verified_found_area
//   brand                       (NO column)
//   model                       (NO column)
//   colour                      (NO column)
//   material                    (NO column)
//   description                 description / verified_description
//   distinctive_marks           description / verified_description
//   lost_at_from / lost_at_to   created_at
//
// CONSEQUENCES, DELIBERATELY ACCEPTED:
//  * There is NO structured attribute field on the found side. brand / model /
//    colour / material can therefore only be CORROBORATED against the item's own
//    free text. They can never contradict it, so they never produce a MISMATCH
//    — only MATCH or UNKNOWN. (A missing mention is not evidence of a
//    difference; see the MATCH/MISMATCH/UNKNOWN rule below.)
//  * `document_type` has no counterpart. It is compared against the item's
//    effective category as a CORROBORATING signal only. It is never allowed to
//    MISMATCH, because a lost report legitimately may declare an identifier
//    CLASS ('imei', 'serial') rather than a document class, and treating
//    'imei' vs 'smartphone' as a mismatch would wrongly eliminate a correct
//    match.
//  * `verified_*` columns are AGENT-CONFIRMED values and are preferred over the
//    finder's original fields, matching the convention recorded in schema.ts
//    ("the only source PublicRecognitionService may read from").
//
// SIGNAL TAXONOMY (derived from the data above, not from the brief's examples)
// -------------------------------------------------------------------------
//   STRONG (can carry a candidate on its own, after the category gate):
//     identifier_match  — exact HMAC-hash equality of the protected identifier.
//   ANCHORS (a "where/when" fact; at least one is required):
//     location_match, time_match, identifier_match
//   SUPPORTING (a "what it is" fact; corroborates an anchor):
//     brand_match, model_match, colour_match, material_match, text_signal
//   CORROBORATING ONLY (never sufficient, never counted toward the minimum):
//     category_match (the gate), document_type_match
import { KENYA_COUNTIES } from '../config/kenyaCounties.ts';

// ---------------------------------------------------------------------------
// SIGNAL STATES
// Three-valued on purpose. "We don't know" and "we know it's different" are
// different facts, and collapsing them would either hide real matches (if
// UNKNOWN counted as MISMATCH) or invent them (if UNKNOWN counted as MATCH).
// ---------------------------------------------------------------------------
export type MatchSignal = 'match' | 'mismatch' | 'unknown';

export interface LostReportMatchSignals {
  category_match: MatchSignal;
  identifier_match: MatchSignal;
  document_type_match: MatchSignal;
  brand_match: MatchSignal;
  model_match: MatchSignal;
  colour_match: MatchSignal;
  material_match: MatchSignal;
  location_match: MatchSignal;
  time_match: MatchSignal;
  text_signal: MatchSignal;
}

/** Why a comparison was accepted as a candidate. */
export type MatchAcceptReason = 'exact_identifier' | 'corroborated_details';

/** Why a comparison was rejected. Every rejection is explainable and testable. */
export type MatchRejectionReason =
  | 'category_mismatch'        // different category, and no equivalence exists in this repo
  | 'identifier_mismatch'      // BOTH sides declared an identifier and they differ
  | 'location_county_mismatch' // the item names a DIFFERENT canonical Kenyan county
  | 'found_before_lost'        // the item was recorded before the loss is claimed to have happened
  | 'insufficient_evidence';   // plausible, but not enough independent evidence

export interface LostReportMatchEvaluation {
  candidate: boolean;
  /** INTERNAL ONLY. Never placed in a customer-facing payload. */
  score: number;
  signals: LostReportMatchSignals;
  reason: MatchAcceptReason | MatchRejectionReason;
  /** Number of significant, non-generic tokens shared with the item's text. */
  sharedTextTokens: number;
}

// ---------------------------------------------------------------------------
// THRESHOLD AND TOLERANCES
//
// These are the whole false-positive policy, so they are named, documented and
// test-pinned rather than inlined.
// ---------------------------------------------------------------------------

/**
 * Independent distinguishing signals required for a candidate.
 *
 * The rule is: an ANCHOR (location, time, or identifier) PLUS this many
 * distinguishing matches in total (the anchor itself counts as one).
 *
 * WHY 2 (and why an anchor is mandatory): a lost "black Samsung phone" that
 * agrees on brand + colour alone must NOT become a candidate for every black
 * Samsung phone in the country. Brand and colour are not independently
 * identity-bearing in that case — they describe a product line, not an object.
 * Requiring a location or time fact means the candidate is tied to the same
 * event (where/when), which is the smallest amount of evidence that is
 * genuinely distinguishing. False positives are worse than misses here: a
 * spurious candidate exposes an unrelated found item to a customer and wastes
 * their time, while a miss simply leaves the existing manual search flow in
 * charge.
 */
export const MIN_DISTINGUISHING_MATCHES = 2;

/**
 * An item recorded up to 6 hours BEFORE the reporter says they lost the item is
 * still accepted as temporally plausible: `lost_at_from` is a reporter-chosen
 * approximation ("sometime around 2pm"), and any timezone/time-entry slip is
 * bounded by this. Beyond it, an item that pre-dates the loss cannot be that
 * item, which is a real (and useful) elimination rather than a preference.
 */
export const TIME_EARLY_TOLERANCE_MS = 6 * 60 * 60 * 1000;

/**
 * Reporting lag: an item found at 2pm may be handed to an agent and recorded
 * minutes, hours or a few days later. A found-item record inside the lost
 * window or up to 7 days after it counts as a temporal MATCH. Later than that
 * is UNKNOWN, not a mismatch — a genuinely late entry is possible and should
 * not eliminate the candidate on its own.
 */
export const TIME_REPORTING_LAG_MS = 7 * 24 * 60 * 60 * 1000;

/** Internal weights. Used for ORDERING only; never exposed to a client. */
export const SIGNAL_WEIGHTS = {
  identifier_match: 100,
  category_match: 20,
  location_match: 15,
  brand_match: 12,
  model_match: 12,
  document_type_match: 10,
  time_match: 10,
  colour_match: 8,
  material_match: 8,
} as const;

const MAX_TEXT_SIGNAL_POINTS = 10;
/** Significant-token overlap required before free text counts as a signal. */
const MIN_SHARED_TEXT_TOKENS = 2;

// ---------------------------------------------------------------------------
// NORMALIZATION
// Deterministic, pure, no dependencies. Lowercase, strip accents, drop
// punctuation, collapse whitespace — so 'Nairobi County' and 'nairobi  county'
// compare equal, and 'Westlands.' and 'Westlands' do too.
// ---------------------------------------------------------------------------
export function normalizeForMatch(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining accents
    .replace(/[^a-z0-9\s]/g, ' ')    // punctuation -> separator
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeForMatch(value: unknown): string[] {
  const normalized = normalizeForMatch(value);
  return normalized ? normalized.split(' ') : [];
}

// ---------------------------------------------------------------------------
// GENERIC VOCABULARY
//
// These lists are the difference between "similar-looking words" and "evidence",
// and they are deliberately explicit so a reviewer can audit exactly which
// words are treated as carrying no distinguishing value.
// ---------------------------------------------------------------------------

/**
 * Administrative/relational words that carry no identifying value in a location
 * string. Used both for location token overlap AND when deciding which words of
 * a county's name are distinctive ('West Pokot' -> 'pokot', so an address
 * mentioning "west gate" can never be read as a mention of West Pokot).
 */
const GENERIC_LOCATION_WORDS = new Set<string>([
  'county', 'city', 'town', 'area', 'district', 'sub', 'subcounty', 'ward',
  'north', 'south', 'east', 'west', 'central', 'upper', 'lower', 'new', 'old',
  'near', 'next', 'opposite', 'behind', 'beside', 'along', 'off', 'main',
  'road', 'street', 'avenue', 'lane', 'highway', 'junction', 'stage', 'stop',
  'building', 'block', 'floor', 'plaza', 'centre', 'center', 'mall', 'market',
  'shop', 'office', 'gate', 'parking', 'kenya', 'the', 'and', 'with',
]);

/**
 * Words that describe a KIND of thing rather than a particular object. The
 * brief's examples ('black', 'phone', 'bag', 'wallet') are all here: free-text
 * overlap on these must never count as evidence, so they are excluded from
 * text_signal. Colours are excluded on purpose too — colour agreement is
 * measured properly by colour_match, and letting the same word count twice
 * would inflate confidence.
 */
const GENERIC_DESCRIPTION_WORDS = new Set<string>([
  'phone', 'phones', 'mobile', 'smartphone', 'handset', 'sim',
  'bag', 'bags', 'handbag', 'backpack', 'rucksack', 'suitcase', 'luggage',
  'wallet', 'wallets', 'purse', 'pouch',
  'black', 'white', 'blue', 'red', 'green', 'brown', 'grey', 'gray',
  'silver', 'gold', 'yellow', 'orange', 'purple', 'pink', 'beige',
  'item', 'items', 'thing', 'things', 'property', 'object',
  'lost', 'found', 'missing', 'dropped',
  'document', 'documents', 'card', 'cards', 'paper', 'papers',
  'case', 'cover', 'holder', 'string', 'strap',
  'small', 'large', 'medium', 'little', 'big',
  'colour', 'color', 'name', 'number', 'serial', 'type', 'brand', 'model',
  'material', 'description', 'marks', 'distinctive', 'detail', 'details',
  'approximately', 'around', 'somewhere', 'between', 'please', 'inside',
  'contains', 'containing', 'with', 'some', 'there', 'that', 'this', 'about',
]);

/** Minimum token length for free-text (description) evidence. */
const TEXT_MIN_TOKEN_LENGTH = 4;
/** Minimum token length for location tokens. */
const LOCATION_MIN_TOKEN_LENGTH = 4;
/** Minimum token length for attribute tokens ('LG', 'S5' are meaningful brands/models). */
const ATTRIBUTE_MIN_TOKEN_LENGTH = 2;

/**
 * Words that are meaningless INSIDE an attribute field ('Brand: N/A',
 * 'Colour: unknown'). Deliberately does NOT reuse GENERIC_DESCRIPTION_WORDS:
 * colours are excluded from free-text evidence (so the word "black" cannot be
 * counted twice), but they are exactly what colour_match has to compare, so
 * the two vocabularies must stay separate.
 */
const ATTRIBUTE_STOPWORDS = new Set<string>([
  'unknown', 'none', 'not', 'known', 'other', 'any', 'no', 'nil', 'null',
  'na', 'n', 'a', 'the', 'and', 'generic', 'various', 'misc', 'unsure',
  'unspecified', 'same', 'as', 'above',
]);

function significantTokens(value: unknown, minLength: number, stopwords: Set<string>): string[] {
  return tokenizeForMatch(value).filter(
    (token) => token.length >= minLength && !stopwords.has(token) && !/^\d+$/.test(token),
  );
}

function countSharedTokens(needles: string[], haystack: Set<string>): number {
  let shared = 0;
  for (const needle of new Set(needles)) {
    if (haystack.has(needle)) shared++;
  }
  return shared;
}

// ---------------------------------------------------------------------------
// CANONICAL COUNTY DETECTION
//
// The lost side stores a CANONICAL county (validated against the 47 in
// config/kenyaCounties.ts), while the found side stores free text. To compare
// them, the free text is scanned for mentions of a canonical county.
//
// The rule is deterministic: a county is "mentioned" only when EVERY
// distinctive word of its official name appears in the text. Words that are
// merely administrative or directional are removed from the county's name first
// ('West Pokot' -> ['pokot'], 'Nairobi City' -> ['nairobi'],
// 'Tana River' -> ['tana','river']). This is what stops "west gate" from being
// read as a mention of West Pokot, and it means a county is never inferred from
// a single ambiguous common word.
// ---------------------------------------------------------------------------
interface CountyTokenIndexEntry {
  name: string;
  distinctiveTokens: string[];
}

const COUNTY_TOKEN_INDEX: CountyTokenIndexEntry[] = KENYA_COUNTIES
  .map((county) => ({
    name: county.name,
    distinctiveTokens: tokenizeForMatch(county.name).filter(
      (token) => !GENERIC_LOCATION_WORDS.has(token) && token.length >= 3,
    ),
  }))
  .filter((entry) => entry.distinctiveTokens.length > 0);

/** Every canonical county named in `tokens`, with no guessing or proximity. */
export function detectCountiesInTokens(tokens: Set<string>): Set<string> {
  const found = new Set<string>();
  for (const entry of COUNTY_TOKEN_INDEX) {
    if (entry.distinctiveTokens.every((token) => tokens.has(token))) {
      found.add(entry.name);
    }
  }
  return found;
}

export function detectCountiesInText(value: unknown): Set<string> {
  return detectCountiesInTokens(new Set(tokenizeForMatch(value)));
}

// ---------------------------------------------------------------------------
// EFFECTIVE ITEM FIELDS
// The agent-verification path keeps the finder's ORIGINAL values untouched and
// writes its corrections into verified_*. Those corrected values are the
// current truth, so they are preferred here (finder value as fallback) — the
// same preference recorded in schema.ts.
// ---------------------------------------------------------------------------
function effectiveItemCategoryId(item: any): string {
  return String(item?.verified_category_id || item?.category_id || '');
}

function effectiveItemLocationText(item: any): string {
  return String(item?.verified_found_area || item?.location_description || '');
}

function effectiveItemDescriptionText(item: any): string {
  return String(item?.verified_description || item?.description || '');
}

function effectiveItemNameText(item: any): string {
  return String(item?.verified_name || item?.document_name_fuzzy || '');
}

/**
 * Matches a lost-report attribute (brand/model/colour/material) against the
 * item's own text. Returns MATCH only when EVERY significant token of the
 * supplied value is present, and never MISMATCH: the found side has no such
 * column, so a missing mention is absence of information, not evidence of a
 * difference.
 */
function attributeSignal(value: unknown, itemTextTokens: Set<string>): MatchSignal {
  const needles = significantTokens(value, ATTRIBUTE_MIN_TOKEN_LENGTH, ATTRIBUTE_STOPWORDS);
  if (needles.length === 0) return 'unknown';
  return needles.every((token) => itemTextTokens.has(token)) ? 'match' : 'unknown';
}

/**
 * EVERY token of the item's human-written text, unfiltered. This is the
 * haystack for attribute comparison, so a colour word ('black') can be found
 * even though the same word is excluded from free-text evidence.
 */
function itemTextTokens(item: any): Set<string> {
  const combined = [
    effectiveItemDescriptionText(item),
    effectiveItemNameText(item),
  ].join(' ');
  return new Set(tokenizeForMatch(combined));
}

/**
 * The item's text reduced to SIGNIFICANT tokens (generic kind-words and colours
 * removed). Used only for the free-text support signal, so shared words like
 * 'phone', 'bag', 'wallet' or 'black' can never be counted as evidence.
 */
function itemNarrativeTokens(item: any): Set<string> {
  const combined = [
    effectiveItemDescriptionText(item),
    effectiveItemNameText(item),
  ].join(' ');
  return new Set(significantTokens(combined, TEXT_MIN_TOKEN_LENGTH, GENERIC_DESCRIPTION_WORDS));
}

function toTimestamp(value: unknown): number | null {
  if (!value) return null;
  const time = new Date(value as any).getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * INTERNAL ordering score. Explicit (never a loop over a weight map) so the
 * arithmetic is auditable, and never returned to a client.
 */
function scoreSignals(signals: LostReportMatchSignals, sharedTextTokens: number): number {
  let score = 0;
  if (signals.identifier_match === 'match') score += SIGNAL_WEIGHTS.identifier_match;
  if (signals.category_match === 'match') score += SIGNAL_WEIGHTS.category_match;
  if (signals.document_type_match === 'match') score += SIGNAL_WEIGHTS.document_type_match;
  if (signals.location_match === 'match') score += SIGNAL_WEIGHTS.location_match;
  if (signals.time_match === 'match') score += SIGNAL_WEIGHTS.time_match;
  if (signals.brand_match === 'match') score += SIGNAL_WEIGHTS.brand_match;
  if (signals.model_match === 'match') score += SIGNAL_WEIGHTS.model_match;
  if (signals.colour_match === 'match') score += SIGNAL_WEIGHTS.colour_match;
  if (signals.material_match === 'match') score += SIGNAL_WEIGHTS.material_match;
  score += Math.min(MAX_TEXT_SIGNAL_POINTS, sharedTextTokens);
  return score;
}

/**
 * Compares ONE lost report against ONE found item and returns the full internal
 * evidence plus the candidacy decision. Pure: no I/O, no clock reads, no
 * randomness — the same inputs always produce the same output, which is what
 * makes the rules testable and the behaviour explainable.
 */
export function evaluateLostReportAgainstItem(lost: any, item: any): LostReportMatchEvaluation {
  const signals: LostReportMatchSignals = {
    category_match: 'unknown',
    identifier_match: 'unknown',
    document_type_match: 'unknown',
    brand_match: 'unknown',
    model_match: 'unknown',
    colour_match: 'unknown',
    material_match: 'unknown',
    location_match: 'unknown',
    time_match: 'unknown',
    text_signal: 'unknown',
  };

  // --- CATEGORY (the gate) --------------------------------------------------
  // No category equivalence is defined anywhere in this repository: the
  // taxonomy in config/categoryTaxonomy.ts groups categories for DISPLAY and
  // carries no alias/superset semantics. So a different category eliminates the
  // candidate rather than being guessed at.
  const lostCategory = String(lost?.category_id || '');
  const itemCategory = effectiveItemCategoryId(item);
  signals.category_match = (lostCategory && itemCategory)
    ? (normalizeForMatch(lostCategory) === normalizeForMatch(itemCategory) ? 'match' : 'mismatch')
    : 'unknown';

  // --- PROTECTED IDENTIFIER (the strongest signal) --------------------------
  // Only ever compared in memory; neither the hash nor any derived value leaves
  // this function. Compared ONLY when both sides have one — an absent identifier
  // is UNKNOWN, never a mismatch.
  const lostHash = lost?.document_number_hash || null;
  const itemHash = item?.document_number_hash || null;
  signals.identifier_match = (lostHash && itemHash)
    ? (lostHash === itemHash ? 'match' : 'mismatch')
    : 'unknown';

  // --- DOCUMENT TYPE (corroborating; can never eliminate) -------------------
  const lostDocType = lost?.document_type || null;
  signals.document_type_match = (lostDocType && itemCategory)
    ? (normalizeForMatch(lostDocType) === normalizeForMatch(itemCategory) ? 'match' : 'unknown')
    : 'unknown';

  // --- STRUCTURED ATTRIBUTES (corroborating) --------------------------------
  const rawItemTokens = itemTextTokens(item);
  const narrativeTokens = itemNarrativeTokens(item);
  signals.brand_match = attributeSignal(lost?.brand, rawItemTokens);
  signals.model_match = attributeSignal(lost?.model, rawItemTokens);
  signals.colour_match = attributeSignal(lost?.colour, rawItemTokens);
  signals.material_match = attributeSignal(lost?.material, rawItemTokens);

  // --- LOCATION -------------------------------------------------------------
  const lostCounty = String(lost?.county || '');
  const itemLocationText = effectiveItemLocationText(item);
  const itemLocationTokens = new Set(tokenizeForMatch(itemLocationText));
  const itemCounties = detectCountiesInTokens(itemLocationTokens);
  const lostAreaTokens = significantTokens(
    [lost?.location_area, lost?.location_landmark].filter(Boolean).join(' '),
    LOCATION_MIN_TOKEN_LENGTH,
    GENERIC_LOCATION_WORDS,
  );
  const areaOverlap = countSharedTokens(lostAreaTokens, itemLocationTokens);

  const countyConflicts = Boolean(lostCounty) && itemCounties.size > 0 && !itemCounties.has(lostCounty);
  const countyAgrees = Boolean(lostCounty) && itemCounties.has(lostCounty);

  if (countyConflicts) {
    // The item's location names a DIFFERENT canonical Kenyan county. Two
    // different counties are strong evidence of two different events, so this
    // eliminates rather than merely failing to corroborate. Only canonical
    // county names trigger it, so a town inside the right county
    // (e.g. "Kitengela" for Kajiado) can never cause a false elimination.
    signals.location_match = 'mismatch';
  } else if (countyAgrees || areaOverlap > 0) {
    signals.location_match = 'match';
  } else {
    signals.location_match = 'unknown';
  }

  // --- TIME -----------------------------------------------------------------
  const lostFrom = toTimestamp(lost?.lost_at_from);
  const lostTo = toTimestamp(lost?.lost_at_to);
  const foundAt = toTimestamp(item?.created_at);
  if (lostFrom === null || foundAt === null) {
    signals.time_match = 'unknown';
  } else {
    const windowEnd = lostTo === null ? lostFrom : Math.max(lostFrom, lostTo);
    if (foundAt < lostFrom - TIME_EARLY_TOLERANCE_MS) {
      signals.time_match = 'mismatch'; // recorded before it was lost — impossible
    } else if (foundAt <= windowEnd + TIME_REPORTING_LAG_MS) {
      signals.time_match = 'match';    // inside the window, or shortly after
    } else {
      signals.time_match = 'unknown';  // long after — plausible, but no support
    }
  }

  // --- FREE TEXT (supporting only) ------------------------------------------
  const lostTextTokens = significantTokens(
    [lost?.description, lost?.distinctive_marks].filter(Boolean).join(' '),
    TEXT_MIN_TOKEN_LENGTH,
    GENERIC_DESCRIPTION_WORDS,
  );
  const sharedTextTokens = countSharedTokens(lostTextTokens, narrativeTokens);
  signals.text_signal = sharedTextTokens >= MIN_SHARED_TEXT_TOKENS ? 'match' : 'unknown';

  const score = scoreSignals(signals, sharedTextTokens);
  return decideCandidate(signals, score, sharedTextTokens);
}

/**
 * THE DECISION RULE, isolated from signal computation so the false-positive
 * policy can be unit-tested directly against hand-built signal sets.
 *
 * ORDER IS THE POLICY, and it is deliberate:
 *
 *  1. CATEGORY is a HARD GATE — a different category always eliminates. The
 *     category is the platform's own classification of what the item is (and
 *     the agent-verified one when a correction exists), so comparing across
 *     categories would mean second-guessing the taxonomy. No equivalence/alias
 *     is defined anywhere in this repository, so none is invented.
 *  2. A CONTRADICTED IDENTIFIER eliminates. If both sides declare a protected
 *     identifier and they differ, this is a different document.
 *  3. An AGREEING IDENTIFIER is accepted, and it OUTRANKS location/time
 *     contradictions. HMAC-SHA256 equality of the normalised identifier is the
 *     strongest evidence this system can produce and is effectively unique,
 *     whereas `county` is reporter-entered and `lost_at_*` is an explicit
 *     approximation ("sometime around 2pm"). An item found in a different
 *     county, or recorded at an odd hour, does not stop a matching document
 *     number from being the same document.
 *  4. LOCATION/TIME contradictions then eliminate: an item that names a
 *     DIFFERENT canonical Kenyan county, or that was recorded well before the
 *     reporter says they lost it.
 *  5. Otherwise a candidate needs an ANCHOR (matching location or matching
 *     time) plus MIN_DISTINGUISHING_MATCHES distinguishing matches in total.
 *     Note this means brand + colour agreement ALONE is never enough: a lost
 *     "black Samsung phone" with no location or time agreement cannot become a
 *     candidate merely because black Samsung phones exist on the platform.
 *
 * A candidate is NEVER ownership — even the identifier branch only produces a
 * hint that the customer must verify through the existing claim process.
 */
export function decideCandidate(
  signals: LostReportMatchSignals,
  score: number,
  sharedTextTokens: number,
): LostReportMatchEvaluation {
  const evaluation = (candidate: boolean, reason: MatchAcceptReason | MatchRejectionReason) =>
    ({ candidate, score, signals, reason, sharedTextTokens });

  if (signals.category_match !== 'match') return evaluation(false, 'category_mismatch');
  if (signals.identifier_match === 'mismatch') return evaluation(false, 'identifier_mismatch');
  if (signals.identifier_match === 'match') return evaluation(true, 'exact_identifier');

  if (signals.location_match === 'mismatch') return evaluation(false, 'location_county_mismatch');
  if (signals.time_match === 'mismatch') return evaluation(false, 'found_before_lost');

  const distinguishingMatches = [
    signals.location_match,
    signals.time_match,
    signals.brand_match,
    signals.model_match,
    signals.colour_match,
    signals.material_match,
    signals.text_signal,
  ].filter((signal) => signal === 'match').length;

  const hasAnchor = signals.location_match === 'match' || signals.time_match === 'match';

  if (hasAnchor && distinguishingMatches >= MIN_DISTINGUISHING_MATCHES) {
    return evaluation(true, 'corroborated_details');
  }
  return evaluation(false, 'insufficient_evidence');
}

export interface LostReportMatchCandidate {
  item: any;
  evaluation: LostReportMatchEvaluation;
}

/**
 * Runs the engine over a candidate item set and returns only accepted
 * candidates, in a DETERMINISTIC order (internal score desc, then most recently
 * recorded, then id) so the same request always yields the same list on any
 * database.
 *
 * The caller is responsible for passing only items that are currently
 * claimable — see routes/lostReports.ts, which reuses the platform's single
 * claimability rule (canCreateClaim) so the matcher can never surface an item
 * the public/claim surfaces would refuse.
 */
export function selectLostReportCandidates(lost: any, items: any[]): LostReportMatchCandidate[] {
  const candidates: LostReportMatchCandidate[] = [];
  const seenItemIds = new Set<string>();

  for (const item of items || []) {
    if (!item || typeof item.id !== 'string') continue;
    if (seenItemIds.has(item.id)) continue;
    seenItemIds.add(item.id);
    const evaluation = evaluateLostReportAgainstItem(lost, item);
    if (evaluation.candidate) candidates.push({ item, evaluation });
  }

  candidates.sort((a, b) =>
    b.evaluation.score - a.evaluation.score ||
    String(b.item?.created_at || '').localeCompare(String(a.item?.created_at || '')) ||
    String(a.item?.id || '').localeCompare(String(b.item?.id || '')),
  );

  return candidates;
}
