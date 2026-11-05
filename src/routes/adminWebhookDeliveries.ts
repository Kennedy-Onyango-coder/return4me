// ADMIN WEBHOOK-DELIVERY READ (Gate C / Stage C2)
// ===============================================
//   GET /api/admin/webhook-deliveries — a bounded, read-only page of delivery
//                                      records (with the derived session
//                                      resolution for each row)
//
// WHY THIS MODULE EXISTS
// Every provider callback the application has ever answered was, until now,
// invisible: a refused delivery (a wrong challenge, a validation refusal, a
// permanent reconciliation refusal) produced an HTTP response and nothing else.
// The only durable trace of a collection arriving was the money it caused, so
// "IntaSend says it called us six times" could not be checked against anything.
// This module is that missing read: one page of deliveries, filterable by
// status, category, claim, session, invoice and arrival window.
//
// READ-ONLY BY CONSTRUCTION.
// There is deliberately NO mutation endpoint here: no "retry this delivery", no
// "mark resolved", no "replay". A delivery record is evidence of what happened,
// and evidence an administrator can edit is not evidence. Retrying a callback is
// IntaSend's decision, and reconciling a payment is the job of the two existing
// recovery paths (the 60-second sweep and the on-demand status route), never of
// an admin console button.
//
// WHAT AN ADMIN SEES, AND WHAT IS WITHHELD
// Only the columns in AdminWebhookDeliveryRow plus a DERIVED `sessionResolution`
// and an INCOMPLETE flag. Never the request body: the fingerprint is a sha256
// over the observable identity fields, and the raw payload (which carries the
// payer's phone number) is not stored at all, so there is nothing here to leak.
//
// AUTHORIZATION MODEL (identical to every comparable sensitive admin read)
//   authenticateJWT            -> signature + expiry (mounted by this module)
//   requireCurrentAdminSession -> live admin account, injected from server.ts
//   permissionGuard            -> payments.webhook_read
//   inline role check          -> req.user?.role !== 'admin' -> 403
//
// The permission is a NAMED grant resolved from the authenticated identity (see
// services/adminPermissions.ts); the inline role check stays because
// authenticateJWT does not check role, so without it an `admin_pending_2fa`
// token would reach this route. src/__tests__/adminRouteAudit.test.ts asserts
// both.
import type { Express } from 'express';
import { db } from '../db/database.ts';
import {
  WEBHOOK_DELIVERY_EVENT_CATEGORIES,
  WEBHOOK_DELIVERY_PAGE_DEFAULT,
  WEBHOOK_DELIVERY_PAGE_MAX,
  WEBHOOK_DELIVERY_STATUSES,
  isOpenWebhookDeliveryStatus,
  isWebhookDeliveryStatus,
} from '../config/webhookDeliveries.ts';
import { authenticateJWT } from '../services/auth.ts';
import { ADMIN_PERMISSIONS, requireAdminPermission } from '../services/adminPermissions.ts';

type Parsed<T> = { value: T; error: string | null };

/**
 * A single, non-repeated string parameter. `undefined` means "not supplied" (so
 * the caller can apply a default); an array means the parameter was repeated,
 * which is ambiguous input and is always an error.
 */
function singleString(raw: unknown): Parsed<string | undefined> {
  if (raw === undefined) return { value: undefined, error: null };
  if (typeof raw !== 'string') return { value: undefined, error: 'Duplicate or malformed parameter.' };
  return { value: raw, error: null };
}

/** A non-negative integer, accepted only as plain digits. */
function boundedInt(raw: unknown, min: number, max: number, fallback: number): Parsed<number> {
  const s = singleString(raw);
  if (s.error) return { value: fallback, error: s.error };
  if (s.value === undefined) return { value: fallback, error: null };
  if (!/^\d+$/.test(s.value)) return { value: fallback, error: 'Value must be a whole number.' };
  const n = Number(s.value);
  if (!Number.isSafeInteger(n)) return { value: fallback, error: 'Numeric value is too large.' };
  if (n < min || n > max) return { value: fallback, error: `Value must be between ${min} and ${max}.` };
  return { value: n, error: null };
}

/**
 * Repository identifiers are varchar keys; the accepted charset allows the
 * characters a legitimate id can contain and refuses the ones that make
 * injection or path-shaped payloads interesting.
 */
function repositoryId(raw: unknown, field: string, maxLength: number): Parsed<string | undefined> {
  const s = singleString(raw);
  if (s.error) return { value: undefined, error: s.error };
  if (s.value === undefined) return { value: undefined, error: null };
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(s.value) || s.value.length > maxLength) {
    return { value: undefined, error: `Malformed identifier (${field}).` };
  }
  return { value: s.value, error: null };
}

/** Date string that must actually parse. */
function parsedDate(raw: unknown, field: string): Parsed<Date | undefined> {
  const s = singleString(raw);
  if (s.error) return { value: undefined, error: s.error };
  if (s.value === undefined) return { value: undefined, error: null };
  const d = new Date(s.value);
  if (isNaN(d.getTime())) return { value: undefined, error: `Malformed date (${field}).` };
  return { value: d, error: null };
}

/**
 * A repeated `status` parameter (or several of them) restricted to the CLOSED
 * delivery-status vocabulary.
 *
 * An unrecognised value is a 400, not an empty page: silently widening or
 * emptying a filter is how an operator concludes "no refusals happened" when in
 * fact they misspelled one. `?status=` with no value is malformed for the same
 * reason.
 */
function statusList(raw: unknown): Parsed<string[] | undefined> {
  if (raw === undefined) return { value: undefined, error: null };
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length > WEBHOOK_DELIVERY_STATUSES.length) {
    return { value: undefined, error: 'Too many status values.' };
  }
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') {
      return { value: undefined, error: 'Malformed status parameter.' };
    }
    const status = value.trim();
    if (!isWebhookDeliveryStatus(status)) {
      return { value: undefined, error: 'Unknown delivery status.' };
    }
    if (!out.includes(status)) out.push(status);
  }
  return { value: out, error: null };
}

/** Event category, restricted to the closed vocabulary. */
function eventCategory(raw: unknown): Parsed<string | undefined> {
  const s = singleString(raw);
  if (s.error) return { value: undefined, error: s.error };
  if (s.value === undefined) return { value: undefined, error: null };
  const category = s.value.trim();
  if (!(WEBHOOK_DELIVERY_EVENT_CATEGORIES as readonly string[]).includes(category)) {
    return { value: undefined, error: 'Unknown event category.' };
  }
  return { value: category, error: null };
}

/**
 * The exact row shape an administrator receives.
 *
 * Deliberately an ALLOWLIST: a column added to the table later cannot leak here
 * by default, and the derived fields sit beside the stored ones so a console
 * never has to re-derive them.
 */
export interface AdminWebhookDeliveryView {
  id: string;
  provider: string;
  eventTopic: string | null;
  eventCategory: string;
  /** true / false / null (null = no challenge configured, nothing checked). */
  authenticated: boolean | null;
  status: string;
  outcomeCode: string | null;
  retryable: boolean | null;
  httpStatus: number | null;
  claimId: string | null;
  paymentSessionId: string | null;
  providerInvoiceId: string | null;
  providerReference: string | null;
  payloadFingerprint: string | null;
  diagnostic: string | null;
  receivedAt: string;
  processedAt: string | null;
  /**
   * TRUE means the delivery never reached a terminal status — the request did
   * not finish (the process died, the write failed, it is still running). Such a
   * row is INCOMPLETE, never a success.
   */
  incomplete: boolean;
  /** Derived at read time; never stored. See WEBHOOK_SESSION_RESOLUTIONS. */
  sessionResolution: string;
}

/** Maps a stored row to the admin view. Pure; no I/O. */
export function toAdminWebhookDeliveryView(row: any): AdminWebhookDeliveryView {
  const status = String(row?.status ?? '');
  return {
    id: String(row?.id ?? ''),
    provider: String(row?.provider ?? ''),
    eventTopic: row?.event_topic ?? null,
    eventCategory: String(row?.event_category ?? ''),
    authenticated: row?.authenticated === null || row?.authenticated === undefined
      ? null
      : row.authenticated === true,
    status,
    outcomeCode: row?.outcome_code ?? null,
    retryable: row?.retryable === null || row?.retryable === undefined ? null : row.retryable === true,
    httpStatus: typeof row?.http_status === 'number' ? row.http_status : null,
    claimId: row?.claim_id ?? null,
    paymentSessionId: row?.payment_session_id ?? null,
    providerInvoiceId: row?.provider_invoice_id ?? null,
    providerReference: row?.provider_reference ?? null,
    payloadFingerprint: row?.payload_fingerprint ?? null,
    diagnostic: row?.diagnostic ?? null,
    receivedAt: String(row?.received_at ?? ''),
    processedAt: row?.processed_at ?? null,
    incomplete: row?.is_open === undefined ? isOpenWebhookDeliveryStatus(status) : row.is_open === true,
    sessionResolution: String(row?.session_resolution ?? 'no_payment_session'),
  };
}

export interface RegisterAdminWebhookDeliveryRoutesDeps {
  requireCurrentAdminSession: (req: any, res: any, next: any) => any;
  sendServerError: (res: any, error: any, code: string) => any;
  /**
   * Injected in tests so a route can be exercised with the REAL guard chain
   * without importing the grant table; server.ts leaves it undefined and the
   * production requireAdminPermission is used.
   */
  requireAdminPermission?: (permission: string) => (req: any, res: any, next: any) => void;
}

/**
 * Registers the read-only delivery list.
 *
 * RESPONSE
 *   { success: true, data: AdminWebhookDeliveryView[], pagination: { limit, offset, hasMore } }
 *
 * ERROR CODES
 *   400  a malformed or out-of-vocabulary parameter (never silently ignored)
 *   403  not an administrator / permission not held
 *   500  sendServerError('ADMIN_WEBHOOK_DELIVERIES_ERROR')
 *
 * Nothing here reads or writes money, and nothing here changes a delivery: the
 * handler performs exactly one read.
 */
export function registerAdminWebhookDeliveryRoutes(
  app: Express,
  deps: RegisterAdminWebhookDeliveryRoutesDeps,
) {
  const { requireCurrentAdminSession, sendServerError } = deps;
  const permissionGuard = deps.requireAdminPermission ?? requireAdminPermission;

  app.get(
    '/api/admin/webhook-deliveries',
    authenticateJWT,
    requireCurrentAdminSession,
    permissionGuard(ADMIN_PERMISSIONS.PAYMENTS_WEBHOOK_READ),
    async (req, res) => {
      try {
        if (req.user?.role !== 'admin') {
          return res.status(403).json({ error: 'Access denied.' });
        }

        const q = (req.query ?? {}) as Record<string, unknown>;

        const limit = boundedInt(q.limit, 1, WEBHOOK_DELIVERY_PAGE_MAX, WEBHOOK_DELIVERY_PAGE_DEFAULT);
        if (limit.error) return res.status(400).json({ error: limit.error });

        const offset = boundedInt(q.offset, 0, Number.MAX_SAFE_INTEGER, 0);
        if (offset.error) return res.status(400).json({ error: offset.error });

        const statuses = statusList(q.status);
        if (statuses.error) return res.status(400).json({ error: statuses.error });

        const category = eventCategory(q.eventCategory);
        if (category.error) return res.status(400).json({ error: category.error });

        const claimId = repositoryId(q.claimId, 'claimId', 50);
        if (claimId.error) return res.status(400).json({ error: claimId.error });

        const paymentSessionId = repositoryId(q.paymentSessionId, 'paymentSessionId', 64);
        if (paymentSessionId.error) return res.status(400).json({ error: paymentSessionId.error });

        const providerInvoiceId = repositoryId(q.providerInvoiceId, 'providerInvoiceId', 100);
        if (providerInvoiceId.error) return res.status(400).json({ error: providerInvoiceId.error });

        const receivedFrom = parsedDate(q.receivedFrom, 'receivedFrom');
        if (receivedFrom.error) return res.status(400).json({ error: receivedFrom.error });

        const receivedTo = parsedDate(q.receivedTo, 'receivedTo');
        if (receivedTo.error) return res.status(400).json({ error: receivedTo.error });

        // Query parameters outside this contract are ignored, exactly as every
        // other list route in this repository does, and are never forwarded into
        // the query builder.

        const { rows, hasMore } = await db.listAdminWebhookDeliveries({
          limit: limit.value,
          offset: offset.value,
          statuses: statuses.value,
          eventCategory: category.value,
          claimId: claimId.value,
          paymentSessionId: paymentSessionId.value,
          providerInvoiceId: providerInvoiceId.value,
          receivedFrom: receivedFrom.value,
          receivedTo: receivedTo.value,
        });

        return res.json({
          success: true,
          data: rows.map((row) => toAdminWebhookDeliveryView(row)),
          pagination: { limit: limit.value, offset: offset.value, hasMore },
        });
      } catch (e: any) {
        return sendServerError(res, e, 'ADMIN_WEBHOOK_DELIVERIES_ERROR');
      }
    },
  );
}
