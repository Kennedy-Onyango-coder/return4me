import React, { useState, useEffect, useRef } from 'react';
import { translations } from '../types';
import VerificationForm from './VerificationForm';
import { trapModalFocus } from '../utils/modalFocus';
import { Search, AlertCircle, ShieldAlert, CheckCircle, Smartphone, ArrowRight, Loader2, Coins, MapPin, Lock, Eye, Clock, X, XCircle, AlertTriangle, RefreshCw } from 'lucide-react';
// The "Track My Claim" status badge previously always rendered in the same
// green/success color and the same raw snake_case string for every status,
// including 'disputed', 'rejected', 'refunding', and 'refunded' — an owner
// whose claim was rejected or who lost a dispute (even one who'd already
// been refunded) saw the exact same green "SUCCESS-LOOKING" badge as
// someone whose item was ready for pickup. The mapping now lives in a shared
// module so the customer dashboard renders status identically instead of
// keeping a second copy in sync.
import { getClaimStatusDisplay } from './claimStatus';
import Stepper from './ui/Stepper';
import Button from './ui/Button';
// PHASE 16.1 (GEO-16-01): the ONE canonical 47-county dataset, imported — never
// re-typed here. The same source the Finder and the lost-report wizard use.
import { countiesByUxGroup } from '../config/kenyaCounties';
import { administrativeUnitsForCounty, resolveAdministrativeUnitId } from '../config/kenyaAdministrativeUnits';
// E2-A: the two payment clocks are imported, never re-typed. CLAIM_PAYMENT_WINDOW_MS
// drives the countdown below (the window the SERVER enforces), and the two labels
// let the copy name each window by the number that actually governs it.
import {
  CLAIM_PAYMENT_WINDOW_MS,
  CLAIM_PAYMENT_WINDOW_LABEL,
  PAYMENT_SESSION_WINDOW_LABEL,
} from '../config/paymentWindows';

/** The 47 canonical counties, grouped for display. Static data — read once. */
const COUNTY_GROUPS = countiesByUxGroup();

// PHASE 8.2 — CLAIM PROGRESS MODEL (presentation only)
// ====================================================
// The claim journey previously gave the claimant no indication of where they
// were or what happened next: each step was its own isolated screen. This maps
// the EXISTING `verificationStep` state onto five user-facing stages and feeds
// the shared Stepper primitive (which already existed but was unused).
//
// It is pure presentation: no lifecycle value, status vocabulary, API contract,
// verification rule or payment behaviour is involved, and an unknown state
// simply renders as the first stage.
const CLAIM_STEPS: { en: string }[] = [
  { en: 'Confirm' },
  { en: 'Verify' },
  { en: 'Visit hub' },
  { en: 'Pay' },
  { en: 'Collect' },
];

const CLAIM_STEP_INDEX: Record<string, number> = {
  confidence_gate: 0,
  tier1_security: 1,
  tier2_otp: 1,
  tier3_id: 1,
  awaiting_agent_confirmation: 2,
  payment: 3,
  payment_polling: 3,
  handover_success: 4,
};

/**
 * UX-09 — the guided claim / recovery journey.
 *
 * A progress rail is not guidance. The rail tells the claimant WHICH stage they
 * are on; each of the five screens underneath it still has to answer the two
 * questions a claimant stranded mid-journey actually asks — "what happens now?"
 * and "who moves next?". This table carries that answer per stage, in both
 * languages, keyed by the SAME stage index the rail reads, so the rail and the
 * guide can never disagree about which stage the claimant is on.
 *
 * It is guidance copy ONLY. It carries no lifecycle value, no status
 * vocabulary, no price, no promise about outcome, no timer, and no agent or
 * item field — every number and identifier on those screens still comes from
 * the server DTO. Rewording an entry here cannot change what the server is
 * asked to do.
 *
 * Copy convention (the same one the rest of this file already used): copy that
 * exists as a matrix — every stage, both languages — lives in a typed bilingual
 * table like this one and like CLAIM_STEPS; a one-off string stays an inline
 * `lang === 'en' ? … : …` ternary. No new i18n mechanism and no new translation
 * key were introduced by UX-09.
 */
const CLAIM_STAGE_GUIDE: {
  title: { en: string };
  what: { en: string };
  actor: { en: string };
}[] = [
  {
    title: { en: 'Confirm the item is yours' },
    what: {
      en: 'Check the photo and description, confirm the phone number we should verify, then accept the terms.',
    },
    actor: { en: 'You' },
  },
  {
    title: { en: 'Prove ownership' },
    what: {
      en: 'Answer the security questions, then enter the code we send to your verified email address.',
    },
    actor: { en: 'You' },
  },
  {
    title: { en: 'Visit the hub and inspect the item' },
    what: {
      en: 'Go to the confirmed hub shown below, inspect the item in person, and let the agent confirm you have seen it.',
    },
    actor: { en: 'You and the agent' },
  },
  {
    title: { en: 'Pay the collection fee' },
    what: {
      en: 'Send the M-Pesa prompt to the number below and complete it on your phone with your PIN.',
    },
    actor: { en: 'You, on M-Pesa' },
  },
  {
    title: { en: 'Collect your item' },
    what: {
      en: 'Show the agent your secret pickup code, collect your item, then rate the agent.',
    },
    actor: { en: 'You and the agent' },
  },
];

interface OwnerViewProps {
  categories: any[];
  categoriesLoading?: boolean;
  categoriesError?: boolean;
  /** Phase 7B: opens the public item-detail route (/item/:id) from a search
   *  result. Search, filters and the existing claim button are unchanged. */
  onOpenItem?: (itemId: string) => void;
  /** Phase 7B: an item handed in from the public /item/:id page via "It's
   *  Mine" (after authentication). When present, this view opens directly on
   *  the ownership-confidence step for that item instead of the search list. */
  initialClaimItem?: any | null;
  /**
   * PHASE 11A — opens the lost-REPORTING entry point (/report-lost).
   *
   * Before this, the public "I Lost Something" journey led here, to a screen
   * that only helps someone whose item has ALREADY been found, and the actual
   * report-a-loss experience was reachable only inside the account dashboard.
   * This view now states both situations explicitly and hands the reporting one
   * to that dedicated page rather than trying to host a second form itself.
   */
  onReportLost?: () => void;
  /**
   * PHASE 16 — Track My Claim authentication boundary.
   *
   * True when a live CUSTOMER session exists, as already resolved by App from
   * the SAME GET /api/customer/me every other customer surface uses. Tracking a
   * claim is now a customer-authenticated action, so this view must not offer an
   * anonymous lookup form: the server enforces the boundary too
   * (requireCustomerAuth on POST /api/claims/lookup), and this flag is what lets
   * the UI send a signed-out visitor through the EXISTING /account boundary
   * instead of into a form that would be rejected.
   *
   * It introduces no session mechanism of its own — this component never reads
   * a cookie, a token or storage.
   */
  isSignedIn?: boolean;
  /**
   * PHASE 16 — hands an unauthenticated visitor to the existing /account
   * authentication boundary, remembering `?track=1` so they land back HERE with
   * Track My Claim open. App owns the navigation and the validated return path.
   */
  onRequireTrackSignIn?: () => void;
  /**
   * PHASE 16 — set when the visitor arrived (or was returned) with the
   * `?track=1` intent, i.e. they asked to track a claim and have now
   * authenticated. Opens the existing Track My Claim modal once.
   */
  trackIntent?: boolean;
}

// Mirrors the backend's canonical Kenyan phone normalization (toE164Kenyan in
// services/auth.ts) and its /^\+254\d{9}$/ validity check (server.ts). Kept as
// a local, pure copy here so the browser bundle does not pull in backend
// DB/PSP dependencies, while staying byte-for-byte consistent with the server
// so the client can never enable the STK button for a number the backend would
// reject. Accepts the standard formats the rest of the payment flow accepts:
// 0712345678, 0112345678, 254712345678, +254712345678 (internal spaces ok).
function normalizeKenyanPhoneForPayer(raw: string): string {
  let clean = (raw || '').replace(/\s+/g, '');
  if (clean.startsWith('07') && clean.length === 10) return '+254' + clean.slice(1);
  if (clean.startsWith('01') && clean.length === 10) return '+254' + clean.slice(1);
  if (clean.startsWith('254') && clean.length === 12) return '+' + clean;
  if (clean.startsWith('+254')) return clean;
  return clean;
}
function isValidKenyanPhoneForPayer(raw: string): boolean {
  const clean = (raw || '').replace(/\s+/g, '');
  if (!clean) return false;
  return /^\+254\d{9}$/.test(normalizeKenyanPhoneForPayer(clean));
}

// Shown when the polled status endpoint answers 429 (too many status checks).
// Phase 7B.2: the poller used to ignore every non-OK response, so a throttled
// client kept hammering the endpoint every 3 seconds forever and the UI simply
// never advanced — silently misleading. Stopping the interval and saying so is
// the honest minimal behaviour; nothing about the claim itself is affected, and
// a page refresh resumes polling.
function statusPollThrottledMessage(): string {
  return 'Status checks are paused for a moment to avoid overloading the server. Please refresh this page in a minute — your claim is safe and still progressing.';
}

// ---------------------------------------------------------------------------
// PICKUP-DETAILS STATE MACHINE (Phase 7C.5 — F8)
//
// The pickup-details request used to return `agent | null`, which silently
// collapsed FOUR different outcomes into one value:
//   * the hub genuinely has no agent assigned yet,
//   * the claim is no longer eligible for pickup instructions,
//   * the request failed (429 / 500 / network),
//   * the request has not happened at all.
// The UI then rendered the same static placeholder for all of them — including
// when no request was in flight, so a permanent failure looked identical to a
// slow success.
//
// The result and the rendered state are now explicit and disjoint, so every
// outcome is represented honestly and a failed refresh is visibly retryable.
// ---------------------------------------------------------------------------
type PickupDetailsResult =
  | { kind: 'ok'; itemId: string | null; agent: any | null }
  | { kind: 'ineligible' }
  | { kind: 'error'; retryable: boolean; status?: number };

type PickupDetailsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; agent: any | null }
  | { status: 'ineligible' }
  | { status: 'error'; retryable: boolean };

// Product copy for each pickup-details state, kept in one place so the
// awaiting-agent and handover screens cannot drift apart, and bilingual to
// match the rest of this view.
function pickupLoadingMessage(): string {
  return 'Retrieving the pickup location…';
}
function pickupNoHubMessage(): string {
  return 'No hub has been assigned yet. The pickup location will appear here as soon as one is available.';
}
function pickupIneligibleMessage(): string {
  return 'Pickup details are no longer available for this claim.';
}
function pickupErrorMessage(): string {
  return 'We could not retrieve the pickup details right now.';
}

/**
 * The verifiable hub details an owner sees once ownership is proven: business
 * name, address, contact phone and (where the agent has coordinates) a
 * directions link. Renders only what it was given, so a coarse or stale hub
 * object can never masquerade as freshly retrieved pickup information.
 */
function HubDetails({ agent, showDirections = false }: { agent: any;  showDirections?: boolean }) {
  const hasCoordinates = agent?.latitude !== undefined && agent?.latitude !== null
    && agent?.longitude !== undefined && agent?.longitude !== null;
  return (
    <div>
      <h4 className="text-base font-bold text-primary-green">{agent?.business_name}</h4>
      {agent?.location_address && (
        <p className="text-ink-muted text-xs font-medium">{agent.location_address}</p>
      )}
      {agent?.contact_phone && (
        <p className="text-ink-muted text-xs font-semibold mt-1">
          {'Phone'}: <span className="font-mono">{agent.contact_phone}</span>
        </p>
      )}
      {showDirections && hasCoordinates && (
        <a
          href={`https://www.google.com/maps/dir/?api=1&destination=${agent.latitude},${agent.longitude}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-primary-green text-xs font-bold mt-2 underline underline-offset-2 hover:text-accent-orange transition"
        >
          <MapPin size={13} />
          {'Open Directions in Google Maps'}
        </a>
      )}
    </div>
  );
}

/**
 * Renders the pickup-details card body from the explicit state. `idle` renders
 * as loading because both screens that use this panel start the request in an
 * effect on entry, so an idle state there is the pre-request frame of a real
 * in-flight sequence — never a placeholder standing in for a request that does
 * not exist.
 */
function PickupDetailsPanel({
  state,
  showDirections = false,
  onRetry,
}: {
  state: PickupDetailsState;
  showDirections?: boolean;
  onRetry: () => void;
}) {
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-ink-muted text-xs py-1">
        <Loader2 className="animate-spin text-primary-green shrink-0" size={14} />
        <span>{pickupLoadingMessage()}</span>
      </div>
    );
  }

  if (state.status === 'ineligible') {
    return <p className="rounded-xl border border-line-subtle bg-canvas-muted px-3 py-2 text-ink-muted text-xs">{pickupIneligibleMessage()}</p>;
  }

  if (state.status === 'error') {
    return (
      <div className="space-y-2">
        <p className="rounded-xl border border-status-danger-border bg-status-danger-surface px-3 py-2 text-status-danger text-xs">{pickupErrorMessage()}</p>
        {state.retryable && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="min-h-11"
          >
            <RefreshCw size={12} aria-hidden="true" />
            {'Try again'}
          </Button>
        )}
      </div>
    );
  }

  // Ready: a null agent is a deliberate "no hub assigned yet" answer from the
  // server, not a failure — and never a cue to keep showing older details.
  if (!state.agent) {
    return <p className="rounded-xl border border-line-subtle bg-canvas-muted px-3 py-2 text-ink-muted text-xs">{pickupNoHubMessage()}</p>;
  }

  return <HubDetails agent={state.agent} showDirections={showDirections} />;
}

export default function OwnerView({ categories, categoriesLoading = false, categoriesError = false, onOpenItem, initialClaimItem = null, onReportLost, isSignedIn = false, onRequireTrackSignIn, trackIntent = false }: OwnerViewProps) {
  const t = translations.en;

  // Search States
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedArea, setSelectedArea] = useState('');
  const [selectedCat, setSelectedCat] = useState('');
  const [selectedCounty, setSelectedCounty] = useState('');
  const [selectedAdministrativeUnit, setSelectedAdministrativeUnit] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [testModeEnabled, setTestModeEnabled] = useState(false);
  const [simulatedPickupCode, setSimulatedPickupCode] = useState<string | null>(null);
  // P1 (B-2) — pickup-code recovery. Holds NO code, ever: the server returns
  // only { success: true }, so there is nothing secret to keep in client state
  // and nothing that could end up in localStorage/sessionStorage. Deliberately
  // not persisted across a refresh — the owner's real source of truth remains
  // the message the server sent: the payment email, if the claim carried an
  // address, or the fresh code the signed-in dashboard resend issues to the
  // account's verified email. Which of those applies is not a client-side fact.
  const [pickupCodeResendState, setPickupCodeResendState] = useState<
    { status: 'idle' | 'sending' | 'sent' | 'error'; message?: string }
  >({ status: 'idle' });

  // P1 (B-2). Asks the server to issue a fresh pickup code. It never reads,
  // stores or renders a code: the response is { success: true } or an error
  // string. The disabled state during flight is a UX courtesy only — the
  // server enforces a real per-claim cooldown and rate limit regardless of
  // what the client does.
  const requestPickupCodeResend = async () => {
    if (!paidClaim?.id) return;
    setPickupCodeResendState({ status: 'sending' });
    try {
      const response = await fetch(`/api/customer/claims/${encodeURIComponent(paidClaim.id)}/pickup-code/resend`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      });
      if (response.ok) {
        setPickupCodeResendState({ status: 'sent' });
        return;
      }
      // The SERVER decides why a code could not be sent, and its wording is the
      // accurate one: a transient provider refusal and email delivery being
      // unavailable (no verified address on file, or the provider rejecting) are
      // different situations, and only the server knows
      // which applies. A hard-coded client string here told every owner to
      // "try again shortly", including when retrying could not possibly help.
      // The fallback below is used only when the response carries no text.
      const data = await response.json().catch(() => ({}));
      setPickupCodeResendState({ status: 'error', message: data?.error || undefined });
    } catch {
      setPickupCodeResendState({ status: 'error' });
    }
  };

  // PHASE 16.1 (GEO-16-01) — the county filter is NOT fetched.
  // It used to call GET /api/regions, which returned a mixed vocabulary of
  // counties, towns, estates and arbitrary reporter-typed location text (with a
  // 30-entry hard-coded fallback), and presented it as "Regions". That endpoint
  // and its DB method are retired. The options below come from the ONE canonical
  // 47-county dataset (config/kenyaCounties.ts), so there is nothing to load,
  // nothing to fail, and no second geography to drift.

  useEffect(() => {
    // Check whether dev/test conveniences (like a payment simulator) are
    // available — only ever true off-production with mock OTP bypass on.
    fetch('/api/dev/test-mode')
      .then(res => res.json())
      .then(data => setTestModeEnabled(!!data.testModeEnabled))
      .catch(() => setTestModeEnabled(false));
  }, []);

  // Active claim/verification flow
  const [selectedItem, setSelectedItem] = useState<any | null>(null);
  const [verificationStep, setVerificationStep] = useState<
    'search' | 'confidence_gate' | 'tier1_security' | 'tier2_otp' | 'tier3_id' | 'payment' | 'payment_polling' | 'handover_success' | 'awaiting_agent_confirmation' | 'payment_window_expired'
  >('search');

  // UX-09 — the stage the rail is on, and its guidance, both read from the
  // SAME map, so the rail and the guide below it can never disagree. An unknown
  // step falls back to stage 0 exactly as the rail does.
  const claimStageIndex = CLAIM_STEP_INDEX[verificationStep] ?? 0;
  const claimStageGuide = CLAIM_STAGE_GUIDE[claimStageIndex];
  const stageOf = (v: { en: string }) => (v.en);

  // Verification Form states
  const [ownerPhone, setOwnerPhone] = useState('');
  // M-Pesa number that should receive the STK prompt. MAY differ from
  // owner_phone (the claim's registered phone): eCitizen-style, a payer can pay
  // for a claim from a different valid Safaricom number. Defaults to owner_phone.
  const [payerPhone, setPayerPhone] = useState('');
  // The server-side payment session this claim is currently paying with.
  const [paymentSessionId, setPaymentSessionId] = useState('');
  // P14A (P14-03) — the authoritative KES amount the SERVER pinned when it
  // created this claim's payment session. Stays null until a session exists;
  // the claimant-facing fee block below must never show a fabricated 0 in its
  // place.
  const [paymentSessionAmount, setPaymentSessionAmount] = useState<number | null>(null);
  const [ownerEmail, setOwnerEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');

  // Track My Claim modal states
  const [showTrackModal, setShowTrackModal] = useState(false);
  const [trackClaimId, setTrackClaimId] = useState('');
  const [trackPhone, setTrackPhone] = useState('');
  const [trackLoading, setTrackLoading] = useState(false);
  const [trackError, setTrackError] = useState('');
  const [trackResult, setTrackResult] = useState<any | null>(null);

  const [agreedTerms, setAgreedTerms] = useState(false);

  // Confidence Gate states
  const [ownerIdentifyingDetails, setOwnerIdentifyingDetails] = useState('');
  const [isConfident, setIsConfident] = useState(false);

  // Payment states
  const [isPaying, setIsPaying] = useState(false);
  const [paidClaim, setPaidClaim] = useState<any | null>(null);
  const [strikeWarning, setStrikeWarning] = useState<string | null>(null);
  const [pollingStatus, setPollingStatus] = useState<'pending' | 'success' | 'failed' | 'timeout'>('pending');
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const pollingIntervalRef = useRef<any>(null);

  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, []);

  // PHASE 7B — "It's Mine" hand-off: when the public item page passes an item
  // in (after the visitor passed the authentication boundary), open the claim
  // journey directly on that item's ownership-confidence step. Runs once: the
  // claim flow itself then owns the step transitions (including Back).
  const initialClaimAppliedRef = useRef(false);
  useEffect(() => {
    if (!initialClaimItem || initialClaimAppliedRef.current) return;
    initialClaimAppliedRef.current = true;
    setSelectedItem(initialClaimItem);
    setVerificationStep('confidence_gate');
  }, [initialClaimItem]);

  // The phone the claimant typed is read by the 3-second polling loops below.
  // Those loops are created inside event handlers, so a plain state read would
  // capture whatever the value was at the moment the interval was created; a
  // ref keeps them reading the CURRENT value (a stale empty value would make
  // the pickup-details call below fail its ownership check).
  const ownerPhoneRef = useRef('');
  useEffect(() => {
    ownerPhoneRef.current = ownerPhone;
  }, [ownerPhone]);

  // PHASE 7B — agent pickup contact/location, fetched ONLY after the claimant
  // has proven ownership. This used to arrive on the polling response itself
  // (GET /api/claims/:id/status returned the agent's full phone number, exact
  // address and GPS coordinates to anyone who knew or guessed a claim ID). That
  // was a P0 exposure: claim IDs are 6-digit numeric codes. The status endpoint
  // now returns status only, and this ownership-gated call supplies the pickup
  // details using the same claim ID + registered-phone proof the rest of the
  // claim flow already uses.
  //
  // PHASE 7C.5 (F8): the helper returns an explicit discriminated result instead
  // of `agent | null`, and it drives `pickupDetails` — the single source of
  // truth the hub cards render from. Nothing here ever displays a returned agent
  // for a claim whose item is not the item currently on screen.
  const [pickupDetails, setPickupDetails] = useState<PickupDetailsState>({ status: 'idle' });
  // Monotonic request token: a response may only update the UI if it is still
  // the newest request (stale-response protection).
  const pickupRequestSeqRef = useRef(0);
  const pickupAbortRef = useRef<AbortController | null>(null);
  // The claim whose pickup details have already been requested, so entering the
  // awaiting/handover steps requests them once per claim and never re-requests
  // on an unrelated re-render.
  const pickupRequestedForClaimRef = useRef<string | null>(null);
  // Mirror of the on-screen item, readable from async callbacks that must
  // assert identity before merging private hub details (F7).
  const selectedItemRef = useRef<any | null>(null);
  useEffect(() => {
    selectedItemRef.current = selectedItem;
  }, [selectedItem]);

  useEffect(() => {
    return () => {
      if (pickupAbortRef.current) pickupAbortRef.current.abort();
    };
  }, []);

  // Low-level request. Maps the server contract to the explicit result:
  //   200 -> ok (agent may legitimately be null = "no hub assigned yet")
  //   409 -> ineligible (claim exists, phone matched, status no longer entitled)
  //   429 -> retryable error (the pickup-details limiter, never swallowed)
  //   5xx -> retryable error
  //   other 4xx -> non-retryable error
  const requestPickupDetails = async (claimId: string, signal: AbortSignal): Promise<PickupDetailsResult> => {
    const res = await fetch(`/api/claims/${claimId}/pickup-details`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: ownerPhoneRef.current }),
      signal,
    });
    if (res.status === 409) return { kind: 'ineligible' };
    if (res.status === 429) return { kind: 'error', retryable: true, status: 429 };
    if (!res.ok) return { kind: 'error', retryable: res.status >= 500, status: res.status };
    const payload = await res.json();
    return { kind: 'ok', itemId: payload?.item_id ?? null, agent: payload?.agent ?? null };
  };

  const fetchAgentPickupDetails = async (claimId: string): Promise<PickupDetailsResult> => {
    // Supersede any in-flight pickup request: a stale response must never
    // overwrite a newer one.
    pickupRequestSeqRef.current += 1;
    const seq = pickupRequestSeqRef.current;
    if (pickupAbortRef.current) pickupAbortRef.current.abort();
    const controller = new AbortController();
    pickupAbortRef.current = controller;
    pickupRequestedForClaimRef.current = claimId;
    setPickupDetails({ status: 'loading' });

    let result: PickupDetailsResult;
    try {
      result = await requestPickupDetails(claimId, controller.signal);
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        // Superseded by a newer request, which owns the UI state from here.
        return { kind: 'error', retryable: true };
      }
      // Log the failure only — no provider/server detail, and nothing that
      // could surface private operational data in the browser.
      console.error('Failed to load pickup agent details.');
      result = { kind: 'error', retryable: true };
    }

    if (seq !== pickupRequestSeqRef.current) {
      // A newer request has superseded this one; do not touch the UI at all.
      return result;
    }

    if (result.kind === 'ok') {
      // F7 (defence-in-depth): only accept private hub details for the item the
      // server says the claim belongs to. A missing or mismatched item id is
      // treated as stale, and NOTHING is displayed or merged.
      const onScreenItemId = selectedItemRef.current?.id ?? null;
      if (!result.itemId || !onScreenItemId || result.itemId !== onScreenItemId) {
        setPickupDetails({ status: 'error', retryable: true });
        return { kind: 'error', retryable: true, status: 200 };
      }
      setPickupDetails({ status: 'ready', agent: result.agent });
      setSelectedItem(prev => (prev && prev.id === result.itemId ? { ...prev, agent: result.agent } : prev));
    } else if (result.kind === 'ineligible') {
      setPickupDetails({ status: 'ineligible' });
    } else {
      setPickupDetails({ status: 'error', retryable: result.retryable });
    }
    return result;
  };

  // F8: the awaiting-agent and handover screens both need the hub's real
  // contact/location, and both previously rendered a "Fetching..." placeholder
  // without ever making a request. Request it once per claim, on entry.
  useEffect(() => {
    if (verificationStep !== 'awaiting_agent_confirmation' && verificationStep !== 'handover_success') return;
    const claimId = paidClaim?.id;
    if (!claimId) {
      // Nothing to fetch for — say so rather than spinning forever.
      setPickupDetails({ status: 'error', retryable: false });
      return;
    }
    if (pickupRequestedForClaimRef.current === claimId) return;
    void fetchAgentPickupDetails(claimId);
  }, [verificationStep, paidClaim?.id]);

  const retryPickupDetails = () => {
    const claimId = paidClaim?.id;
    if (!claimId) return;
    void fetchAgentPickupDetails(claimId);
  };

  useEffect(() => {
    if (verificationStep === 'payment' && paidClaim?.agent_confirmed_at) {
      const confirmedTime = new Date(paidClaim.agent_confirmed_at).getTime();
      const calculateTimeLeft = () => {
        // E2-A: the countdown the claimant SEES must be the window the SERVER
        // actually enforces. This was an inline `15 * 60 * 1000`, i.e. the
        // per-prompt session clock, so the browser declared the claim expired
        // long before checkClaimExpiry would — and told the claimant to stop
        // paying during a window the server still accepted payment in. It now
        // counts the canonical CLAIM window from the agent's confirmation.
        const diff = confirmedTime + CLAIM_PAYMENT_WINDOW_MS - Date.now();
        if (diff <= 0) {
          setTimeLeft(0);
          setVerificationStep('payment_window_expired');
        } else {
          setTimeLeft(Math.floor(diff / 1000));
        }
      };

      calculateTimeLeft();
      const timer = setInterval(calculateTimeLeft, 1000);
      return () => clearInterval(timer);
    }
  }, [verificationStep, paidClaim?.agent_confirmed_at]);

  // Track My Claim modal: lock background scroll, manage focus
  const trackModalTriggerRef = useRef<HTMLButtonElement | null>(null);
  const trackModalRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (showTrackModal) {
      const previousOverflow = document.body.style.overflow;
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          setShowTrackModal(false);
        } else if (trackModalRef.current) {
          trapModalFocus(event, trackModalRef.current);
        }
      };
      document.addEventListener('keydown', handleKeyDown);
      // Lock background scrolling so user cannot scroll the page behind the modal
      document.body.style.overflow = 'hidden';
      // Move focus into the modal's first input for immediate keyboard access
      const timer = setTimeout(() => {
        const el = document.getElementById('track-claim-id');
        if (el) el.focus();
      }, 50);
      return () => {
        clearTimeout(timer);
        document.removeEventListener('keydown', handleKeyDown);
        // Restore background scrolling when modal closes
        document.body.style.overflow = previousOverflow;
        // Return focus to the trigger button so screen-reader users aren't lost
        if (trackModalTriggerRef.current) {
          trackModalTriggerRef.current.focus();
        }
      };
    }
  }, [showTrackModal]);

  // PHASE 16 — the post-authentication return: the visitor arrived (or came
  // back from /account) with the `?track=1` intent, so open the Track My Claim
  // modal they asked for. It opens only once the session is actually live —
  // without one, App has already routed them through /account instead, and the
  // modal (and the lookup it performs) stays closed.
  useEffect(() => {
    if (trackIntent && isSignedIn) {
      setShowTrackModal(true);
      setTrackError('');
      setTrackResult(null);
    }
  }, [trackIntent, isSignedIn]);

  // Agent Rating
  const [userRating, setUserRating] = useState<number | null>(null);
  const [ratingSubmitted, setRatingSubmitted] = useState(false);

  // Trigger search
  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSearchLoading(true);
    setErrorMsg('');
    setHasSearched(true);

    try {
      const params = new URLSearchParams();
      // `q` is the broad item query (name, identifying/plate number, details).
      // `area` is deliberately independent exact/free-text place context.
      if (searchQuery) params.append('q', searchQuery);
      if (selectedArea) params.append('area', selectedArea);
      if (selectedCat) params.append('categoryId', selectedCat);
      // PHASE 16.1 (GEO-16-01): a STRUCTURED canonical county filter. Omitted
      // entirely when no county is selected, so an unfiltered search is the
      // pre-16.1 request and legacy items with no county stay searchable.
      if (selectedCounty) params.append('county', selectedCounty);
       if (selectedAdministrativeUnit) {
         const validUnit = resolveAdministrativeUnitId(selectedCounty, selectedAdministrativeUnit);
         if (validUnit) params.append('administrativeUnitId', validUnit);
       }

      const response = await fetch(`/api/items/search?${params.toString()}`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Search failed');
      }

      setSearchResults(data);
    } catch (e: any) {
      console.error(e);
      setErrorMsg(e.message);
    } finally {
      setSearchLoading(false);
    }
  };

  // Perform public area-browsing directly on mounting to draw attention to existing items
  useEffect(() => {
    handleSearch();
  }, []);

  const isInitialMount = useRef(true);

  // Auto-trigger search when category or county filter changes
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    handleSearch();
  }, [selectedCat, selectedCounty, selectedAdministrativeUnit]);

  // Submit Tier 1 Security answers — collected by the category-specific
  // VerificationForm (field keys are defined in verificationProfiles.ts).
  const handleTier1Submit = async (answers: Record<string, string>, submittedIdProofBase64: string | null) => {
    setErrorMsg('');
    setSearchLoading(true);

    if (!agreedTerms) {
      setErrorMsg('Ni lazima ukubali Vigezo na Masharti yetu kabla ya kuendelea (You must agree to our Terms of Service and Privacy Policy to continue).');
      setSearchLoading(false);
      return;
    }

    if (!ownerPhone.trim()) {
      setErrorMsg('Please enter your phone number before claiming.');
      setSearchLoading(false);
      return;
    }

    if (ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
      setErrorMsg('Tafadhali weka barua pepe sahihi (Please enter a valid email address).');
      setSearchLoading(false);
      return;
    }

    try {
      // Claim submission is an AUTHENTICATED write on the server
      // (requireCustomerAuth, the same boundary the tracking lookup below
      // already sits behind), so the httpOnly r4m_customer_session cookie has
      // to travel with this request. `same-origin` is the cookie policy — the
      // cookie IS the session, and no token is read from or written to browser
      // storage anywhere in this flow.
      const response = await fetch('/api/claims/submit', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemId: selectedItem.id,
          ownerPhone,
          securityAnswers: answers,
          verificationTier: submittedIdProofBase64 ? 3 : 2,
          idProofBase64: submittedIdProofBase64,
          termsAccepted: agreedTerms,
          ownerIdentifyingDetails,
          ownerEmail,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Verification failed');
      }

      // Move to Tier 2 OTP validation using the newly submitted claim
      setPaidClaim(data.claim);
      if (data.warning) {
        setStrikeWarning(data.warning);
      } else {
        setStrikeWarning(null);
      }
      triggerOtpRequest(data.claim.id);
    } catch (e: any) {
      console.error(e);
      setErrorMsg(e.message);
    } finally {
      setSearchLoading(false);
    }
  };

  // Request a fresh claim OTP for Owner validation (Tier 2 OTP). E1: the code is
  // delivered to the claim owner's VERIFIED EMAIL ADDRESS; the phone number below
  // is what the server matches the claim against, and the destination is resolved
  // from that authoritative record — never from the browser.
  const triggerOtpRequest = async (claimId: string) => {
    setErrorMsg('');
    try {
      const response = await fetch(`/api/claims/${claimId}/request-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: ownerPhone }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to request OTP');
      }


      setVerificationStep('tier2_otp');
    } catch (e: any) {
      setErrorMsg(e.message);
    }
  };

  // Verify OTP via Server Endpoint (Tier 2 OTP validation)
  const handleOtpVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setSearchLoading(true);
    try {
      const response = await fetch(`/api/claims/${paidClaim.id}/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: otpCode }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Msimbo si sahihi au umepitwa na wakati.');
      }
      setVerificationStep('awaiting_agent_confirmation');
      startAwaitingAgentPolling(paidClaim.id);
    } catch (e: any) {
      setErrorMsg(e.message);
    } finally {
      setSearchLoading(false);
    }
  };

  const startAwaitingAgentPolling = (claimId: string) => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
    }
    const interval = setInterval(async () => {
      try {
        const response = await fetch(`/api/claims/${claimId}/status`);
        if (response.ok) {
          const data = await response.json();
          if (data.status === 'pending_payment') {
            clearInterval(interval);
            setPaidClaim(data.claim);
            // Phase 7B: the status response no longer carries agent
            // contact/location (it was publicly readable by claim ID alone).
            // Phase 7C.5: the payment/handover screens own the pickup-details
            // request (see the step effect above), so this loop only advances
            // the step — it never reads private agent data off a status poll.
            setVerificationStep('payment');
          } else if (data.status === 'payment_window_expired') {
            clearInterval(interval);
            setPaidClaim(data.claim);
            setVerificationStep('payment_window_expired');
          } else if (data.status === 'escrow_held' || data.status === 'released') {
            clearInterval(interval);
            setPaidClaim(data.claim);
            setVerificationStep('handover_success');
          }
        } else if (response.status === 429) {
          // Phase 7B.2: stop polling and tell the user, instead of continuing to
          // hammer a throttled endpoint every 3 seconds in silence.
          clearInterval(interval);
          setPollingStatus('timeout');
          setErrorMsg(statusPollThrottledMessage());
        }
      } catch (e) {
        console.error('Polling status error:', e);
      }
    }, 3000);
    pollingIntervalRef.current = interval;
  };

  const startPollingPaymentStatus = (claimId: string) => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
    }
    setPollingStatus('pending');
    setErrorMsg('');

    let secondsPassed = 0;
    const interval = setInterval(async () => {
      secondsPassed += 3;
      if (secondsPassed > 90) {
        clearInterval(interval);
        setPollingStatus('timeout');
        setErrorMsg('Payment confirmation timed out. If you entered your M-Pesa PIN, please try refreshing or checking with the agent.');
        return;
      }

      try {
        const response = await fetch(`/api/claims/${claimId}/status`);
        if (response.ok) {
          const data = await response.json();
          if (data.status === 'escrow_held' || data.status === 'released') {
            clearInterval(interval);
            setPaidClaim(data.claim);
            // Phase 7C.5: the handover screen owns the pickup-details request
            // (step effect), so a status poll can never supply agent data.
            setPollingStatus('success');
            setVerificationStep('handover_success');
          }
        } else if (response.status === 429) {
          // Phase 7B.2: same throttle handling as the awaiting-agent poller —
          // stop the loop and surface it rather than retrying every 3 seconds.
          clearInterval(interval);
          setPollingStatus('timeout');
          setErrorMsg(statusPollThrottledMessage());
        }
      } catch (e) {
        console.error('Polling payment status error:', e);
      }
    }, 3000);

    pollingIntervalRef.current = interval;
  };

  // M-Pesa STK Push via a server-controlled payment session.
  // 1. payment-auth: prove ownership (phone == claim owner phone) for a short-lived token.
  // 2. payment-session: create (or reuse) a claim-bound session pinning the
  //    authoritative server amount and the payer's M-Pesa number (may differ
  //    from the owner phone). Nothing in the request is trusted as an amount.
  // 3. initiate: trigger the STK push; idempotent server-side (one push/session).
  const triggerEscrowPayment = async () => {
    if (!paidClaim?.id) return;
    setIsPaying(true);
    setErrorMsg('');

    try {
      const authResponse = await fetch(`/api/claims/${paidClaim.id}/payment-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: ownerPhone }),
      });
      const authData = await authResponse.json();
      if (!authResponse.ok) {
        throw new Error(authData.error || 'Payment authorization failed');
      }

      const createResponse = await fetch(`/api/claims/${paidClaim.id}/payment-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: ownerPhone, payerPhone: payerPhone.trim() || ownerPhone }),
      });
      const createData = await createResponse.json();
      if (!createResponse.ok) {
        throw new Error(createData.error || 'Failed to create the payment session');
      }
      const sessionId = createData.paymentSession?.id;
      if (!sessionId) {
        throw new Error('Payment session was not created');
      }
      setPaymentSessionId(sessionId);
      // P14A (P14-03) — record the authoritative amount the server computed for
      // this session (it also covers the `reused: true` case, where the server
      // returned an already-open session rather than creating a new one).
      if (createData.paymentSession?.amount !== undefined && createData.paymentSession?.amount !== null) {
        const sessionAmount = Number(createData.paymentSession.amount);
        if (Number.isFinite(sessionAmount)) setPaymentSessionAmount(sessionAmount);
      }

      const initiateResponse = await fetch(`/api/claims/${paidClaim.id}/payment-session/${sessionId}/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentAuthToken: authData.paymentAuthToken }),
      });
      const initiateData = await initiateResponse.json();
      if (!initiateResponse.ok) {
        throw new Error(initiateData.error || 'Payment initiation failed');
      }

      setVerificationStep('payment_polling');
      startPollingPaymentStatus(paidClaim.id);
    } catch (e: any) {
      console.error(e);
      setErrorMsg(e.message);
    } finally {
      setIsPaying(false);
    }
  };

  // "Check payment status" — asks the BACKEND, never trusts the browser. It
  // cannot mark a payment confirmed itself; it only reflects what the server
  // and payment provider have actually recorded.
  const checkPaymentStatus = async () => {
    if (!paidClaim?.id || !paymentSessionId) {
      setErrorMsg('No active payment session yet. Please send the M-Pesa prompt first.');
      return;
    }
    setErrorMsg('');
    try {
      const response = await fetch(`/api/claims/${paidClaim.id}/payment-session/${paymentSessionId}/status`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Could not fetch payment status');
      }
      const s = data.paymentSession;
      // P14A (P14-03) — the poll is another authoritative source for the amount.
      if (s?.amount !== undefined && s?.amount !== null) {
        const polledAmount = Number(s.amount);
        if (Number.isFinite(polledAmount)) setPaymentSessionAmount(polledAmount);
      }
      const claimStatus = data.claim?.status;
      if (s?.status === 'confirmed' || claimStatus === 'escrow_held' || claimStatus === 'released') {
        if (pollingIntervalRef.current) clearInterval(pollingIntervalRef.current);
        setPollingStatus('success');
        setVerificationStep('handover_success');
      } else if (s?.status === 'expired' || claimStatus === 'payment_window_expired') {
        if (pollingIntervalRef.current) clearInterval(pollingIntervalRef.current);
        setVerificationStep('payment_window_expired');
      } else if (s?.status === 'failed') {
        setErrorMsg('The payment failed. Please try a new payment.');
      } else {
        setPollingStatus('pending');
      }
    } catch (e: any) {
      console.error(e);
      setErrorMsg(e.message);
    }
  };

  // TEST-MODE ONLY: lets a local tester complete a payment without a real
  // M-Pesa phone. The button that calls this only ever renders when the
  // backend confirms test mode is active (never in production).
  const simulatePaymentSuccess = async () => {
    if (!paidClaim?.id) return;
    setIsPaying(true);
    setErrorMsg('');
    try {
      const response = await fetch(`/api/dev/simulate-payment/${paidClaim.id}`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Simulate payment failed');
      }
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
      setPaidClaim(data.claim);
      setSimulatedPickupCode(data.pickupCode || null);
      setPollingStatus('success');
      setVerificationStep('handover_success');
    } catch (e: any) {
      setErrorMsg(e.message);
    } finally {
      setIsPaying(false);
    }
  };

  // Submit Rating
  const submitRating = async (score: number) => {
    setUserRating(score);
    try {
      await fetch(`/api/claims/${paidClaim.id}/rate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userRating: score }),
      });
      setRatingSubmitted(true);
    } catch (e) {
      console.error('Rating submission failed:', e);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      
      {/* Search & Listing View */}
      {verificationStep === 'search' && (
        <div className="space-y-8">
          
          {/* Headline & Track Claim Action */}
          <div className="text-center space-y-3">
            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-primary-green mb-2">{t.ownerTitle}</h1>
            <p className="text-ink-muted text-sm sm:text-base max-w-xl mx-auto leading-relaxed">{t.ownerSubtitle}</p>
            <Button
              ref={trackModalTriggerRef}
              type="button"
              variant="secondary"
              size="md"
              onClick={() => {
                // PHASE 16 — Track My Claim is a customer-authenticated action.
                // A signed-out visitor is handed to the EXISTING /account
                // boundary (with a validated return to this page and the
                // ?track=1 intent) instead of being shown a lookup form the
                // server now refuses. No second auth mechanism is involved.
                if (!isSignedIn) {
                  onRequireTrackSignIn?.();
                  return;
                }
                setShowTrackModal(true);
                setTrackError('');
                setTrackResult(null);
              }}
            >
              <Clock size={14} className="text-accent-orange" aria-hidden="true" />
              <span>{'Track My Existing Claim'}</span>
            </Button>
            {!isSignedIn && (
              <p className="text-caption text-ink-muted">
                {'Tracking a claim needs a Return4me account. You are returned here straight after signing in.'}
              </p>
            )}
          </div>

          {/* PHASE 11A — LOST-REPORT ENTRY POINT
              Two genuinely different situations arrive on this page and the
              page used to serve only the second one:
                (1) "I have lost something and have not reported it yet"
                (2) "Something of mine may already have been found"
              Reporting is a customer-authenticated journey, so the CTA hands off
              to /report-lost (which itself routes an unauthenticated visitor
              through the existing /account sign-in and back). No second report
              form is created here. */}
          <section
            aria-labelledby="lost-entry-heading"
            className="bg-white rounded-2xl border border-line-subtle p-5 sm:p-6 shadow-sm"
          >
            <h2 id="lost-entry-heading" className="text-base sm:text-lg font-extrabold text-ink">
              {'Something of yours is missing?'}
            </h2>
            <p className="mt-1 text-sm text-ink-muted leading-relaxed max-w-2xl">
              {'There are two different journeys here. Choose the one that matches your situation.'}
            </p>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-primary-green/20 bg-primary-green/5 p-4 sm:p-5 flex flex-col">
                <h3 className="text-sm font-extrabold text-ink">
                  {'I have lost it — I want to report it'}
                </h3>
                <p className="mt-1.5 text-xs text-ink-muted leading-relaxed flex-1">
                  {'File a lost-item report. We compare it with found items that are eligible to be claimed and show you anything that looks similar. Your report stays private to you.'}
                </p>
                <div className="mt-4">
                  <Button variant="primary" size="md" onClick={() => onReportLost && onReportLost()}>
                    <AlertTriangle size={14} />
                    {'Report a Lost Item'}
                  </Button>
                </div>
              </div>

              <div className="rounded-2xl border border-line-subtle bg-brand-beige/40 p-4 sm:p-5 flex flex-col">
                <h3 className="text-sm font-extrabold text-ink">
                  {'It may have been found — I want to search for it'}
                </h3>
                <p className="mt-1.5 text-xs text-ink-muted leading-relaxed flex-1">
                  {'Search the items reported as found in the search below, then claim the one that is yours. Already started a claim? Track its status above.'}
                </p>
                <p className="mt-4 text-xs font-bold text-ink-muted">
                  {'Use the search below'}
                </p>
              </div>
            </div>
          </section>

          {errorMsg && (
            <div className="bg-status-danger-surface border border-status-danger-border text-status-danger px-4 py-3 rounded-2xl flex items-center gap-2.5 text-sm">
              <AlertCircle size={18} className="shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Public discovery: broad item query and exact-place context remain
              independent. Structured geography comes only from canonical configs. */}
          <form onSubmit={handleSearch} className="space-y-5 rounded-2xl border border-line-subtle bg-white p-5 shadow-sm sm:p-6">
            <div className="grid gap-4">
              <label className="grid gap-2 sm:grid-cols-[9rem_1fr] sm:items-center">
                <span className="text-xs font-extrabold uppercase tracking-wider text-primary-green">{'Item details'}</span>
                <span className="relative">
                  <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder={t.searchPlaceholder} aria-label={t.searchPlaceholder} className="w-full rounded-2xl border border-line-subtle bg-brand-beige py-3 pl-10 pr-4 text-sm focus:border-accent-orange" />
                  <Search className="absolute left-3.5 top-3.5 text-ink-muted" size={18} aria-hidden="true" />
                </span>
              </label>

              <fieldset className="grid gap-3 sm:grid-cols-2">
                <legend className="mb-1 text-xs font-extrabold uppercase tracking-wider text-primary-green sm:col-span-2">{'Where was it found?'}</legend>
                <label className="grid gap-1.5">
                  <span className="text-xs font-bold text-ink-muted">{'Category'}</span>
                  <select value={selectedCat} onChange={e => setSelectedCat(e.target.value)} aria-label={'Filter by category'} className="w-full rounded-2xl border border-line-subtle bg-white px-3 py-3 text-sm focus:border-accent-orange disabled:bg-brand-light-gray disabled:text-brand-muted-text" disabled={categoriesLoading || categoriesError}>
                    {categoriesLoading ? <option value="">{'Loading categories...'}</option> : categoriesError ? <option value="">{'Categories unavailable — please refresh'}</option> : [<option key="all-categories" value="">{'All categories'}</option>, ...categories.filter(cat => cat.name_en && cat.name_sw).map(cat => <option key={cat.id} value={cat.id}>{cat.name_en}</option>)]}
                  </select>
                </label>
                <label className="grid gap-1.5">
                  <span className="text-xs font-bold text-ink-muted">{'County'}</span>
                  <select value={selectedCounty} onChange={e => { setSelectedCounty(e.target.value); setSelectedAdministrativeUnit(''); }} aria-label={'Filter by county'} className="w-full rounded-2xl border border-line-subtle bg-white px-3 py-3 text-sm focus:border-accent-orange">
                    <option value="">{'All counties'}</option>
                    {COUNTY_GROUPS.map(group => <optgroup key={group.group} label={group.group}>{group.counties.map(county => <option key={county.code} value={county.name}>{county.name}</option>)}</optgroup>)}
                  </select>
                </label>
                <label className="grid gap-1.5 sm:col-span-2">
                  <span className="text-xs font-bold text-ink-muted">{'Sub-county'}</span>
                  <select value={selectedAdministrativeUnit} onChange={e => setSelectedAdministrativeUnit(e.target.value)} disabled={!selectedCounty} aria-label={'Filter by sub-county'} className="w-full rounded-2xl border border-line-subtle bg-white px-3 py-3 text-sm focus:border-accent-orange disabled:bg-brand-light-gray disabled:text-brand-muted-text">
                    <option value="">{(selectedCounty ? 'All sub-counties' : 'Select county first')}</option>
                    {selectedCounty && administrativeUnitsForCounty(selectedCounty).map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
                  </select>
                </label>
              </fieldset>

              <label className="grid gap-2 sm:grid-cols-[9rem_1fr] sm:items-center">
                <span className="text-xs font-extrabold uppercase tracking-wider text-primary-green">{'Exact place / area'}</span>
                <span className="relative">
                  <input type="text" value={selectedArea} onChange={e => setSelectedArea(e.target.value)} aria-label={'Exact place or area'} placeholder={'Street, estate, building, landmark, stage or market'} className="w-full rounded-2xl border border-line-subtle bg-brand-beige py-3 pl-10 pr-4 text-sm focus:border-accent-orange" />
                  <MapPin className="absolute left-3.5 top-3.5 text-ink-muted" size={18} aria-hidden="true" />
                </span>
              </label>
            </div>
            <button type="submit" disabled={searchLoading} className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-2xl bg-accent-strong px-8 py-3 font-bold text-white shadow-lg shadow-orange-500/10 transition hover:bg-accent-strong-hover disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto">
              {searchLoading ? <Loader2 className="animate-spin" size={18} aria-hidden="true" /> : <Search size={18} aria-hidden="true" />}
              <span>{'Search found items'}</span>
            </button>
          </form>

          {/* Privacy masking badge info */}
          <div className="bg-status-info-surface border border-status-info-border rounded-2xl p-4 flex items-start gap-3 text-xs text-status-info">
            <ShieldAlert size={18} className="text-accent-orange shrink-0 mt-0.5" />
            <div>
              <span className="font-bold block mb-0.5">
                {'Kenyan Privacy Shield Activated'}
              </span>
              {'To safeguard owners, we never reveal exact document numbers, full names, or finder details in search. Exact matches require entering correct search queries (salted-hash matching).'}
            </div>
          </div>

          {/* Results Grid */}
          <div className="space-y-4">
            <h2 className="text-lg font-bold text-primary-green">
              {searchLoading ? (
                <span>{'Searching secure registry...'}</span>
              ) : (
                <span>
                  {searchResults.length} {searchResults.length === 1 ? ('found item') : ('found items')} {'matching:'}
                </span>
              )}
            </h2>

            {searchLoading ? (
              <div className="bg-white border border-line-subtle rounded-2xl p-12 text-center text-ink-muted flex flex-col items-center justify-center space-y-3 shadow-sm">
                <Loader2 className="animate-spin text-accent-orange" size={32} />
                <span className="text-sm font-medium">{'Searching the secure registry...'}</span>
              </div>
            ) : errorMsg ? (
              <div className="bg-status-danger-surface border border-status-danger-border text-status-danger px-6 py-8 rounded-2xl text-center text-sm space-y-2">
                <AlertCircle size={28} className="mx-auto text-status-danger" />
                <p className="font-bold">{'Search Failed'}</p>
                <p className="text-xs text-status-danger">{errorMsg}</p>
              </div>
            ) : searchResults.length === 0 ? (
              <div className="bg-white border border-line-subtle rounded-2xl p-12 text-center text-ink-muted text-sm space-y-3">
                <p className="font-bold text-base text-primary-green">{'No Items Found'}</p>
                <p className="max-w-md mx-auto text-ink-muted leading-relaxed">{t.noResults}</p>
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setSelectedArea('');
                      setSelectedCat('');
                      setSelectedCounty('');
                      setSelectedAdministrativeUnit('');
                      if (selectedCat === '' && selectedCounty === '') {
                        handleSearch();
                      }
                    }}
                    className="text-caption font-black text-primary-green hover:underline cursor-pointer"
                  >
                    {'Clear Filters & Show All'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {searchResults.map(item => {
                  const cat = categories.find(c => c.id === item.category_id);
                  return (
                    <div key={item.id} className="flex flex-col gap-4 bg-white rounded-2xl border border-line-subtle p-5 shadow-md sm:flex-row sm:items-start sm:space-x-4">
                      {/* Document photo */}
                      <div className="w-full h-28 sm:w-20 sm:h-20 bg-brand-beige rounded-2xl overflow-hidden shrink-0 border border-line-subtle flex items-center justify-center">
                        {item.is_sensitive_document ? (
                          <div className="flex flex-col items-center justify-center p-2 text-center h-full w-full bg-brand-light-gray text-brand-muted-text">
                            <Lock size={18} className="text-ink-muted mb-1 shrink-0" />
                            <span className="text-caption font-bold leading-tight text-ink-muted">{'Photo hidden for privacy'}</span>
                          </div>
                        ) : (
                          <img src={item.photo_url} alt={'Found item'} className="w-full h-full object-cover" />
                        )}
                      </div>

                      {/* Info block */}
                      <div className="flex-1 space-y-1.5 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="bg-status-success-surface text-status-success text-caption font-extrabold px-2.5 py-1 rounded-full uppercase">
                            {cat?.name_en}
                          </span>
                          <span className="text-caption text-ink-muted font-mono font-medium">
                            {new Date(item.created_at).toLocaleDateString()}
                          </span>
                        </div>

                        <h3 className="font-extrabold text-primary-green truncate">
                          {/* Phase 7B: a public found item is openable at its own
                              addressable page. The existing claim button below is
                              untouched, so the current claim flow still works. */}
                          {onOpenItem ? (
                            <a
                              href={`/item/${encodeURIComponent(item.id)}`}
                              onClick={(e) => {
                                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                                e.preventDefault();
                                onOpenItem(item.id);
                              }}
                              className="hover:underline"
                              aria-label={`Open details for found item: ${item.document_name_fuzzy}`}
                            >
                              {item.document_name_fuzzy}
                            </a>
                          ) : (
                            item.document_name_fuzzy
                          )}
                        </h3>

                        {/* PHASE 16.1 (GEO-16-03): the canonical COUNTY, read
                            straight from the public DTO field — a recognition
                            clue the claimant can judge, and coarser than
                            anything private. An item with no declared county
                            (a legacy row) simply renders no county line. */}
                        {item.found_county && (
                          <p className="text-caption font-extrabold text-ink-muted uppercase tracking-widest">
                            {'County'}: {item.found_county}
                          </p>
                        )}

                        {item.administrative_unit_name && (
                          <p className="text-caption text-ink-muted">
                            {'Sub-county'}: {item.administrative_unit_name}
                          </p>
                        )}
                        <p className="text-ink-muted text-xs line-clamp-2">
                          <MapPin size={10} className="inline mr-1 text-accent-orange" />
                          {item.location_description}
                        </p>

                        <div className="pt-2 border-t border-line-subtle flex items-center justify-between">
                          <span className="text-caption font-extrabold text-ink-muted uppercase tracking-widest">
                            Hub: {item.agent?.business_name.split(' ')[0]}
                          </span>
                          <button
                            onClick={() => {
                              // PI-1 / A2 — ONE authentication policy for claiming.
                              // The public /item/:id page already gates "It's Mine" on a
                              // real session and returns the visitor to this item after
                              // sign-in. This search-result "Claim" button used to jump
                              // STRAIGHT into the claim's confidence gate, which would have
                              // made it the only claim entry point that skipped the
                              // customer-account boundary. Routing a signed-out visitor
                              // through the same gated page keeps the two entries identical
                              // without a second auth mechanism.
                              if (!isSignedIn) {
                                onOpenItem?.(item.id);
                                return;
                              }
                              setSelectedItem(item);
                              setVerificationStep('confidence_gate');
                            }}
                            className="bg-accent-strong hover:bg-accent-strong-hover text-white text-xs font-bold px-4 py-1.5 rounded-xl transition"
                          >
                            {t.claimBtn}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* The guided claim journey (Phase 8.2, refined in UX-09). Renders for
          every claim stage except the search screen and the terminal expired
          state. Two layers, one source: the shared Stepper rail says WHERE the
          claimant is, and the guide beneath it says WHAT happens now and WHO
          moves next — both read from the same CLAIM_STEP_INDEX map, so they
          cannot disagree. Presentation only: it reads the existing step state,
          carries no lifecycle value, and changes nothing the server is asked
          to do. */}
      {verificationStep !== 'search' && verificationStep !== 'payment_window_expired' && (
        <div className="max-w-xl mx-auto mb-6 space-y-3">
          <Stepper
            steps={CLAIM_STEPS.map((s) => ({ label: s.en }))}
            currentStep={claimStageIndex}
            label={'Claim progress'}
          />
          {/* The guide card. One dominant next action is stated in words before
              the controls below repeat it, so the claimant never has to infer
              from the buttons what the journey expects of them. */}
          <section
            aria-label={'What happens at this stage'}
            className="bg-canvas-muted border border-line-subtle rounded-standard p-4 space-y-1 text-left"
          >
            <p className="text-caption font-extrabold uppercase tracking-widest text-ink-muted">
              {`Stage ${claimStageIndex + 1} of ${CLAIM_STEPS.length}`}
              {' · '}
              {stageOf(claimStageGuide.title)}
            </p>
            <p className="text-small text-ink leading-snug">{stageOf(claimStageGuide.what)}</p>
            <p className="text-caption text-ink-muted leading-snug">
              {'Who acts next'}: {stageOf(claimStageGuide.actor)}
            </p>
          </section>
        </div>
      )}

      {/* Confidence Gate Step */}
      {verificationStep === 'confidence_gate' && selectedItem && (
        <div className="bg-white rounded-2xl border border-line-subtle p-6 md:p-8 shadow-sm max-w-xl mx-auto space-y-6 fade-in">
          <div className="text-center space-y-2">
            <h2 className="text-2xl font-extrabold text-primary-green">{'Confirm Your Ownership'}</h2>
            <p className="text-ink-muted text-body">{'Please review the item details and confirm you are the rightful owner before continuing.'}</p>
          </div>

          <div className="border border-line-subtle rounded-2xl p-4 bg-brand-beige space-y-3">
            <h3 className="font-extrabold text-sm text-ink border-b border-line-subtle pb-2">{'Item Information'}</h3>
            <div className="flex gap-4">
              <div className="w-16 h-16 rounded-xl bg-[var(--appearance-surface)] border border-line-subtle overflow-hidden shrink-0 flex items-center justify-center">
                {selectedItem.is_sensitive_document ? (
                  <div className="flex flex-col items-center justify-center p-1 text-center h-full w-full bg-brand-light-gray text-brand-muted-text">
                    <Lock size={14} className="text-ink-muted mb-0.5 shrink-0" />
                    <span className="text-caption font-bold leading-tight text-ink-muted">{'Photo hidden for privacy'}</span>
                  </div>
                ) : (
                  <img
                    src={selectedItem.photo_url}
                    alt="Thumbnail"
                    className="w-full h-full object-contain"
                    referrerPolicy="no-referrer"
                  />
                )}
              </div>
              <div className="space-y-1">
                <p className="text-xs font-extrabold text-ink">{selectedItem.document_name_fuzzy}</p>
                <p className="text-small text-ink-muted">{selectedItem.location_description}</p>
                <p className="text-caption text-ink-muted font-mono">{'Found Hub'}: {selectedItem.agent?.business_name}</p>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <p className="text-caption text-ink-muted bg-status-info-surface border border-status-info-border rounded-xl p-3">
              {'Next you will answer category-specific security questions about this item to prove ownership. Your answers stay private and are only used to verify you.'}
            </p>

            {/* Contact Phone for OTP */}
            <div className="space-y-1">
              <label htmlFor="owner-phone" className="block text-caption font-bold text-ink uppercase tracking-wider">{'Your Phone Number (Matched Against Your Claim)'} *</label>
              <input
                id="owner-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={ownerPhone}
                onChange={(e) => setOwnerPhone(e.target.value)}
                className="w-full border border-line-subtle rounded-xl px-3 py-2.5 text-sm bg-brand-beige font-mono focus:border-accent-orange"
                placeholder="e.g. 0712345678"
                required
              />
            </div>

            {/* Optional Owner Email */}
            <div className="space-y-1">
              <label htmlFor="owner-email" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">
                Email Address (Optional / Barua Pepe - Sio Lazima)
              </label>
              <input
                id="owner-email"
                type="email"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                className="w-full border border-line-subtle rounded-xl px-3 py-2.5 text-sm bg-brand-beige font-sans focus:border-accent-orange"
                placeholder="e.g. claimant@gmail.com"
              />
              <span className="text-caption text-ink-muted block leading-tight">
                {'Provide an email address if you wish to receive billing receipts and collection notices.'}
              </span>
            </div>

            {/* General Terms/Privacy consent. The checkbox keeps its visible
                focus affordance via the single global :focus-visible rule
                (the local ring was a second, weaker focus language); its
                border uses the strong border token so the un-ticked control
                stays distinguishable from the beige row it sits on. */}
            <div className="flex items-start space-x-2 pt-2 pb-1 bg-brand-beige p-3 rounded-xl border border-line-subtle">
              <input
                id="owner-agreed-terms"
                type="checkbox"
                checked={agreedTerms}
                onChange={(e) => setAgreedTerms(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-[var(--appearance-border-strong)] text-primary-green accent-primary-green cursor-pointer"
                required
              />
              <label htmlFor="owner-agreed-terms" className="text-xs text-ink-muted leading-tight select-none cursor-pointer">
                {'I have read and agree to the Return4me'}{' '}
                <button
                  type="button"
                  onClick={() => (window as any).setView?.('terms')}
                  className="text-primary-green hover:underline font-bold inline"
                >
                  {'Terms of Service'}
                </button>{' '}
                {'and'}{' '}
                <button
                  type="button"
                  onClick={() => (window as any).setView?.('privacy')}
                  className="text-primary-green hover:underline font-bold inline"
                >
                  {'Privacy Policy'}
                </button>
              </label>
            </div>
          </div>

          {/* One dominant action per state: "Proceed to Claim" is the only
              primary (accent) control here, and it stays disabled until the
              consent + phone requirements the server re-checks are met. On a
              narrow screen the dominant action sits on top. */}
          <div className="flex flex-col-reverse gap-3 pt-3 sm:flex-row">
            <Button
              type="button"
              variant="secondary"
              size="md"
              onClick={() => setVerificationStep('search')}
              className="w-full sm:flex-1"
            >
              {'Back'}
            </Button>
            <Button
              type="button"
              variant="accent"
              size="md"
              disabled={!agreedTerms || !ownerPhone.trim()}
              onClick={() => setVerificationStep('tier1_security')}
              className="w-full sm:flex-1"
            >
              {'Proceed to Claim'}
            </Button>
          </div>
        </div>
      )}

      {/* Tier 1 Security verification — category-specific questions rendered by
          VerificationForm using the declarative profiles in
          src/config/verificationProfiles.ts */}
      {verificationStep === 'tier1_security' && selectedItem && (
        <VerificationForm
          categoryId={selectedItem.category_id || 'other-item'}
          isSensitiveDocument={selectedItem.is_sensitive_document !== false}
          onSubmit={handleTier1Submit}
          onBack={() => setVerificationStep('confidence_gate')}
          isConfident={isConfident}
          setIsConfident={setIsConfident}
          ownerIdentifyingDetails={ownerIdentifyingDetails}
          setOwnerIdentifyingDetails={setOwnerIdentifyingDetails}
          errorMsg={errorMsg}
          isVerifyingClaim={searchLoading}
        />
      )}

      {/* Tier 2 OTP validation */}
      {verificationStep === 'tier2_otp' && (
        <div className="bg-white rounded-2xl border border-line-subtle p-6 md:p-8 shadow-sm max-w-xl mx-auto space-y-6 text-center fade-in">
          <div className="w-12 h-12 bg-orange-50 text-accent-orange rounded-full flex items-center justify-center mx-auto">
            <Smartphone size={24} />
          </div>
          <div>
            <h2 className="text-xl font-extrabold text-primary-green mb-1">
              {'Verify your code'}
            </h2>
            <p className="text-ink-muted text-xs">
              {'Enter the 4-digit code we sent to the verified email address on this claim.'}
            </p>
          </div>

          {errorMsg && (
            <div className="bg-status-danger-surface border border-status-danger-border text-status-danger px-4 py-2.5 rounded-xl text-xs flex items-center justify-center gap-2">
              <AlertCircle size={16} />
              <span>{errorMsg}</span>
            </div>
          )}



          <form onSubmit={handleOtpVerify} className="space-y-4 max-w-xs mx-auto">
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value)}
              maxLength={4}
              className="w-full border-2 border-line-subtle rounded-xl text-center py-3 text-xl font-mono tracking-widest focus:border-accent-orange"
              placeholder="••••"
              aria-label={'4-digit OTP code'}
              required
            />

            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={searchLoading}
              loadingLabel={'Verifying your code'}
              className="w-full"
            >
              {'Verify code'}
              <ArrowRight size={18} aria-hidden="true" />
            </Button>
          </form>
        </div>
      )}

      {/* Payment step */}
      {verificationStep === 'payment' && (
        <div className="bg-white rounded-2xl border border-line-subtle p-6 md:p-8 shadow-sm max-w-xl mx-auto space-y-6 text-center fade-in">
          <div className="w-14 h-14 bg-status-success-surface text-status-success rounded-full flex items-center justify-center mx-auto">
            <Coins size={28} />
          </div>
          <div>
            <h2 className="text-xl font-extrabold text-primary-green mb-1">{'Complete Payment to Continue'}</h2>
            <p className="text-ink-muted text-xs">{t.paymentSubtitle}</p>
          </div>

          {strikeWarning && (
            <div className="bg-status-warning-surface border border-status-warning-border text-status-warning px-4 py-3 rounded-2xl text-xs text-left flex items-start gap-2">
              <AlertTriangle size={18} className="shrink-0 mt-0.5" />
              <span>{strikeWarning}</span>
            </div>
          )}

          {timeLeft !== null && (
            <div className={`p-4 rounded-2xl border text-xs text-left flex items-start space-x-3 ${timeLeft < 180 ? 'bg-status-danger-surface border-status-danger-border text-status-danger font-bold animate-pulse' : 'bg-status-warning-surface border-status-warning-border text-status-warning'}`}>
              <Clock size={18} className="shrink-0 mt-0.5 text-accent-orange" />
              <div>
                <span className="font-bold block mb-0.5 text-primary-green">
                  {'Payment Window Expiry Countdown'}
                </span>
                <p className="text-ink-muted mb-1 font-medium">
                  {`You must complete the payment within ${CLAIM_PAYMENT_WINDOW_LABEL} of in-person verification. Any single M-Pesa prompt only stays valid for ${PAYMENT_SESSION_WINDOW_LABEL}, but your claim itself stays open for the full ${CLAIM_PAYMENT_WINDOW_LABEL} — you can ask for a new prompt as many times as you need. If you do not pay within ${CLAIM_PAYMENT_WINDOW_LABEL}, the item will be unlocked for other claimants and a strike will be registered on your phone number.`}
                </p>
                <div className="font-mono text-base font-extrabold text-primary-green">
                  {Math.floor(timeLeft / 60)}m {timeLeft % 60}s
                </div>
              </div>
            </div>
          )}

          {/* Official Comparison Info Card */}
          {(() => {
            const catId = selectedItem?.category_id;
            let noteEn = '';
            let noteSw = '';
            
            if (catId === 'national-id') {
              noteEn = 'Skip the 2-4 week wait and police station visit — get it back today. (Official replacement is free under government waiver but takes weeks of waiting).';
              noteSw = 'Epuka kusubiri wiki 2-4 na kwenda kituo cha polisi — rejesha kitambulisho chako leo. (Ubadilishaji rasmi ni bure chini ya msamaha lakini huchukua wiki kadhaa za kusubiri).';
            } else if (catId === 'birth-certificate') {
              noteEn = 'Cheaper and faster than official Huduma replacement (which costs KES 250 plus travel and queuing time).';
              noteSw = 'Nafuu na haraka kuliko ubadilishaji rasmi wa Huduma (ambao hugharimu KES 250 pamoja na muda wa kusafiri na foleni).';
            } else if (catId === 'driving-licence') {
              noteEn = 'Official NTSA replacement is KES 3,050 plus a police abstract and biometrics appointment (7-14 days). Save KES 2,550+ and get it back today!';
              noteSw = 'Ubadilishaji rasmi wa NTSA ni KES 3,050 pamoja na ripoti ya polisi na uteuzi wa biometriski (siku 7-14). Okoa KES 2,550+ na upate leo!';
            } else if (catId === 'vehicle-logbook') {
              noteEn = 'Official NTSA replacement is KES 2,550 plus police abstract, DCI tape-lift report, and sworn affidavit (painful multi-week process). Save KES 1,750+ and massive hassle.';
              noteSw = 'Ubadilishaji rasmi wa NTSA ni KES 2,550 pamoja na ripoti ya polisi, ripoti ya DCI, na kiapo cha mahakama (mchakato mrefu wa wiki kadhaa). Okoa KES 1,750+ na usumbufu mkubwa.';
            } else if (catId === 'number-plate') {
              noteEn = 'Official NTSA replacement is KES 3,000 single / KES 3,600 pair, plus police abstract and DCI tape-lift report. Save KES 2,300+ to KES 2,900+ and get road-legal today!';
              noteSw = 'Ubadilishaji rasmi wa NTSA ni KES 3,000 kwa moja / KES 3,600 kwa mbili, pamoja na ripoti ya polisi na DCI tape-lift. Okoa KES 2,300+ hadi KES 2,900+ leo!';
            }

            if (!noteEn) return null;

            return (
              <div className="bg-status-success-surface border border-status-success-border rounded-2xl p-4 text-left text-xs flex items-start gap-3 text-status-success">
                <AlertCircle size={18} className="text-accent-orange shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold block mb-1">
                    {'Recovery Benefit'}
                  </span>
                  <p className="font-medium text-ink-muted">
                    {noteEn}
                  </p>
                </div>
              </div>
            );
          })()}

          {/* Escrow Fee breakdown details */}
          {(() => {
            // P14A (P14-03) — THIS BLOCK MUST NEVER FABRICATE A FIGURE.
            //   * The TOTAL prefers the authoritative amount the SERVER pinned to
            //     this claim's payment session (the same value the payer is
            //     actually charged). Only when no session exists yet does it fall
            //     back to the live category's published fee.
            //   * The per-party split is shown ONLY when the live category record
            //     is available, because the server does not return that split to
            //     this surface. Previously a missing category silently produced
            //     "KES 0" for all four lines while the server charged the locked
            //     amount — a fabricated financial figure.
            //   * Anything that cannot be resolved is labelled unavailable, and a
            //     genuine server value of 0 still renders as "KES 0".
            const catRecord = categories.find(c => c.id === selectedItem?.category_id);
            const authoritativeTotal = paymentSessionAmount !== null && Number.isFinite(paymentSessionAmount)
              ? Math.round(paymentSessionAmount)
              : null;
            const totalFee = authoritativeTotal !== null
              ? authoritativeTotal
              : (catRecord ? Math.round(Number(catRecord.total_fee)) : null);
            const finderShare = catRecord ? Math.round(Number(catRecord.finder_share)) : null;
            const agentShare = catRecord ? Math.round(Number(catRecord.agent_share)) : null;
            const platformShare = catRecord ? Math.round(Number(catRecord.platform_share)) : null;
            const money = (value: number | null) =>
              value === null
                ? ('Unavailable')
                : `KES ${value}`;

            return (
              <div className="bg-brand-beige rounded-2xl border border-line-subtle p-5 text-left space-y-3">
                <div className="flex justify-between items-center text-xs font-bold text-ink-muted uppercase tracking-wider">
                  <span>{'Fee breakdown'}</span>
                  <span>{'Amount'}</span>
                </div>
                <div className="h-px bg-line-subtle" />
                <div className="flex justify-between text-sm">
                  <span className="text-ink-muted font-medium">{'Finder Honorarium (Reward)'}</span>
                  <span className="font-mono font-bold text-ink-muted">{money(finderShare)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-ink-muted font-medium">{'Physical Agent Hub Handling'}</span>
                  <span className="font-mono font-bold text-ink-muted">{money(agentShare)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-ink-muted font-medium">{'Return4me platform fee'}</span>
                  <span className="font-mono font-bold text-ink-muted">{money(platformShare)}</span>
                </div>
                <div className="h-px bg-line-subtle" />
                <div className="flex justify-between text-base font-extrabold text-primary-green">
                  <span>{t.releaseFee}</span>
                  <span className="font-mono text-primary-green">{money(totalFee)}</span>
                </div>
              </div>
            );
          })()}

          {/* Checkout triggers */}
          <div className="space-y-3">
            <span className="text-xs text-ink-muted block font-medium">{'Secured M-Pesa Payment'}</span>

            {/* M-Pesa number that will receive the STK Push prompt. The payer may use a
                different valid M-Pesa number than the claim's registered phone
                (eCitizen-style); it is validated here and re-validated by the
                server when the payment session is created. */}
            <div className="bg-brand-beige rounded-2xl border border-line-subtle p-4 text-left space-y-2">
              <label htmlFor="mpesa-payment-phone" className="block text-xs font-bold text-ink-muted uppercase tracking-wider">
                {t.mpesaPhoneLabel}
              </label>
              <input
                id="mpesa-payment-phone"
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                value={payerPhone || ownerPhone}
                onChange={(e) => setPayerPhone(e.target.value)}
                placeholder="e.g. 0712 345 678"
                className="w-full border border-line-subtle rounded-xl px-3 py-3 text-base font-mono bg-white focus:border-accent-orange"
                aria-invalid={(payerPhone || ownerPhone).trim() !== '' && !isValidKenyanPhoneForPayer(payerPhone || ownerPhone)}
              />
              <p className="text-ink-muted text-xs">
                {'Enter the Safaricom number that should receive the payment prompt. You may use a different M-Pesa number than the one registered on the claim — your payment stays securely linked to this claim.'}
              </p>
              {(() => {
                const candidate = (payerPhone || ownerPhone).trim();
                if (candidate === '') {
                  return (
                    <p className="text-ink-muted text-xs">
                      {'Enter an M-Pesa phone number.'}
                    </p>
                  );
                }
                if (!isValidKenyanPhoneForPayer(candidate)) {
                  return (
                    <p className="text-status-danger text-xs font-medium flex items-center gap-1" role="alert">
                      <AlertCircle size={14} className="shrink-0" />
                      <span>{'Enter a valid Kenyan M-Pesa number.'}</span>
                    </p>
                  );
                }
                return (
                  <p className="text-status-success text-xs flex items-center gap-1">
                    <CheckCircle size={14} className="shrink-0" />
                    <span>
                      {'Payment prompt will be sent to this number.'}
                    </span>
                  </p>
                );
              })()}
            </div>

            {errorMsg && (
              <div className="bg-status-danger-surface border border-status-danger-border text-status-danger text-xs rounded-2xl p-4 flex items-start gap-2 text-left">
                <AlertCircle size={16} className="shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}
            {/* The single dominant action of the Pay stage. Disabled state is a
                courtesy mirror of the same Kenyan-number check the server
                re-runs when it creates the session; the server stays the
                authority. */}
            <Button
              onClick={triggerEscrowPayment}
              variant="accent"
              size="lg"
              disabled={!isValidKenyanPhoneForPayer(payerPhone || ownerPhone)}
              loading={isPaying}
              loadingLabel={'Sending the payment prompt'}
              className="w-full"
            >
              {'Send M-Pesa STK Push'}
              <ArrowRight size={18} aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}

      {/* Payment Polling confirmation screen */}
      {verificationStep === 'payment_polling' && (
        <div className="bg-white rounded-2xl border border-line-subtle p-6 md:p-8 shadow-sm max-w-xl mx-auto text-center space-y-6 fade-in">
          <div className="w-14 h-14 bg-orange-50 text-accent-orange rounded-full flex items-center justify-center mx-auto">
            <Loader2 className="animate-spin text-accent-orange" size={28} />
          </div>
          <div>
            <h2 className="text-xl font-extrabold text-primary-green mb-1">
              {'Waiting for M-Pesa Confirmation'}
            </h2>
            <p className="text-ink-muted text-xs">
              {`A payment request has been sent to ${payerPhone || ownerPhone}. Complete the payment on your phone using your M-Pesa PIN. Return4me is waiting for confirmation from the payment provider.`}
            </p>
          </div>

          <div className="bg-brand-beige border border-line-subtle rounded-2xl p-5 text-left text-xs space-y-3 font-medium text-stone-600" role="status" aria-live="polite">
            <div className="flex items-center space-x-2 text-emerald-600">
              <CheckCircle size={16} />
              <span>{'STK Push sent successfully'}</span>
            </div>
            <div className="flex items-center space-x-2 text-stone-500">
              <Loader2 className="animate-spin text-accent-orange shrink-0" size={14} />
              <span>{'Waiting for PIN and payment authorization...'}</span>
            </div>
            <div className="flex items-center space-x-2 text-stone-400">
              <Lock size={14} className="opacity-40 shrink-0" />
              <span>{'Payment receipt'}</span>
            </div>
          </div>

          {errorMsg && (
            <div className="bg-status-danger-surface border border-status-danger-border text-status-danger text-xs rounded-2xl p-4 flex items-start gap-2 text-left">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="space-y-3 pt-2">
            <Button
              onClick={checkPaymentStatus}
              variant="accent"
              size="lg"
              disabled={isPaying}
              className="w-full"
            >
              {'Check payment status'}
            </Button>

            <Button
              onClick={triggerEscrowPayment}
              variant="secondary"
              size="md"
              loading={isPaying}
              loadingLabel={'Sending the payment prompt'}
              className="w-full"
            >
              {"Didn't get the prompt? Resend"}
            </Button>

            {/* Documented exception: the local test-mode simulator is
                deliberately NOT the shared Button. It is not a brand action,
                it is gated on /api/dev/test-mode so it never reaches
                production, and it must stay visibly a test affordance. */}
            {testModeEnabled && (
              <button
                onClick={simulatePaymentSuccess}
                disabled={isPaying}
                className="w-full bg-status-warning-surface hover:bg-status-warning-surface/70 text-status-warning py-3 rounded-2xl font-bold text-xs transition cursor-pointer disabled:opacity-50 border border-dashed border-status-warning-border"
              >
                {'Simulate Payment Success (test mode only)'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Physical pickup handover success */}
      {verificationStep === 'handover_success' && (
        <div className="bg-white rounded-2xl border border-line-subtle p-6 md:p-8 shadow-sm max-w-xl mx-auto text-center space-y-6 fade-in">
          <div className="w-16 h-16 bg-status-success-surface text-status-success rounded-full flex items-center justify-center mx-auto">
            <CheckCircle size={36} />
          </div>
          <div>
            <h2 className="text-2xl font-extrabold text-primary-green mb-1">{t.paymentSuccess}</h2>
            <p className="text-ink-muted text-xs">{t.collectionInstructions}</p>
          </div>

          {/* Collection Agent Coordinates card. Phase 7C.5 (F8): rendered from
              the explicit pickup-details state, so "no hub assigned", "claim no
              longer eligible" and a failed refresh are each visible and
              distinct — and "Fetching..." only ever appears while a real
              request is in flight. */}
          <div className="bg-brand-beige p-5 rounded-2xl text-left border border-line-subtle space-y-2">
            <h3 className="text-caption font-extrabold text-ink-muted uppercase tracking-widest">{'Pickup physical agent point'}</h3>
            <PickupDetailsPanel
              state={pickupDetails}
              showDirections
              onRetry={retryPickupDetails}
            />
          </div>

          {/* Claim reference — this identifies your claim if you need to look
              it up again, but it is NOT the secret code the agent asks for. */}
          <div className="bg-canvas-muted text-ink-muted p-4 rounded-2xl space-y-1">
            <span className="text-caption font-bold uppercase tracking-widest text-ink-muted">
              {'Claim Reference (not a secret code)'}
            </span>
            <div className="text-lg font-mono font-bold tracking-wider text-ink-muted">
              {paidClaim.id}
            </div>
            <p className="text-caption text-ink-muted">
              {'Use this if you need to look up your claim status later.'}
            </p>
          </div>

          {/* The actual secret pickup code — this is what the agent needs */}
          <div className="bg-primary-green text-white p-5 rounded-2xl space-y-1">
            <span className="text-caption font-bold uppercase tracking-widest text-stone-300">{t.collectionCode}</span>
            {simulatedPickupCode ? (
              <div className="text-2xl font-mono font-extrabold tracking-wider text-accent-orange">
                {simulatedPickupCode}
              </div>
            ) : (
              <p className="text-sm text-stone-100 font-semibold">
                {'We\'ve sent your secret 6-digit code. Look for an email from Return4me.'}
              </p>
            )}
            <p className="text-caption text-stone-300">
              {'Give this secret code to the Agent ONLY when collecting your item.'}
            </p>

            {/* P1 (B-2) — recovery action.
                The server never returns the plaintext pickup code, and this UI
                deliberately never displays one returned by the API: there is
                nothing to show. What it does offer is a way to ask the server to
                send a FRESH code, because the original may never have arrived.
                That new code invalidates the previous one, which is stated
                explicitly before the request is made. */}
            <div className="pt-2 border-t border-white/15">
              <Button
                type="button"
                variant="inverse"
                size="sm"
                onClick={requestPickupCodeResend}
                loading={pickupCodeResendState.status === 'sending'}
                loadingLabel={'Sending a new pickup code'}
              >
                {'Resend my pickup code'}
              </Button>
              <p className="text-caption text-stone-300 mt-2">
                {'Requesting a new code immediately invalidates the previous one.'}
              </p>
              {pickupCodeResendState.status === 'sent' && (
                <p role="status" className="text-caption font-bold text-accent-orange mt-2">
                  {'A new code has been sent to your email address. Look for an email from Return4me.'}
                </p>
              )}
              {pickupCodeResendState.status === 'error' && (
                <p role="alert" className="text-caption font-bold text-stone-100 mt-2">
                  {pickupCodeResendState.message
                    ? pickupCodeResendState.message
                    : 'We could not send a code right now. Your existing code is unchanged — please try again shortly.'}
                </p>
              )}
            </div>
          </div>

          {simulatedPickupCode && (
            <div className="bg-status-warning-surface border border-dashed border-status-warning-border text-status-warning p-3 rounded-xl text-caption font-bold">
              {'Test mode: this code is shown here because real email isn\'t sent during local testing.'}
            </div>
          )}

          {/* Save-this-code warning */}
          <div className="bg-status-warning-surface border border-status-warning-border text-status-warning p-4 rounded-2xl text-left flex items-start gap-3">
            <AlertTriangle size={20} className="shrink-0 mt-0.5 text-status-warning" />
            <div className="text-xs space-y-1">
              <p className="font-extrabold">
                {'IMPORTANT: Write down or screenshot this code now.'}
              </p>
              <p className="text-status-warning">
                {'You must give this exact secret code to the agent in person to collect your item. Losing it may delay your pickup — check your email again if you need to retrieve it.'}
              </p>
            </div>
          </div>

          {/* Post Pickup Rating flow */}
          <div className="border-t border-line-subtle pt-5 space-y-3">
            <h4 className="text-xs font-extrabold text-primary-green uppercase tracking-wider">{t.rateAgentLabel}</h4>
            {ratingSubmitted ? (
              <span className="text-xs text-status-success font-bold block">{'Thank you for supporting community trust in Kenya!'}</span>
            ) : (
              <div className="flex items-center justify-center space-x-2">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => submitRating(star)}
                    aria-label={('Rate ' + star + ' out of 5')}
                    className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-stone-300 hover:text-accent-orange transition rounded-small cursor-pointer"
                  >
                    <div
                      className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-extrabold ${userRating && userRating >= star ? 'bg-accent-strong text-white' : 'bg-line-subtle text-ink-muted'}`}
                    >
                      {star}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <Button
            variant="secondary"
            size="lg"
            className="w-full"
            onClick={() => {
              setVerificationStep('search');
              setSelectedItem(null);
              setPaidClaim(null);
              setOwnerPhone('');
              setOtpCode('');
              setRatingSubmitted(false);
              setUserRating(null);
              setOwnerIdentifyingDetails('');
              setIsConfident(false);
              handleSearch(); // Refresh lists
            }}
          >
            {'Go Back to Search'}
          </Button>
        </div>
      )}

      {/* Awaiting agent in-person verification step */}
      {verificationStep === 'awaiting_agent_confirmation' && (
        <div className="bg-white rounded-2xl border border-line-subtle p-6 md:p-8 shadow-sm max-w-xl mx-auto space-y-6 text-center fade-in">
          <div className="w-14 h-14 bg-status-warning-surface text-status-warning rounded-full flex items-center justify-center mx-auto animate-pulse">
            <Eye size={28} />
          </div>
          <div>
            <h2 className="text-xl font-extrabold text-primary-green mb-1">
              {'Physical Viewing Verification Required'}
            </h2>
            <p className="text-ink-muted text-xs">
              {'Your ownership claim code is approved! Now, you must visit the agent physical hub to visually inspect your item. The agent will confirm you have viewed and verified the item before payment is requested.'}
            </p>
          </div>

          {/* Render strike warning if present */}
          {strikeWarning && (
            <div className="bg-status-warning-surface border border-status-warning-border text-status-warning px-4 py-3 rounded-2xl text-xs text-left flex items-start gap-2">
              <AlertTriangle size={18} className="shrink-0 mt-0.5" />
              <span>{strikeWarning}</span>
            </div>
          )}

          {/* Phase 7B.2: surface the polling state instead of failing silently.
              This step previously rendered no error surface at all, so a paused
              (throttled) poller looked identical to a healthy waiting one. */}
          {errorMsg && (
            <div
              className="bg-status-danger-surface border border-status-danger-border text-status-danger text-xs rounded-2xl p-4 flex items-start gap-2 text-left"
              role="alert"
            >
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Hub pickup location — Phase 7C.5 (F8): this step now actually
              requests the pickup details (the step effect above) and renders
              the explicit request state. It previously showed a static
              placeholder while making no request at all. */}
          <div className="bg-brand-beige rounded-2xl border border-line-subtle p-5 text-left space-y-3">
            <span className="text-caption font-extrabold text-ink-muted uppercase tracking-widest block">
              {'Hub Location / Mahali pa Wakala'}
            </span>
            <PickupDetailsPanel
              state={pickupDetails}
              onRetry={retryPickupDetails}
            />
          </div>

          <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-4 text-xs text-left text-primary-green flex items-start space-x-2" role="status" aria-live="polite">
            <Loader2 className="animate-spin text-primary-green shrink-0 mt-0.5" size={16} />
            <p className="font-medium text-ink-muted">
              {'Waiting for the agent to visually verify you have inspected the item... Keep this page open.'}
            </p>
          </div>
        </div>
      )}

      {/* Payment window expired step */}
      {verificationStep === 'payment_window_expired' && (
        <div className="bg-white rounded-2xl border border-line-subtle p-6 md:p-8 shadow-sm max-w-xl mx-auto space-y-6 text-center fade-in">
          <div className="w-14 h-14 bg-status-danger-surface text-status-danger rounded-full flex items-center justify-center mx-auto">
            <XCircle size={28} />
          </div>
          <div>
            <h2 className="text-xl font-extrabold text-status-danger mb-1">
              {'Payment Window Expired'}
            </h2>
            <p className="text-ink-muted text-xs">
              {`Your ${CLAIM_PAYMENT_WINDOW_LABEL} payment window has expired. For security and fairness, the item has been unlocked for other potential claimants, and a strike has been recorded against your phone number. Repeated strikes will restrict you from making future claims.`}
            </p>
          </div>

          {/* One action, and it is not a repair: the window is closed, the item
              is unlocked and the strike is recorded, so the only thing the
              claimant can do is leave. It is the lowest-emphasis shared
              control on purpose — nothing here should read as "try again". */}
          <Button
            variant="ghost"
            size="md"
            className="w-full"
            onClick={() => {
              setVerificationStep('search');
              setSelectedItem(null);
              setPaidClaim(null);
              setOwnerPhone('');
              setOtpCode('');
              setRatingSubmitted(false);
              setUserRating(null);
              setOwnerIdentifyingDetails('');
              setIsConfident(false);
            }}
          >
            {'Back to Search'}
          </Button>
        </div>
      )}

      {/* TRACK MY CLAIM MODAL — rendered only for a live customer session. The
          server enforces the same boundary (requireCustomerAuth on
          POST /api/claims/lookup), so this is defence in depth rather than the
          control itself: a stale open state can never reach the endpoint. */}
      {showTrackModal && isSignedIn && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowTrackModal(false);
          }}
        >
          <div
            className="bg-white rounded-2xl p-6 md:p-8 max-w-lg w-full max-h-[90vh] overflow-y-auto space-y-5 shadow-sm relative border border-line-subtle"
            role="dialog"
            ref={trackModalRef}
            tabIndex={-1}
            aria-modal="true"
            aria-label={'Track My Claim'}
          >
            <div className="flex items-center justify-between border-b border-line-subtle pb-3">
              <h3 className="text-xl font-extrabold text-primary-green flex items-center gap-2">
                <Clock size={20} className="text-accent-orange" />
                <span>{'Track My Claim'}</span>
              </h3>
              <button
                type="button"
                onClick={() => setShowTrackModal(false)}
                className="text-ink-muted hover:text-brand-dark-text font-bold text-lg cursor-pointer px-2 py-1 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg hover:bg-brand-light-gray"
                aria-label={'Close'}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            {trackError && (
              <div className="bg-status-danger-surface border border-status-danger-border text-status-danger px-4 py-3 rounded-xl text-xs flex items-center gap-2">
                <AlertCircle size={16} className="shrink-0" />
                <span>{trackError}</span>
              </div>
            )}

            <form onSubmit={async (e) => {
              e.preventDefault();
              setTrackError('');
              setTrackResult(null);
              setTrackLoading(true);
              try {
                const res = await fetch('/api/claims/lookup', {
                  method: 'POST',
                  // PHASE 16 — the customer session is an httpOnly cookie
                  // (services/customerAuth.ts) and the route now requires it.
                  credentials: 'same-origin',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ claimId: trackClaimId, phone: trackPhone }),
                });
                const data = await res.json();
                if (!res.ok) {
                  throw new Error(data.error || 'Claim lookup failed');
                }
                setTrackResult(data);
              } catch (err: any) {
                setTrackError(err.message);
              } finally {
                setTrackLoading(false);
              }
            }} className="space-y-4">
              
              <div className="space-y-1">
                <label htmlFor="track-claim-id" className="block text-xs font-bold text-primary-green uppercase tracking-wider">
                  Claim ID / Msimbo wa Ombi *
                </label>
                <input
                  id="track-claim-id"
                  type="text"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  value={trackClaimId}
                  onChange={(e) => setTrackClaimId(e.target.value)}
                  placeholder="e.g. CLM-482913"
                  className="w-full border border-line-subtle rounded-xl px-3 py-2.5 text-sm font-mono uppercase bg-brand-beige"
                  required
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="track-phone" className="block text-xs font-bold text-primary-green uppercase tracking-wider">
                  Phone Number Used / Nambari ya Simu *
                </label>
                <input
                  id="track-phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={trackPhone}
                  onChange={(e) => setTrackPhone(e.target.value)}
                  placeholder="e.g. 0712345678"
                  className="w-full border border-line-subtle rounded-xl px-3 py-2.5 text-sm font-mono bg-brand-beige"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={trackLoading}
                className="w-full bg-accent-strong hover:bg-accent-strong-hover text-white py-3 rounded-xl font-bold text-sm transition flex items-center justify-center space-x-2 cursor-pointer disabled:opacity-50"
              >
                {trackLoading ? (
                  <Loader2 className="animate-spin" size={18} />
                ) : (
                  <span>{'Look Up Claim Status'}</span>
                )}
              </button>
            </form>

            {/* Render Lookup Result */}
            {trackResult && (
              <div className="mt-4 bg-canvas-muted border border-line-subtle p-4 rounded-2xl space-y-3 fade-in text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-extrabold text-ink-muted">{'Status:'}</span>
                  <span className={`${getClaimStatusDisplay(trackResult.claim.status).className} px-2.5 py-1 rounded-full font-bold uppercase tracking-wider text-caption`}>
                    {getClaimStatusDisplay(trackResult.claim.status).label}
                  </span>
                </div>

                {trackResult.item && (
                  <div className="space-y-1 border-t border-line-subtle pt-2">
                    <p className="font-bold text-primary-green text-sm">{trackResult.item.document_name_fuzzy || ('Found Item')}</p>
                    <p className="text-ink-muted">{'Location:'} {trackResult.item.location_description}</p>
                  </div>
                )}

                {trackResult.agent && (
                  <div className="bg-white p-3 rounded-xl border border-line-subtle space-y-1">
                    <p className="font-bold text-ink">{'Assigned Agent Hub:'}</p>
                    <p className="text-primary-green font-extrabold">{trackResult.agent.business_name}</p>
                    <p className="text-ink-muted">{trackResult.agent.location_address}</p>
                    <p className="text-ink-muted font-mono">{trackResult.agent.contact_phone}</p>
                  </div>
                )}

                {trackResult.claim.collection_code && (
                  <div className="bg-status-success-surface border border-status-success-border p-3 rounded-xl text-center">
                    <p className="text-caption text-status-success uppercase font-bold tracking-widest">{'Collection Verification Code'}</p>
                    <p className="text-2xl font-mono font-black text-primary-green tracking-widest mt-0.5">{trackResult.claim.collection_code}</p>
                  </div>
                )}

                {/* Resume into the real flow based on actual claim status — this is the
                    action step; the panel above is informational only. */}
                {['awaiting_agent_confirmation', 'pending_payment', 'payment_window_expired', 'escrow_held', 'released'].includes(trackResult.claim.status) ? (
                  <button
                    type="button"
                    onClick={() => {
                      // Phase 7C.7 (R3): carry the phone the caller just proved in
                      // this lookup into the claim-flow phone state. The resumed
                      // claim's pickup-details request reads ownerPhoneRef (which
                      // mirrors ownerPhone), while the Track flow kept its phone in
                      // separate state — so a Track-resumed claim used to send an
                      // EMPTY phone and could never load its hub details. This
                      // reuses the existing single source of truth instead of
                      // adding a second one, and the server still re-verifies the
                      // phone against the claim on every pickup-details call.
                      setOwnerPhone(trackPhone.trim());
                      const resumedItem = trackResult.item
                        ? { ...trackResult.item, agent: trackResult.agent || undefined }
                        : null;
                      setSelectedItem(resumedItem);
                      setPaidClaim(trackResult.claim);

                      if (trackResult.claim.status === 'awaiting_agent_confirmation') {
                        setVerificationStep('awaiting_agent_confirmation');
                        startAwaitingAgentPolling(trackResult.claim.id);
                      } else if (trackResult.claim.status === 'pending_payment') {
                        setVerificationStep('payment');
                      } else if (trackResult.claim.status === 'payment_window_expired') {
                        setVerificationStep('payment_window_expired');
                      } else if (trackResult.claim.status === 'escrow_held' || trackResult.claim.status === 'released') {
                        setVerificationStep('handover_success');
                      }
                      setShowTrackModal(false);
                    }}
                    className="w-full bg-primary-green hover:bg-primary-hover text-white py-3 rounded-xl font-bold text-sm transition flex items-center justify-center space-x-2 cursor-pointer"
                  >
                    <span>
                      {trackResult.claim.status === 'pending_payment'
                        ? ('Continue to Payment')
                        : ('Continue to My Claim')}
                    </span>
                    <ArrowRight size={16} />
                  </button>
                ) : (
                  <p className="text-ink-muted italic text-center pt-1">
                    {trackResult.claim.status === 'refunded'
                      ? ('You lost this dispute, but your original payment has been fully refunded to your M-Pesa. Check your M-Pesa messages for confirmation.')
                      : trackResult.claim.status === 'refunding'
                      ? ('The dispute has been decided and your refund is currently being processed. You will receive an M-Pesa confirmation shortly.')
                      : trackResult.claim.status === 'disputed'
                      ? ('Another person has also claimed this item. Our admin team is reviewing the evidence and will be in touch soon.')
                      : trackResult.claim.status === 'rejected'
                      ? ('This claim was not approved. If you believe this is a mistake, please contact support.')
                      : ('This claim cannot be resumed here right now. Contact support if you need further help.')}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
