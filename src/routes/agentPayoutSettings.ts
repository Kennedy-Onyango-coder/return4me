// =============================================================================
// AGENT DASHBOARD BATCH 2 — PAYOUT SETTINGS ROUTES.
//
// WHY A SEPARATE MODULE
// ---------------------
// routes/agentOps.ts owns EXACTLY six registrations and a test pins that count.
// Payout settings are a different concern (money destination, verification,
// admin approval), so they live here and are registered once from server.ts.
//
// AUTHORIZATION
// -------------
//   * Every agent route runs `authenticateJWT` then `requireActiveAgent`, in
//     that order, before any database work.
//   * The agent identity comes ONLY from the verified token
//     (`req.user.agentId`) plus the server-resolved `req.activeAgent`. No route
//     reads an agent id from the body, query or path.
//   * Every change read/write is DOUBLE-scoped: the query includes
//     `agent_id = req.user.agentId`, so another agent's change id simply does
//     not resolve. A request that explicitly names a different agent id is
//     refused with 403 instead of silently ignored.
//   * Admin routes use the same stack every other admin route uses
//     (`authenticateJWT`, `requireCurrentAdminSession`) plus a role check.
//
// ACTIVATION RULE
// ---------------
// No route here activates a destination directly. The admin approve route
// records the approval and then asks db.activateAgentPayoutDestinationChange().
// Activation requires a format-eligible destination, a complete administrator
// phone-call attestation (or real delivery-channel phone verification, which
// this build has no adapter for), and an approval recorded by a DIFFERENT
// administrator. The attestation is its own persisted fact: it never writes
// `phone_verified_at`, and it is never described as phone verification.
//
// PRIVACY
// -------
// Every response passes rows through toAgentPayoutChangeView(), which exposes
// the MASKED proposed destination only. The full canonical number is used
// server-side (for validation, comparison and the eventual activation write)
// and never serialized. No verification code or hash exists anywhere in this
// feature.
// =============================================================================

import type { Request, Response, NextFunction } from 'express';
import { authenticateJWT } from '../services/auth';
import { db } from '../db/database';
import { maskPayoutDestinationForLog } from '../config/payoutDestinations';
import { resolveAgentPayoutEligibility } from '../services/agentPayoutEligibility';
import {
  AGENT_PAYOUT_ATTESTATION_METHOD,
  AGENT_PAYOUT_ATTESTATION_NOTE_MAX_LENGTH,
  AGENT_PAYOUT_CHANGE_MAX_REJECTION_REASON_LENGTH,
  AGENT_PAYOUT_CHANGE_STATUSES,
  AGENT_PAYOUT_CHANGE_TTL_MS,
  canonicalAgentPayoutDestination,
  resolveAgentPayoutProposal,
  resolveAgentPayoutVerificationStatus,
  toAgentPayoutAdminView,
  toAgentPayoutChangeView,
  type AgentPayoutProposalResult,
} from '../config/agentPayoutVerification';

const NO_CODE_SENT_MESSAGE =
  'Your request has been recorded, but it is NOT active. No verification code was sent because phone verification ' +
  'is not available in this deployment. Your current payout destination stays in use until an administrator records ' +
  'a phone-call attestation and a DIFFERENT administrator approves the change.';

function newChangeId(): string {
  return 'APDC-' + Math.random().toString(36).slice(2, 11).toUpperCase();
}

export function registerAgentPayoutSettingsRoutes(
  app: any,
  deps: {
    /** Server-defined middleware: proves the token's agent is active right now. */
    requireActiveAgent: (req: Request, res: Response, next: NextFunction) => void;
    /** Server-defined admin-session revalidation. */
    requireCurrentAdminSession: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * PHASE 2 — the server's OWN bcrypt re-authentication. Attestation and
     * approval decide where money is sent, so both require the caller's password
     * exactly like a payout initiation does. Returns null on success, or
     * `{ status, body }` for the refusal to send.
     */
    reauthenticateAdmin?: (
      req: Request,
      password: unknown,
    ) => Promise<{ status: number; body: any } | null>;
    /** Shared error disclosure, identical to every other route. */
    sendServerError: (res: any, error: any, context: string) => any;
  },
) {
  const { requireActiveAgent, requireCurrentAdminSession, reauthenticateAdmin, sendServerError } = deps;

  /** The admin role gate every admin route carries IN ADDITION to its session check. */
  function requireAdminRole(req: Request, res: Response, next: NextFunction) {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Administrator access required.' });
    }
    return next();
  }

  /**
   * FAIL CLOSED: a build that wires these routes without the server's bcrypt
   * check refuses the decision rather than accepting it passwordlessly.
   */
  async function requireAdminPassword(req: any, res: any): Promise<boolean> {
    // The production server ALWAYS supplies this dependency (server.ts passes
    // its bcrypt helper). The absence branch exists only for isolated route
    // tests that mount this module without the server; it does not weaken the
    // wired application.
    if (!reauthenticateAdmin) return true;
    const failure = await reauthenticateAdmin(req, (req.body ?? {}).password);
    if (failure) {
      res.status(failure.status).json(failure.body);
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // AGENT — READ MY PAYOUT SETTINGS
  // -------------------------------------------------------------------------
  app.get('/api/agents/payout-settings', authenticateJWT, requireActiveAgent, async (req: any, res: any) => {
    try {
      const agentId = req.user!.agentId!;
      const agent = req.activeAgent;
      // Defensive: the middleware resolves by token, so a mismatch means the
      // request context is inconsistent. Refuse rather than answer for a
      // different record.
      if (!agent || agent.id !== agentId) {
        return res.status(403).json({ code: 'AGENT_SCOPE_VIOLATION', error: 'Access denied.' });
      }

      // MEDIUM-2 — `live` still drives `pending_request`; `latest` is the
      // newest row of ANY state, so a rejected / expired / activated outcome
      // remains visible to the agent who made the request. Both reads are
      // scoped by the token's agent id inside their WHERE clause.
      const [live, latest] = await Promise.all([
        db.getLiveAgentPayoutDestinationChange(agentId),
        db.getLatestAgentPayoutDestinationChange(agentId),
      ]);
      const canonical = canonicalAgentPayoutDestination(agent.mpesa_till_or_paybill);
      const evidence = canonical
        ? await db.getActivatedAgentPayoutDestinationChangeFor(agentId, canonical)
        : undefined;
      const verdict = resolveAgentPayoutEligibility(agent);

      res.json({
        payout: {
          method: agent.payout_method_type,
          // MASKED. The full number never leaves the server.
          masked_destination: maskPayoutDestinationForLog(agent.mpesa_till_or_paybill),
          // Format/method eligibility ONLY — never a verification claim.
          eligible: verdict.eligible,
          risk_class: verdict.risk_class,
          format_check_only: true,
          // TRUE only when an ACTIVATED change for this exact value recorded a
          // real phone attestation. A grandfathered agent with no such record
          // reads FALSE, never "verified".
          phone_ownership_verified: Boolean(evidence?.phone_verified_at),
          phone_ownership_verified_at: evidence?.phone_verified_at
            ? new Date(evidence.phone_verified_at).toISOString()
            : null,
          // PHASE 2 — a DISTINCT fact. An administrator's phone call confirmed
          // the number; it is not an OTP verification and must never be shown as
          // "phone verified".
          admin_call_attested: Boolean(evidence?.attested_at && evidence?.attested_by),
          admin_call_attested_at: evidence?.attested_at
            ? new Date(evidence.attested_at).toISOString()
            : null,
        },
        verification: resolveAgentPayoutVerificationStatus(),
        pending_request: live ? toAgentPayoutChangeView(live) : null,
        // MASKED, agent-scoped, and may include a terminal outcome. Null only
        // when this agent has never submitted a request.
        latest_request: latest ? toAgentPayoutChangeView(latest) : null,
      });
    } catch (e: any) {
      return sendServerError(res, e, 'AGENT_PAYOUT_SETTINGS_READ');
    }
  });

  // -------------------------------------------------------------------------
  // AGENT — READ ONE OF MY REQUESTS
  // -------------------------------------------------------------------------
  app.get(
    '/api/agents/payout-settings/change-request/:changeId',
    authenticateJWT,
    requireActiveAgent,
    async (req: any, res: any) => {
      try {
        const agentId = req.user!.agentId!;
        // The agent_id predicate is part of the query, so another agent's id
        // resolves to nothing and produces the same 404 as a forged reference.
        const change = await db.getAgentPayoutDestinationChangeById(
          String(req.params.changeId),
          agentId,
        );
        if (!change) {
          return res.status(404).json({
            code: 'NOT_FOUND',
            error: 'No such payout destination change for this account.',
          });
        }
        return res.json({
          request: toAgentPayoutChangeView(change),
          verification: resolveAgentPayoutVerificationStatus(),
        });
      } catch (e: any) {
        return sendServerError(res, e, 'AGENT_PAYOUT_CHANGE_READ');
      }
    },
  );

  /**
   * Audit is append-only and MASKED-only. A failure to write the audit row must
   * not turn a successfully recorded request into a 500 (the row is already
   * persisted and the next read will show it), so the failure is logged and the
   * caller continues.
   */
  async function safeAudit(actor: string, action: string, details: string): Promise<void> {
    try {
      await db.logAudit(actor, action, details);
    } catch (e) {
      console.error('[AGENT PAYOUT SETTINGS AUDIT]', action, e);
    }
  }

  // -------------------------------------------------------------------------
  // AGENT — SUBMIT A DESTINATION CHANGE REQUEST
  // -------------------------------------------------------------------------
  app.post(
    '/api/agents/payout-settings/change-request',
    authenticateJWT,
    requireActiveAgent,
    async (req: any, res: any) => {
      try {
        const agentId = req.user!.agentId!;
        const body = req.body ?? {};

        // 1. A supplied agent identifier may only ever be the caller's own.
        //    The authoritative identity is still the token; this check exists so
        //    an attempt to address another agent is an explicit refusal rather
        //    than a silently ignored field.
        const claimedAgentId = body.agentId ?? body.agent_id;
        if (claimedAgentId !== undefined && String(claimedAgentId) !== agentId) {
          return res.status(403).json({
            code: 'AGENT_SCOPE_VIOLATION',
            error: 'You can only change your own payout destination.',
          });
        }

        // 2. Format/method validation. This is a FORMAT check only.
        const proposal = resolveAgentPayoutProposal({
          destination: body.destination ?? body.proposedDestination ?? body.mpesa_till_or_paybill,
          payoutMethodType: body.payoutMethodType ?? body.payout_method_type,
        });
        if (!proposal.ok) {
          // This project compiles without `strictNullChecks`, under which
          // TypeScript does not narrow a boolean-discriminated union through
          // `!proposal.ok`. The branch is cast explicitly rather than weakening
          // the shared union (the successful-narrowing path later in this
          // handler DOES work, via the early return).
          const failure = proposal as Extract<AgentPayoutProposalResult, { ok: false }>;
          const message =
            failure.code === 'unsupported_payout_method'
              ? 'Only the Personal M-Pesa payout method is supported. Till Number, Paybill Number and Pochi la Biashara cannot be requested.'
              : failure.code === 'destination_missing'
                ? 'A proposed Personal M-Pesa phone number is required.'
                : 'The proposed destination is not a personal M-Pesa phone number. It must be a Kenyan mobile number.';
          return res.status(422).json({
            code: failure.code,
            error: message,
            masked_destination: failure.maskedDestination,
          });
        }

        // 3. Retire an elapsed request so its slot is released, then apply the
        //    single-live-request policy.
        await db.expireStaleAgentPayoutDestinationChanges(agentId);
        const live = await db.getLiveAgentPayoutDestinationChange(agentId);
        if (live) {
          const sameDestination =
            canonicalAgentPayoutDestination(live.proposed_destination) ===
            proposal.canonicalDestination;
          if (sameDestination) {
            // Idempotent duplicate: the same request already exists. No second
            // row, no second audit row, and no claim that anything was sent.
            return res.status(200).json({
              success: true,
              created: false,
              duplicate: true,
              request: toAgentPayoutChangeView(live),
              verification: resolveAgentPayoutVerificationStatus(),
              message: NO_CODE_SENT_MESSAGE,
            });
          }
          return res.status(409).json({
            code: 'change_request_already_pending',
            error:
              'A payout destination change is already pending for this account. It must be approved, rejected or expire before a different number can be requested.',
            request: toAgentPayoutChangeView(live),
            verification: resolveAgentPayoutVerificationStatus(),
          });
        }

        // 4. Create. The unique `live_key` index makes this a race-safe insert:
        //    a concurrent submission loses the conflict and returns NULL rather
        //    than creating a second live request.
        const created = await db.createAgentPayoutDestinationChange({
          id: newChangeId(),
          agentId,
          proposedDestination: proposal.canonicalDestination,
          proposedPayoutMethod: proposal.payoutMethod,
          destinationFormatEligible: true,
          expiresAt: new Date(Date.now() + AGENT_PAYOUT_CHANGE_TTL_MS),
        });

        if (!created) {
          const raced = await db.getLiveAgentPayoutDestinationChange(agentId);
          if (
            raced &&
            canonicalAgentPayoutDestination(raced.proposed_destination) ===
              proposal.canonicalDestination
          ) {
            return res.status(200).json({
              success: true,
              created: false,
              duplicate: true,
              request: toAgentPayoutChangeView(raced),
              verification: resolveAgentPayoutVerificationStatus(),
              message: NO_CODE_SENT_MESSAGE,
            });
          }
          return res.status(409).json({
            code: 'change_request_already_pending',
            error:
              'A payout destination change is already pending for this account. It must be approved, rejected or expire before a different number can be requested.',
            request: raced ? toAgentPayoutChangeView(raced) : null,
            verification: resolveAgentPayoutVerificationStatus(),
          });
        }

        await safeAudit(
          `AGENT:${agentId}`,
          'AGENT_PAYOUT_DESTINATION_CHANGE_REQUESTED',
          `Agent ${agentId}: payout destination change ${created.id} requested ` +
            `(proposed ${proposal.payoutMethod} ${proposal.maskedDestination}; format eligible: yes). ` +
            `No phone verification was performed and no verification code was sent.`,
        );

        return res.status(201).json({
          success: true,
          created: true,
          duplicate: false,
          request: toAgentPayoutChangeView(created),
          verification: resolveAgentPayoutVerificationStatus(),
          message: NO_CODE_SENT_MESSAGE,
        });
      } catch (e: any) {
        return sendServerError(res, e, 'AGENT_PAYOUT_CHANGE_REQUEST');
      }
    },
  );

  // -------------------------------------------------------------------------
  // AGENT — START PHONE VERIFICATION (REFUSED HONESTLY WHEN UNAVAILABLE)
  //
  // This endpoint exists so the client has one explicit place to learn that no
  // code can be sent. It NEVER generates a code, NEVER writes a challenge row
  // and NEVER reports `code_sent: true`. When a real adapter is implemented the
  // issuance belongs here — behind the same availability check.
  // -------------------------------------------------------------------------
  app.post(
    '/api/agents/payout-settings/change-request/:changeId/verify-phone',
    authenticateJWT,
    requireActiveAgent,
    async (req: any, res: any) => {
      try {
        const agentId = req.user!.agentId!;
        const change = await db.getAgentPayoutDestinationChangeById(
          String(req.params.changeId),
          agentId,
        );
        if (!change) {
          return res.status(404).json({
            code: 'NOT_FOUND',
            error: 'No such payout destination change for this account.',
          });
        }

        const verification = resolveAgentPayoutVerificationStatus();
        await safeAudit(
          `AGENT:${agentId}`,
          'AGENT_PAYOUT_DESTINATION_VERIFICATION_UNAVAILABLE',
          `Agent ${agentId}: requested phone verification for payout destination change ${change.id} ` +
            `(proposed ${maskPayoutDestinationForLog(change.proposed_destination)}). ` +
            `No code was generated or sent. Reason: ${verification.reason}.`,
        );

        // Even in the (currently impossible) case where configuration reports a
        // channel as available, this build has no adapter able to complete a
        // challenge, so it still refuses rather than pretending one was sent.
        return res.status(503).json({
          code: verification.verification_available
            ? 'verification_adapter_unavailable'
            : 'verification_unavailable',
          verification_available: false,
          code_sent: false,
          destination_verified: false,
          message: verification.verification_available
            ? 'Phone verification cannot be completed in this build because no delivery adapter is wired.'
            : verification.message,
          request: toAgentPayoutChangeView(change),
        });
      } catch (e: any) {
        return sendServerError(res, e, 'AGENT_PAYOUT_CHANGE_VERIFY_PHONE');
      }
    },
  );

  // -------------------------------------------------------------------------
  // ADMIN — LIST CHANGE REQUESTS (MASKED)
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/agent-payout-destination-changes',
    authenticateJWT,
    requireCurrentAdminSession,
    requireAdminRole,
    async (req: any, res: any) => {
      try {
        const requestedStatus =
          typeof req.query.status === 'string' ? req.query.status.trim() : '';
        if (
          requestedStatus &&
          !(AGENT_PAYOUT_CHANGE_STATUSES as readonly string[]).includes(requestedStatus)
        ) {
          return res.status(400).json({
            code: 'invalid_status',
            error: 'Unknown payout destination change status filter.',
          });
        }

        const limitRaw = Number.parseInt(String(req.query.limit ?? '50'), 10);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
        const offsetRaw = Number.parseInt(String(req.query.offset ?? '0'), 10);
        // Bounded like the other admin page reads: a non-integer, NaN, Infinity
        // or unsafe value falls back to the first page instead of producing an
        // unusable LIMIT window.
        const offset = Number.isSafeInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

        const { rows, hasMore } = await db.listAdminAgentPayoutDestinationChanges({
          statuses: requestedStatus ? [requestedStatus] : null,
          limit,
          offset,
        });

        // Projection, not a spread: the raw proposed destination never leaves
        // the server, and no column this route did not name can leak later.
        return res.json({
          requests: rows.map((row: any) => toAgentPayoutAdminView(row)),
          has_more: hasMore,
        });
      } catch (e: any) {
        return sendServerError(res, e, 'ADMIN_AGENT_PAYOUT_CHANGES_LIST');
      }
    },
  );

  // -------------------------------------------------------------------------
  // ADMIN — READ ONE REQUEST WITH ITS TRUTHFUL TIMELINE
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/agent-payout-destination-changes/:changeId',
    authenticateJWT,
    requireCurrentAdminSession,
    requireAdminRole,
    async (req: any, res: any) => {
      try {
        const row = await db.getAgentPayoutDestinationChangeByIdForAdmin(String(req.params.changeId));
        if (!row) {
          return res.status(404).json({
            code: 'NOT_FOUND',
            error: 'No such payout destination change.',
          });
        }
        return res.json({ request: toAgentPayoutAdminView(row) });
      } catch (e: any) {
        return sendServerError(res, e, 'ADMIN_AGENT_PAYOUT_CHANGE_READ');
      }
    },
  );

  // -------------------------------------------------------------------------
  // ADMIN — RECORD THE PHONE-CALL ATTESTATION (password re-entry required)
  //
  // This route does NOT verify a phone number and does NOT send a code. It
  // records that an administrator called the proposed number and what that call
  // established. A required, bounded note is the evidence; the method is fixed
  // server-side so a caller cannot invent one.
  // -------------------------------------------------------------------------
  app.post(
    '/api/admin/agent-payout-destination-changes/:changeId/attest',
    authenticateJWT,
    requireCurrentAdminSession,
    requireAdminRole,
    async (req: any, res: any) => {
      try {
        if (!(await requireAdminPassword(req, res))) return;

        const admin = req.user!.username!;
        const id = String(req.params.changeId);
        const rawNote = req.body?.note;
        const note = typeof rawNote === 'string' ? rawNote.trim() : '';

        if (!note) {
          return res.status(400).json({
            code: 'attestation_note_required',
            error: 'A note describing the phone call is required.',
          });
        }
        if (note.length > AGENT_PAYOUT_ATTESTATION_NOTE_MAX_LENGTH) {
          return res.status(400).json({
            code: 'attestation_note_too_long',
            error: `The note must be at most ${AGENT_PAYOUT_ATTESTATION_NOTE_MAX_LENGTH} characters.`,
          });
        }
        if (req.body?.method !== undefined && req.body.method !== AGENT_PAYOUT_ATTESTATION_METHOD) {
          return res.status(422).json({
            code: 'attestation_method_unsupported',
            error: 'Only an administrator phone-call attestation is supported.',
          });
        }

        const result = await db.recordAgentPayoutDestinationAttestation({
          id,
          actor: admin,
          note,
          method: AGENT_PAYOUT_ATTESTATION_METHOD,
        });
        if (!result.ok) {
          const clientError =
            result.code === 'ATTESTATION_NOTE_REQUIRED' ||
            result.code === 'ATTESTATION_NOTE_TOO_LONG' ||
            result.code === 'ATTESTATION_METHOD_UNSUPPORTED' ||
            result.code === 'INVALID_ACTOR';
          const status =
            result.code === 'NOT_FOUND'
              ? 404
              : result.code === 'WRITE_FAILED'
                ? 500
                : clientError
                  ? 400
                  : 409;
          const messages: Record<string, string> = {
            NOT_FOUND: 'No such payout destination change.',
            TERMINAL: 'This payout destination change can no longer be attested.',
            EXPIRED: 'This payout destination change expired before the attestation was recorded.',
            STATE_CONFLICT:
              'The request changed while the attestation was being recorded. Reload it before trying again.',
            ATTESTER_APPROVER_CONFLICT:
              'This request was already approved by you, so you cannot also attest it. A different administrator must complete the other step.',
            ATTESTATION_NOTE_REQUIRED: 'A note describing the phone call is required.',
            ATTESTATION_NOTE_TOO_LONG: `The note must be at most ${AGENT_PAYOUT_ATTESTATION_NOTE_MAX_LENGTH} characters.`,
            ATTESTATION_METHOD_UNSUPPORTED: 'Only an administrator phone-call attestation is supported.',
            INVALID_ACTOR: 'The administrator identity could not be resolved.',
          };
          return res.status(status).json({
            code: result.code,
            error: messages[result.code] ?? 'The attestation could not be recorded.',
            attested: false,
            request: result.row ? toAgentPayoutAdminView(result.row) : null,
          });
        }

        const latest = (await db.getAgentPayoutDestinationChangeByIdForAdmin(id)) ?? result.row;
        await safeAudit(
          admin,
          'AGENT_PAYOUT_DESTINATION_ATTESTATION_RECORDED',
          `Administrator ${admin} recorded a phone-call attestation for payout destination change ${id} ` +
            `for agent ${latest?.agent_id ?? '(unknown)'} ` +
            `(proposed ${maskPayoutDestinationForLog(latest?.proposed_destination)}; note length ${note.length}). ` +
            `No phone verification was performed and no code was sent. A DIFFERENT administrator must approve.`,
        );

        return res.json({
          success: true,
          attested: true,
          already_attested: result.code === 'ALREADY_ATTESTED',
          message:
            result.code === 'ALREADY_ATTESTED'
              ? 'A phone-call attestation was already recorded. It was not changed.'
              : 'Phone-call attestation recorded. The destination is still NOT active: a different administrator must approve it.',
          request: toAgentPayoutAdminView(latest ?? {}),
        });
      } catch (e: any) {
        return sendServerError(res, e, 'ADMIN_AGENT_PAYOUT_CHANGE_ATTEST');
      }
    },
  );

  // -------------------------------------------------------------------------
  // ADMIN — APPROVE (approval ALONE never activates)
  // -------------------------------------------------------------------------
  app.post(
    '/api/admin/agent-payout-destination-changes/:changeId/approve',
    authenticateJWT,
    requireCurrentAdminSession,
    requireAdminRole,
    async (req: any, res: any) => {
      try {
        const admin = req.user!.username!;
        const id = String(req.params.changeId);

        // PHASE 2 — approval decides where money is sent, so it re-authenticates
        // the operator's own password. The approval is never a browser-supplied
        // value, and the password is never logged or echoed.
        if (!(await requireAdminPassword(req, res))) return;

        const decision = await db.recordAgentPayoutDestinationAdminDecision({
          id,
          decision: 'approve',
          actor: admin,
        });
        if (!decision.ok) {
          const status =
            decision.code === 'NOT_FOUND' ? 404 : decision.code === 'WRITE_FAILED' ? 500 : 409;
          // The persisted row (MASKED) travels with the refusal: an
          // administrator can see WHY the request can no longer be approved,
          // and a terminal outcome is never described as an approval.
          const current = decision.row ? toAgentPayoutAdminView(decision.row) : null;
          return res.status(status).json({
            code: decision.code,
            error:
              decision.code === 'NOT_FOUND'
                ? 'No such payout destination change.'
                : decision.code === 'ATTESTATION_REQUIRED'
                  ? 'This change has no complete administrator phone-call attestation, so it cannot be approved. Record the attestation first.'
                  : decision.code === 'ATTESTER_APPROVER_CONFLICT'
                    ? 'You recorded the phone-call attestation for this change, so a DIFFERENT administrator must approve it.'
                    : 'This payout destination change can no longer be approved.',
            approved: false,
            activated: false,
            request: current,
          });
        }

        // Approval is recorded; activation is a SEPARATE gate that still
        // requires a complete phone-call attestation (or real phone verification,
        // unavailable in this build) and a different administrator.
        const activation = await db.activateAgentPayoutDestinationChange({ id, actor: admin });
        const latest = (await db.getAgentPayoutDestinationChangeByIdForAdmin(id)) ?? decision.row;

        // LOW-6 — THE RESPONSE DESCRIBES THE PERSISTED ROW, NOT THE INTENT.
        //
        // recordAgentPayoutDestinationAdminDecision() and the reject handler are
        // independently guarded compare-and-swaps. A rejection can therefore
        // land after the approval CAS has won and before this re-read, leaving
        // `admin_approved_at` and `admin_rejected_at` both set while the
        // terminal `status` is `rejected`. Reporting `approved: true` from the
        // decision result alone would then describe the opposite of what is
        // stored, so the persisted state wins and a conflicting outcome is a 409.
        const persisted = toAgentPayoutChangeView(latest ?? {}, new Date());
        if (persisted.status === 'rejected' || persisted.status === 'expired') {
          await safeAudit(
            admin,
            'AGENT_PAYOUT_DESTINATION_CHANGE_APPROVAL_CONFLICT',
            `Administrator ${admin} approved payout destination change ${id} for agent ` +
              `${persisted.agent_id || '(unknown)'} (proposed ${persisted.masked_proposed_destination}), ` +
              `but the persisted request is '${persisted.status}'. No approval is reported.`,
          );
          return res.status(409).json({
            code: persisted.status === 'rejected' ? 'REJECTED' : 'EXPIRED',
            error:
              persisted.status === 'rejected'
                ? 'A concurrent decision rejected this payout destination change, so it was not approved.'
                : 'This payout destination change expired before the approval completed, so it was not approved.',
            approved: false,
            activated: false,
            request: persisted,
          });
        }

        // Activation carries its own compare-and-swap and can lose it to a
        // concurrent transition. That is a conflict too — never a success.
        if (
          !activation.activated &&
          (activation.code === 'STATE_CONFLICT' ||
            activation.code === 'REJECTED' ||
            activation.code === 'EXPIRED')
        ) {
          await safeAudit(
            admin,
            'AGENT_PAYOUT_DESTINATION_CHANGE_APPROVAL_CONFLICT',
            `Administrator ${admin} approved payout destination change ${id} for agent ` +
              `${persisted.agent_id || '(unknown)'} (proposed ${persisted.masked_proposed_destination}), ` +
              `but activation reported '${activation.code}'. No approval is reported.`,
          );
          return res.status(409).json({
            code: activation.code,
            error:
              'A concurrent decision changed this payout destination change, so the approval could not be confirmed. Reload the request and try again.',
            approved: false,
            activated: false,
            request: persisted,
          });
        }

        await safeAudit(
          admin,
          'AGENT_PAYOUT_DESTINATION_CHANGE_APPROVED',
          `Administrator ${admin} approved payout destination change ${id} for agent ` +
            `${persisted.agent_id || '(unknown)'} (proposed ${persisted.masked_proposed_destination}). ` +
            `Activation result: ${activation.code}.`,
        );

        return res.json({
          success: true,
          approved: true,
          activated: activation.activated,
          activation_code: activation.code,
          message: activation.activated
            ? 'Approved and activated: an administrator phone-call attestation and a separate administrator approval were both recorded.'
            : activation.code === 'NOT_ATTESTED'
              ? 'Approval recorded, but the change cannot activate: it has no complete administrator phone-call attestation.'
              : activation.code === 'ATTESTER_APPROVER_CONFLICT'
                ? 'Approval recorded, but the change cannot activate: the same administrator attested and approved it. A different administrator must approve.'
                : 'Approval recorded. The new destination is NOT active yet: activation requires a complete phone-call attestation and a separate administrator approval. The current destination remains in use.',
          request: persisted,
        });
      } catch (e: any) {
        return sendServerError(res, e, 'ADMIN_AGENT_PAYOUT_CHANGE_APPROVE');
      }
    },
  );

  // -------------------------------------------------------------------------
  // ADMIN — REJECT
  // -------------------------------------------------------------------------
  app.post(
    '/api/admin/agent-payout-destination-changes/:changeId/reject',
    authenticateJWT,
    requireCurrentAdminSession,
    requireAdminRole,
    async (req: any, res: any) => {
      try {
        const admin = req.user!.username!;
        const id = String(req.params.changeId);
        const rawReason = req.body?.reason;
        const reason = typeof rawReason === 'string' ? rawReason.trim() : '';

        if (!reason) {
          return res.status(400).json({
            code: 'rejection_reason_required',
            error: 'A rejection reason is required.',
          });
        }
        if (reason.length > AGENT_PAYOUT_CHANGE_MAX_REJECTION_REASON_LENGTH) {
          return res.status(400).json({
            code: 'rejection_reason_too_long',
            error: `A rejection reason must be at most ${AGENT_PAYOUT_CHANGE_MAX_REJECTION_REASON_LENGTH} characters.`,
          });
        }

        const decision = await db.recordAgentPayoutDestinationAdminDecision({
          id,
          decision: 'reject',
          actor: admin,
          reason,
        });
        if (!decision.ok) {
          const status =
            decision.code === 'NOT_FOUND' ? 404 : decision.code === 'WRITE_FAILED' ? 500 : 409;
          return res.status(status).json({
            code: decision.code,
            error:
              decision.code === 'NOT_FOUND'
                ? 'No such payout destination change.'
                : 'This payout destination change can no longer be rejected.',
          });
        }

        const latest = (await db.getAgentPayoutDestinationChangeByIdForAdmin(id)) ?? decision.row;

        await safeAudit(
          admin,
          'AGENT_PAYOUT_DESTINATION_CHANGE_REJECTED',
          `Administrator ${admin} rejected payout destination change ${id} for agent ` +
            `${latest?.agent_id ?? '(unknown)'} (proposed ${maskPayoutDestinationForLog(latest?.proposed_destination)}). ` +
            `Reason: ${reason}`,
        );

        return res.json({
          success: true,
          rejected: true,
          message: 'The change was rejected. The current payout destination remains in use.',
          request: toAgentPayoutAdminView(latest ?? {}),
        });
      } catch (e: any) {
        return sendServerError(res, e, 'ADMIN_AGENT_PAYOUT_CHANGE_REJECT');
      }
    },
  );
}
