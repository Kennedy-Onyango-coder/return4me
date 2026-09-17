// LOST-REPORT PRESENTATION LAYER (Phase 9C)
// =========================================
// The single place a lost-report STATUS or a MATCH REASON is turned into
// customer-facing language. Mirrors components/claimStatus.ts (the same job for
// claims) so the two vocabularies are presented by the same pattern rather than
// by two hand-rolled maps.
//
// WHY IT LIVES IN config/ AND NOT IN A COMPONENT
//   * it is React-free, so it is unit-testable in this repository's node-only
//     vitest environment (there is no jsdom / React Testing Library);
//   * the canonical lost-report STATUS vocabulary already lives beside it in
//     config/lostReportStatuses.ts (Phase 9A), and a test asserts this map
//     covers every value in that vocabulary — a status added there without a
//     customer label fails the suite instead of silently rendering a raw token.
//
// SAFETY RULES ENCODED HERE
//   1. `matching_identifier` must NEVER reproduce, hint at or partially reveal
//      the identifier. It is phrased as "an identifying detail matches".
//   2. No engine implementation detail leaks into customer copy. The matching
//      tolerances (the 6-hour early window and the 7-day reporting lag) are
//      engine internals and appear nowhere here.
//   3. `searching` is derived from the ONE status the backend actually produces
//      candidates for ('active' — see routes/lostReports.ts), so the UI can
//      never promise continued searching on a closed report.
import { LOST_REPORT_STATUS_VALUES, DEFAULT_LOST_REPORT_STATUS } from './lostReportStatuses';

export type LostReportBadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'code';

interface StatusEntry {
  en: string;
  sw: string;
  variant: LostReportBadgeVariant;
  /** One-line, customer-facing explanation of what this state means. */
  descriptionEn: string;
  descriptionSw: string;
  /**
   * Whether the platform is still looking for possible matches for a report in
   * this state. True for exactly the status the backend generates candidates
   * for, so the copy below can never over-promise.
   */
  searching: boolean;
}

const STATUS_MAP: Record<string, StatusEntry> = {
  active: {
    en: 'Active',
    sw: 'Inaendelea',
    variant: 'info',
    descriptionEn: 'We are comparing this report with eligible found items.',
    descriptionSw: 'Tunalinganisha ripoti hii na vitu vilivyopatikana vinavyostahili.',
    searching: true,
  },
  // Reserved by Phase 9A for a future matcher state; nothing sets it today.
  // Presented honestly rather than hidden, so an unexpected value is never a
  // blank badge.
  match_review: {
    en: 'Under review',
    sw: 'Inakaguliwa',
    variant: 'warning',
    descriptionEn: 'A possible match is being reviewed.',
    descriptionSw: 'Mechi inayowezekana inakaguliwa.',
    searching: false,
  },
  resolved: {
    en: 'Resolved',
    sw: 'Imetatuliwa',
    variant: 'success',
    descriptionEn: 'You marked this report as resolved.',
    descriptionSw: 'Uliwekwa alama kuwa ripoti hii imetatuliwa.',
    searching: false,
  },
  cancelled: {
    en: 'Cancelled',
    sw: 'Imeghairiwa',
    variant: 'neutral',
    descriptionEn: 'This report was closed. It is no longer compared with found items.',
    descriptionSw: 'Ripoti hii ilifungwa. Haifananishwi tena na vitu vilivyopatikana.',
    searching: false,
  },
  lapsed: {
    en: 'Lapsed',
    sw: 'Imeisha muda',
    variant: 'neutral',
    descriptionEn: 'This report aged out and is no longer compared with found items.',
    descriptionSw: 'Ripoti hii ilipitwa na muda na haifananishwi tena na vitu vilivyopatikana.',
    searching: false,
  },
};

export interface LostReportStatusDisplay {
  label: string;
  variant: LostReportBadgeVariant;
  description: string;
  searching: boolean;
}

/**
 * Maps a lost-report status to a bilingual, customer-safe presentation.
 * The fallback is last-resort only (every storable value is mapped above); the
 * raw token is retained so an unexpected value stays diagnosable rather than
 * rendering blank. It is deliberately NOT treated as "searching".
 */
export function getLostReportStatusDisplay(status: string, lang: 'en' | 'sw'): LostReportStatusDisplay {
  const entry = STATUS_MAP[status];
  if (!entry) {
    return { label: status, variant: 'neutral', description: '', searching: false };
  }
  return {
    label: lang === 'sw' ? entry.sw : entry.en,
    variant: entry.variant,
    description: lang === 'sw' ? entry.descriptionSw : entry.descriptionEn,
    searching: entry.searching,
  };
}

/** The statuses for which the platform is still actively looking. */
export function isSearchingStatus(status: string): boolean {
  return getLostReportStatusDisplay(status, 'en').searching;
}

/** Every status the backend can store, so a test can assert full coverage. */
export { LOST_REPORT_STATUS_VALUES, DEFAULT_LOST_REPORT_STATUS };

// ---------------------------------------------------------------------------
// MATCH REASONS
// ---------------------------------------------------------------------------
// The exact reason keys services/lostReportMatchView.ts (Phase 9B) can emit, in
// the order it emits them. A test asserts this map covers that list and adds
// nothing of its own — the UI must not invent a reason the engine did not
// produce, and must not silently swallow one it did.
//
// `matching_identifier` is the important one: it means a PROTECTED IDENTIFIER
// agreed, and the explanation must convey exactly that and nothing more. The
// identifier itself — and the hash — never reach this layer at all.
const MATCH_REASON_MAP: Record<string, { en: string; sw: string }> = {
  same_category: {
    en: 'It is the same kind of item you reported.',
    sw: 'Ni aina hiyo hiyo ya kitu ulichoripoti.',
  },
  matching_identifier: {
    en: 'An identifying detail you provided matches this item.',
    sw: 'Maelezo ya utambulisho uliyotoa yanafanana na kitu hiki.',
  },
  matching_document_type: {
    en: 'The type of document or number matches.',
    sw: 'Aina ya hati au namba inafanana.',
  },
  similar_location: {
    en: 'It was recorded in a similar area to where you lost it.',
    sw: 'Iliandikwa katika eneo linalofanana na pale ulipopoteza.',
  },
  similar_time: {
    en: 'It was recorded around the time you reported losing it.',
    sw: 'Iliandikwa karibu na muda ulioripoti kuipoteza.',
  },
  similar_brand: {
    en: 'The brand matches what you described.',
    sw: 'Chapa inafanana na uliyoeleza.',
  },
  similar_model: {
    en: 'The model matches what you described.',
    sw: 'Modeli inafanana na uliyoeleza.',
  },
  similar_colour: {
    en: 'The colour matches what you described.',
    sw: 'Rangi inafanana na uliyoeleza.',
  },
  similar_material: {
    en: 'The material matches what you described.',
    sw: 'Nyenzo inafanana na uliyoeleza.',
  },
  similar_description: {
    en: 'Some of your description matches the notes on this item.',
    sw: 'Baadhi ya maelezo yako yanafanana na maelezo ya kitu hiki.',
  },
};

/** The reason keys Phase 9B can emit — asserted against its source by a test. */
export const LOST_REPORT_MATCH_REASON_KEYS = Object.keys(MATCH_REASON_MAP);

/**
 * Human-readable explanation for one match reason. An unrecognised key returns
 * empty so a future engine reason renders as nothing rather than as a raw
 * snake_case token — and the card still works, because the reasons are
 * supporting detail, never the whole message.
 */
export function getMatchReasonText(reason: string, lang: 'en' | 'sw'): string {
  const entry = MATCH_REASON_MAP[reason];
  if (!entry) return '';
  return lang === 'sw' ? entry.sw : entry.en;
}

// ---------------------------------------------------------------------------
// WIZARD DEFINITION
// ---------------------------------------------------------------------------
/** Step labels for the shared <Stepper> (ui/Stepper.tsx). */
export const LOST_REPORT_WIZARD_STEPS = [
  { en: 'What was lost', sw: 'Kilichopotea' },
  { en: 'Describe it', sw: 'Maelezo' },
  { en: 'Where and when', sw: 'Wapi na lini' },
  { en: 'Review', sw: 'Hakiki' },
] as const;

export const LOST_REPORT_WIZARD_STEP_COUNT = LOST_REPORT_WIZARD_STEPS.length;

/**
 * Optional identifier classes offered in Step 1.
 *
 * WHY THIS EXACT SHAPE: Phase 9B compares the report's `documentType` against
 * the found item's CATEGORY id (normalised), so the options that can actually
 * help matching are the real category ids (national-id, passport, …) plus the
 * generic identifier classes Phase 9A documented as valid for this field
 * ('imei', 'serial' — a phone or laptop identifier, which is not a category).
 * Nothing is invented: every value is either a live category id or one of the
 * two identifier classes 9A named in the field's own documentation.
 *
 * A test asserts each `value` is present in the seeded category taxonomy (or is
 * one of the two identifier classes), so this list cannot drift into a set of
 * document types the platform does not actually know about.
 */
export const LOST_REPORT_IDENTIFIER_CLASSES = [
  { value: 'national-id', en: 'National ID number', sw: 'Namba ya kitambulisho cha kitaifa' },
  { value: 'passport', en: 'Passport number', sw: 'Namba ya pasipoti' },
  { value: 'driving-licence', en: 'Driving licence number', sw: 'Namba ya leseni ya udereva' },
  { value: 'student-id', en: 'Student ID number', sw: 'Namba ya kitambulisho cha mwanafunzi' },
  { value: 'kra-nhif-nssf', en: 'KRA / SHA / NSSF number', sw: 'Namba ya KRA / SHA / NSSF' },
  { value: 'atm-credit-card', en: 'Card number', sw: 'Namba ya kadi' },
  { value: 'vehicle-logbook', en: 'Vehicle logbook number', sw: 'Namba ya logbook ya gari' },
  { value: 'number-plate', en: 'Number plate', sw: 'Bamba la namba' },
  { value: 'imei', en: 'IMEI (phone)', sw: 'IMEI (simu)' },
  { value: 'serial', en: 'Serial number', sw: 'Namba ya serial' },
] as const;

export type LostReportIdentifierClass = (typeof LOST_REPORT_IDENTIFIER_CLASSES)[number]['value'];

/**
 * Identifier classes that are also real item categories — the ones Step 1 can
 * preselect from the chosen category so a customer reporting a lost national ID
 * does not have to pick "National ID number" a second time. The others (IMEI,
 * serial) are never preselected: they describe an identifier, not a category.
 */
export function identifierClassForCategory(categoryId: string): string | null {
  const match = LOST_REPORT_IDENTIFIER_CLASSES.find((entry) => entry.value === categoryId);
  return match ? match.value : null;
}

// ---------------------------------------------------------------------------
// FIELD LIMITS (UI MIRROR OF THE SERVER CONTRACT)
// ---------------------------------------------------------------------------
// These mirror the maxima routes/lostReports.ts enforces (FIELD_LIMITS there).
// They exist ONLY so the form cannot submit a value the server would reject —
// as input `maxLength` attributes, never as the source of truth. The server
// remains the authority and re-validates everything; nothing here is a
// substitute for that, and there is no server rule that is not also enforced
// server-side.
//
// A test asserts these values equal the server's, so a server-side limit change
// that is not reflected here fails the suite rather than silently producing a
// form that submits invalid data.
export const LOST_REPORT_FIELD_LIMITS = {
  brand: 100,
  model: 100,
  colour: 60,
  material: 60,
  documentType: 50,
  locationArea: 120,
  locationLandmark: 160,
  description: 1000,
  distinctiveMarks: 500,
  documentNumber: 64,
} as const;

/** Minimum lengths the server enforces for the two bounded required fields. */
export const LOST_REPORT_FIELD_MINIMUMS = {
  locationArea: 2,
  documentNumber: 3,
} as const;

/**
 * The longest reporting window the server accepts, as a UI guard only. The
 * customer sees a plain "about a month" prompt — the exact engine tolerances
 * (the early window and reporting lag used by the matcher) are deliberately
 * absent from the product copy.
 */
export const LOST_REPORT_MAX_WINDOW_DAYS = 31;



