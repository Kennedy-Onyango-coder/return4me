// CUSTOMER LOST-ITEM REPORT ROUTES (Phase 9A)
// ==========================================
// The real backend for lost-item reporting:
//
//   POST /api/lost-reports      — create a lost report (authenticated customer)
//   GET  /api/lost-reports      — the authenticated customer's OWN reports
//   GET  /api/lost-reports/:id  — one OWN report, by public reference
//
// WHY THIS IS A SEPARATE MODULE
// server.ts constructs the whole application and calls startServer() at import
// time, so it cannot be imported by a test without booting Vite middleware,
// background sweeps and listeners. Registering into the caller's Express app
// lets the HTTP integration tests mount REAL handlers around the REAL
// requireCustomerAuth middleware and the REAL DTOs (same pattern as
// routes/customerClaims.ts, routes/publicItems.ts).
//
// AUTHORIZATION MODEL
//  - Identity comes ONLY from req.customer, resolved by requireCustomerAuth
//    from the session cookie's hash. A `customerId`/`customer_id` in the body
//    is REJECTED outright rather than ignored, so a caller can never even
//    attempt to report on another account's behalf.
//  - Reporting requires an authenticated, active customer. Contact details are
//    NOT duplicated into the lost report: the report joins to the customer
//    account, whose phone is already OTP-verified (services/customerAuth.ts).
//    Anonymous reporting is deliberately NOT supported in this phase — there
//    would be no verified way to contact the reporter, and it would be a free
//    unauthenticated write path into a table a future matcher trusts.
//  - Every read is owner-scoped IN THE QUERY, and a cross-customer reference
//    yields the SAME 404 as a non-existent one, so the endpoint cannot be used
//    to enumerate other people's reports.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO
//  - No matching, scoring, "possible match" signalling — Phase 9B.
//  - No public/unauthenticated discovery of lost reports.
//  - No admin listing — that belongs to a dedicated admin phase.
import { db } from '../db/database.ts';
import { requireCustomerAuth } from '../services/customerAuth.ts';
import { hashDocument } from '../services/documentHash.ts';
import { resolveCountyName } from '../config/kenyaCounties.ts';
import { DEFAULT_LOST_REPORT_STATUS } from '../config/lostReportStatuses.ts';
import { generateLostReportReference, isLostReportReference } from '../services/lostReportReference.ts';
import { toCustomerSafeLostReportView, toLostReportCreationResponse } from '../services/lostReportView.ts';
// The anti-spam policy lives in exactly one place (config/lostReportLimiter.ts).
// These are re-exported so server.ts mounts the SHIPPED instances rather than
// constructing its own.
import { lostReportIpLimiter, lostReportCustomerLimiter, lostReportMatchIpLimiter, lostReportMatchCustomerLimiter } from '../config/lostReportLimiter.ts';
// Phase 9B: the deterministic, explainable matching engine and its
// customer-facing (privacy-bounded) view.
import { selectLostReportCandidates } from '../services/lostReportMatching.ts';
import { buildLostReportMatchesResponse, REPORT_NOT_ACTIVE_NOTICE } from '../services/lostReportMatchView.ts';

export { lostReportIpLimiter, lostReportCustomerLimiter, lostReportMatchIpLimiter, lostReportMatchCustomerLimiter };

// ---------------------------------------------------------------------------
// VALIDATION LIMITS
// Deliberately modest: a genuine description of a lost item does not need
// thousands of characters, and an unbounded text column is a cheap way to turn
// a report table into a storage-abuse target.
// ---------------------------------------------------------------------------
const FIELD_LIMITS = {
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

const LOCATION_AREA_MIN_LENGTH = 2;
const DOCUMENT_NUMBER_MIN_LENGTH = 3;

// Time-window bounds. `lost_at_from` may not be absurdly far in the past nor
// meaningfully in the future (6 hours tolerates clock skew / timezone confusion
// without allowing nonsense), and the window itself may span at most 31 days —
// "I lost it between 2pm and 5pm" is the target case.
const LOST_AT_MAX_PAST_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const LOST_AT_MAX_FUTURE_MS = 6 * 60 * 60 * 1000;
const LOST_AT_MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

// Any Unicode control character except tab (09), newline (0A) and carriage
// return (0D) is refused in free text, so a payload cannot smuggle terminal or
// control sequences into a log line or a future rendered view.
const DISALLOWED_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const MESSAGES = {
  malformed: 'Ombi si sahihi. Tafadhali tuma taarifa kamili. / The request is malformed. Please send a complete payload.',
  clientIdentityRejected: 'Hauwezi kubainisha akaunti kwenye ombi. / You cannot specify an account in the request.',
  categoryRequired: 'Tafadhali chagua aina ya kitu. / Please choose an item category.',
  categoryInvalid: 'Aina ya kitu haikubaliki. / That item category is not valid.',
  countyRequired: 'Tafadhali chagua kaunti. / Please choose a county.',
  countyInvalid: 'Kaunti haikubaliki. / That county is not a recognised Kenyan county.',
  lostAtFromRequired: 'Tafadhali weka wakati uliopotea. / Please provide when the item was lost.',
  lostAtFromInvalid: 'Wakati uliopotea si sahihi. / The lost time is not a valid date.',
  lostAtRangeInvalid: 'Kipindi cha muda si sahihi. / The lost time window is not valid.',
  notFound: 'Ripoti haipatikani kwenye akaunti yako. / That lost report is not on your account.',
  tooLong: (max: number, label: string) => `${label} ni ndefu mno (kikomo ${max} herufi). / ${label} is too long (limit ${max} characters).`,
  tooShort: (min: number, label: string) => `${label} ni fupi mno (angalau ${min} herufi). / ${label} is too short (at least ${min} characters).`,
  wrongType: (label: string) => `${label} si sahihi. / ${label} is invalid.`,
  invalidChars: (label: string) => `${label} ina herufi zisizoruhusiwa. / ${label} contains disallowed characters.`,
};

// Result of a single text-field check. Deliberately a single shape with
// optional members rather than a boolean-discriminated union: this project
// compiles with `strictNullChecks` off (see tsconfig.json), under which
// discriminant narrowing on a boolean `ok` flag is not reliable. `error` is
// non-null exactly when the field failed.
interface TextOutcome {
  ok: boolean;
  value?: string | null;
  error?: string;
}

function optionalText(raw: any, max: number, label: string): TextOutcome {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: MESSAGES.wrongType(label) };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > max) return { ok: false, error: MESSAGES.tooLong(max, label) };
  if (DISALLOWED_CONTROL_CHARS.test(trimmed)) return { ok: false, error: MESSAGES.invalidChars(label) };
  return { ok: true, value: trimmed };
}

function requiredText(raw: any, max: number, min: number, label: string): TextOutcome {
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
    return { ok: false, error: MESSAGES.tooShort(min, label) };
  }
  if (typeof raw !== 'string') return { ok: false, error: MESSAGES.wrongType(label) };
  const trimmed = raw.trim();
  if (trimmed.length < min) return { ok: false, error: MESSAGES.tooShort(min, label) };
  if (trimmed.length > max) return { ok: false, error: MESSAGES.tooLong(max, label) };
  if (DISALLOWED_CONTROL_CHARS.test(trimmed)) return { ok: false, error: MESSAGES.invalidChars(label) };
  return { ok: true, value: trimmed };
}

function parseDateInput(raw: any): Date | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/** The validated, normalized draft — already free of client-supplied identity. */
export interface LostReportDraft {
  category_id: string;
  county: string;
  location_area: string;
  location_landmark: string | null;
  lost_at_from: string;
  lost_at_to: string | null;
  brand: string | null;
  model: string | null;
  colour: string | null;
  material: string | null;
  description: string | null;
  distinctive_marks: string | null;
  document_type: string | null;
  document_number_hash: string | null;
}

// Same rationale as TextOutcome above: one interface with optional members so
// callers can read `.error` / `.draft` without relying on union narrowing
// (unavailable under strictNullChecks: false). `ok === true` means `draft` is
// populated; `ok === false` means `error` is populated.
export interface LostReportValidation {
  ok: boolean;
  draft?: LostReportDraft;
  error?: string;
}

/**
 * Server-side validation for a lost-report payload. Every field a client can
 * influence is checked HERE — the frontend is never trusted.
 *
 * `categories` is the live category list (from db.getCategories()) so a report
 * can only reference a category that actually exists, matching the FK.
 */
export function validateLostReportPayload(body: any, categories: Array<{ id: string }>): LostReportValidation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: MESSAGES.malformed };
  }

  // The client may NEVER select the account a report is attributed to.
  if (Object.prototype.hasOwnProperty.call(body, 'customerId') ||
      Object.prototype.hasOwnProperty.call(body, 'customer_id')) {
    return { ok: false, error: MESSAGES.clientIdentityRejected };
  }

  const categoryId = typeof body.categoryId === 'string' ? body.categoryId.trim() : '';
  if (!categoryId) return { ok: false, error: MESSAGES.categoryRequired };
  if (!categories.some((c) => c && c.id === categoryId)) {
    return { ok: false, error: MESSAGES.categoryInvalid };
  }

  if (body.county === undefined || body.county === null || body.county === '') {
    return { ok: false, error: MESSAGES.countyRequired };
  }
  if (typeof body.county !== 'string') return { ok: false, error: MESSAGES.countyInvalid };
  const county = resolveCountyName(body.county);
  if (!county) return { ok: false, error: MESSAGES.countyInvalid };

  const locationArea = requiredText(body.locationArea, FIELD_LIMITS.locationArea, LOCATION_AREA_MIN_LENGTH, 'Town/Area');
  if (!locationArea.ok) return locationArea;

  const locationLandmark = optionalText(body.locationLandmark, FIELD_LIMITS.locationLandmark, 'Landmark');
  if (!locationLandmark.ok) return locationLandmark;

  // --- TIME WINDOW ---
  if (body.lostAtFrom === undefined || body.lostAtFrom === null || body.lostAtFrom === '') {
    return { ok: false, error: MESSAGES.lostAtFromRequired };
  }
  const from = parseDateInput(body.lostAtFrom);
  if (!from) return { ok: false, error: MESSAGES.lostAtFromInvalid };

  const now = Date.now();
  if (from.getTime() > now + LOST_AT_MAX_FUTURE_MS) return { ok: false, error: MESSAGES.lostAtRangeInvalid };
  if (from.getTime() < now - LOST_AT_MAX_PAST_MS) return { ok: false, error: MESSAGES.lostAtRangeInvalid };

  let to: Date | null = null;
  if (body.lostAtTo !== undefined && body.lostAtTo !== null && body.lostAtTo !== '') {
    to = parseDateInput(body.lostAtTo);
    if (!to) return { ok: false, error: MESSAGES.lostAtRangeInvalid };
    if (to.getTime() < from.getTime()) return { ok: false, error: MESSAGES.lostAtRangeInvalid };
    if (to.getTime() > now + LOST_AT_MAX_FUTURE_MS) return { ok: false, error: MESSAGES.lostAtRangeInvalid };
    if (to.getTime() - from.getTime() > LOST_AT_MAX_WINDOW_MS) return { ok: false, error: MESSAGES.lostAtRangeInvalid };
  }

  // --- IDENTIFYING ATTRIBUTES ---
  const brand = optionalText(body.brand, FIELD_LIMITS.brand, 'Brand');
  if (!brand.ok) return brand;
  const model = optionalText(body.model, FIELD_LIMITS.model, 'Model');
  if (!model.ok) return model;
  const colour = optionalText(body.colour, FIELD_LIMITS.colour, 'Colour');
  if (!colour.ok) return colour;
  const material = optionalText(body.material, FIELD_LIMITS.material, 'Material');
  if (!material.ok) return material;
  const description = optionalText(body.description, FIELD_LIMITS.description, 'Description');
  if (!description.ok) return description;
  const distinctiveMarks = optionalText(body.distinctiveMarks, FIELD_LIMITS.distinctiveMarks, 'Distinctive marks');
  if (!distinctiveMarks.ok) return distinctiveMarks;
  const documentType = optionalText(body.documentType, FIELD_LIMITS.documentType, 'Document type');
  if (!documentType.ok) return documentType;

  // --- PROTECTED IDENTIFIER ---
  // The plaintext is hashed with the SAME primitive found items use and is
  // never stored or returned. An optional identifier that is present but
  // malformed (too short / too long / non-string) is REJECTED rather than
  // silently dropped, so a reporter is never misled into thinking an
  // identifier was recorded when it was not.
  let documentNumberHash: string | null = null;
  if (body.documentNumber !== undefined && body.documentNumber !== null && body.documentNumber !== '') {
    if (typeof body.documentNumber !== 'string') return { ok: false, error: MESSAGES.wrongType('Document number') };
    const trimmedNumber = body.documentNumber.trim();
    if (trimmedNumber.length < DOCUMENT_NUMBER_MIN_LENGTH) {
      return { ok: false, error: MESSAGES.tooShort(DOCUMENT_NUMBER_MIN_LENGTH, 'Document number') };
    }
    if (trimmedNumber.length > FIELD_LIMITS.documentNumber) {
      return { ok: false, error: MESSAGES.tooLong(FIELD_LIMITS.documentNumber, 'Document number') };
    }
    if (DISALLOWED_CONTROL_CHARS.test(trimmedNumber)) {
      return { ok: false, error: MESSAGES.invalidChars('Document number') };
    }
    // hashDocument trims + upper-cases internally; passing the trimmed input
    // unchanged keeps this identical to the found-item hashing path, so a
    // future matcher can compare the two by exact hash.
    documentNumberHash = hashDocument(trimmedNumber);
  }

  return {
    ok: true,
    draft: {
      category_id: categoryId,
      county,
      location_area: locationArea.value as string,
      location_landmark: locationLandmark.value,
      lost_at_from: from.toISOString(),
      lost_at_to: to ? to.toISOString() : null,
      brand: brand.value,
      model: model.value,
      colour: colour.value,
      material: material.value,
      description: description.value,
      distinctive_marks: distinctiveMarks.value,
      document_type: documentType.value,
      document_number_hash: documentNumberHash,
    },
  };
}

/** A unique-constraint violation, whether raw or wrapped by createLostReport's `cause`. */
function isUniqueViolation(err: any): boolean {
  return err?.code === '23505' || err?.cause?.code === '23505';
}

/**
 * Inserts a lost report under a fresh, crypto-random public reference,
 * retrying on the (astronomically unlikely) reference collision so a
 * birthday-paradox clash can never surface to a reporter as a 500.
 */
async function createReportWithUniqueReference(
  customerId: string,
  draft: LostReportDraft,
  maxAttempts: number = 5
): Promise<any> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const reference = generateLostReportReference();
    try {
      return await db.createLostReport({
        id: reference,
        customer_id: customerId,
        status: DEFAULT_LOST_REPORT_STATUS,
        ...draft,
      });
    } catch (err: any) {
      if (isUniqueViolation(err)) {
        console.warn(`[LOST REPORT] Reference collision on ${reference}, retrying (attempt ${attempt + 1}/${maxAttempts}).`);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Could not allocate a unique lost-report reference.');
}

export interface LostReportRouteDeps {
  /** server.ts's sendServerError — keeps error disclosure uniform. */
  sendServerError: (res: any, error: any, context: string) => void;
  /**
   * server.ts's CENTRAL claimability rule (status 'at_agent', not flagged, no
   * unresolved dispute). Injected rather than re-implemented, exactly as
   * routes/publicItems.ts injects it, so the matcher can only ever surface an
   * item that the public search, the public item page AND the claim endpoint
   * would each accept. A candidate can therefore never expose an item that is
   * not already publicly claimable.
   */
  canCreateClaim: (item: any, preFetchedDisputes?: any[]) => Promise<{ allowed: boolean; reason: string }>;
  /**
   * Test seam: replace the customer-keyed limiter with a small-threshold one so
   * the REAL handler can be driven past its cap over HTTP. Production omits
   * this and gets the shipped instance.
   */
  customerRateLimiter?: any;
  /** Test seam: replace the IP-keyed limiter (same rationale as above). */
  ipRateLimiter?: any;
  /** Test seam: the Phase 9B matching limiter (same rationale as above). */
  matchCustomerRateLimiter?: any;
}

export function registerLostReportRoutes(app: any, deps: LostReportRouteDeps): void {
  const { sendServerError, canCreateClaim } = deps;
  const ipLimiter: any = deps.ipRateLimiter ?? lostReportIpLimiter;
  const customerLimiter: any = deps.customerRateLimiter ?? lostReportCustomerLimiter;
  const matchCustomerLimiter: any = deps.matchCustomerRateLimiter ?? lostReportMatchCustomerLimiter;

  // ---------------------------------------------------------------------------
  // CREATE. Limiter order is deliberate:
  //   IP limiter -> authentication -> customer limiter -> handler
  // The IP ceiling applies even to an unauthenticated flood; the customer
  // ceiling is an IP-independent cap so one account cannot flood the table by
  // rotating addresses.
  // ---------------------------------------------------------------------------
  app.post('/api/lost-reports', ipLimiter, requireCustomerAuth, customerLimiter, async (req: any, res: any) => {
    try {
      const categories = await db.getCategories();
      const validation = validateLostReportPayload(req.body, categories);
      if (!validation.ok) {
        return res.status(400).json({ error: validation.error });
      }

      // Identity comes ONLY from the authenticated session.
      const report = await createReportWithUniqueReference(req.customer.id, validation.draft);

      // 201 Created — the response is the minimal acknowledgement shape (public
      // reference, status, created timestamp); no customer id, no hash, no
      // internal fields.
      return res.status(201).json(toLostReportCreationResponse(report));
    } catch (e: any) {
      return sendServerError(res, e, 'LOST_REPORT_CREATE_ERROR');
    }
  });

  // ---------------------------------------------------------------------------
  // LIST — the authenticated customer's own reports only. There is no
  // unauthenticated or cross-customer list route.
  // ---------------------------------------------------------------------------
  app.get('/api/lost-reports', requireCustomerAuth, async (req: any, res: any) => {
    try {
      const reports = await db.getLostReportsByCustomer(req.customer.id);
      return res.json({ lost_reports: reports.map(toCustomerSafeLostReportView) });
    } catch (e: any) {
      return sendServerError(res, e, 'LOST_REPORT_LIST_ERROR');
    }
  });

  // ---------------------------------------------------------------------------
  // DETAIL — one OWN report by public reference.
  //
  // A malformed shape and a well-formed reference that belongs to nobody both
  // produce the SAME 404 body, and a miss on the caller's own account is
  // indistinguishable from a miss on someone else's: the ownership predicate is
  // inside the query, so the endpoint cannot be used to discover whether
  // another customer's report exists.
  // ---------------------------------------------------------------------------
  app.get('/api/lost-reports/:id', requireCustomerAuth, async (req: any, res: any) => {
    try {
      const reference = String(req.params.id || '').trim().toUpperCase();
      if (!isLostReportReference(reference)) {
        return res.status(404).json({ error: MESSAGES.notFound });
      }
      const report = await db.getLostReportByIdForCustomer(reference, req.customer.id);
      if (!report) return res.status(404).json({ error: MESSAGES.notFound });
      return res.json({ lost_report: toCustomerSafeLostReportView(report) });
    } catch (e: any) {
      return sendServerError(res, e, 'LOST_REPORT_DETAIL_ERROR');
    }
  });

  // ---------------------------------------------------------------------------
  // POSSIBLE MATCHES — GET /api/lost-reports/:id/matches   (Phase 9B)
  //
  // Returns possible found-item candidates for ONE lost report the caller owns.
  //
  // WHAT A CANDIDATE IS: a hint produced by a deterministic, explainable rules
  // engine (services/lostReportMatching.ts). It is NEVER ownership, never a
  // claim, and never a payment. No row anywhere is written by this route, and
  // the response always carries `ownership_confirmed: false`. Recovering
  // anything still requires the customer to go through the EXISTING claim and
  // verification flow via the public item page.
  //
  // OWNERSHIP + ENUMERATION: identical to the 9A detail route. The lookup is
  // owner-scoped INSIDE the query, and a malformed, unknown or other-owner
  // reference all produce the SAME 404 body, so this endpoint is not a lost
  // report existence oracle and can never read another customer's matches.
  //
  // ELIGIBILITY: candidates are drawn only from items that pass the platform's
  // single central claimability rule (canCreateClaim — status 'at_agent', not
  // flagged for review, no unresolved dispute), so the matcher can never
  // disclose an item the public/claim surfaces would refuse. The query is the
  // same indexed `status = 'at_agent'` fetch the public search already uses.
  //
  // LIMITER ORDER: requireCustomerAuth first (a cheap 401 for anonymous
  // callers, and it is what makes the customer-keyed bucket possible), then the
  // IP-keyed cap, then the per-customer cap.
  // ---------------------------------------------------------------------------
  app.get('/api/lost-reports/:id/matches', requireCustomerAuth, lostReportMatchIpLimiter, matchCustomerLimiter, async (req: any, res: any) => {
    try {
      const reference = String(req.params.id || '').trim().toUpperCase();
      if (!isLostReportReference(reference)) {
        return res.status(404).json({ error: MESSAGES.notFound });
      }

      const lostReport = await db.getLostReportByIdForCustomer(reference, req.customer.id);
      if (!lostReport) return res.status(404).json({ error: MESSAGES.notFound });

      // A closed report (resolved / cancelled / lapsed) must not keep producing
      // candidates: the customer has told us they are no longer looking. This is
      // an EMPTY result with an explicit notice, never a 404 — the report does
      // exist and the caller owns it.
      if (lostReport.status !== DEFAULT_LOST_REPORT_STATUS) {
        return res.json(buildLostReportMatchesResponse(lostReport, [], REPORT_NOT_ACTIVE_NOTICE));
      }

      const claimableItems = await loadClaimableItems(canCreateClaim);
      const candidates = selectLostReportCandidates(lostReport, claimableItems);
      return res.json(buildLostReportMatchesResponse(lostReport, candidates));
    } catch (e: any) {
      return sendServerError(res, e, 'LOST_REPORT_MATCHES_ERROR');
    }
  });
}

/**
 * Every found item that is CURRENTLY publicly claimable, using the same rule
 * and the same batched-dispute pattern the public search route uses:
 *   one indexed `status = 'at_agent'` query, one batched dispute lookup, then
 *   the central claimability predicate per item.
 *
 * COMPLEXITY: O(I) database rows and O(I) in-memory predicate evaluations per
 * request, where I is the number of 'at_agent' items — identical to what the
 * public search endpoint already does on every anonymous hit. That is
 * deliberately NOT a bespoke search index: the dataset is small, the filter is
 * indexed, and premature optimisation here would add machinery with no measured
 * need.
 */
async function loadClaimableItems(
  canCreateClaim: LostReportRouteDeps['canCreateClaim'],
): Promise<any[]> {
  const items = await db.getItemsByStatus('at_agent');
  if (items.length === 0) return [];

  const disputesByItem = await db.getDisputesByItemIds(items.map((item: any) => item.id));
  const claimable: any[] = [];
  for (const item of items) {
    const claimability = await canCreateClaim(item, disputesByItem.get(item.id) ?? []);
    if (claimability && claimability.allowed) claimable.push(item);
  }
  return claimable;
}

