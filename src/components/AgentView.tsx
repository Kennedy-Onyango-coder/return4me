import React, { useState, useEffect, useRef } from 'react';
import { translations } from '../types';
import ClaimVerificationEvidence from './ClaimVerificationEvidence';
import { getClaimStatusDisplay, agentClaimBadge } from './claimStatus';
import AgentHub from './agent/AgentHub';
import { ShieldCheck, Plus, CheckCircle, PackageOpen, HelpCircle, Loader2, ArrowRight, AlertCircle, Phone, Lock, Eye, Camera, Upload } from 'lucide-react';

interface AgentViewProps {
  lang: 'en' | 'sw';
  token: string | null;
  setToken: (token: string | null) => void;
  /**
   * PHASE 16.1 BATCH 3 (H-1 / M-6) — THE APP-LEVEL CATEGORY SOURCE.
   *
   * AgentView used to keep a SECOND, private copy of the category list: its own
   * mount-only `fetch('/api/categories')` (built in the Phase 9 verification
   * work, before App owned one). That made two independent owners of the same
   * data, and the private copy was never refreshed — so a category an
   * administrator had just created was missing from the verification panel's
   * selector, and one they had just deactivated stayed selectable, until a full
   * page reload.
   *
   * App.fetchCategories (Phase 16.1 Batch 1A) is the single category source:
   * same endpoint, same 4-attempt retry, same loading/error handling, and it is
   * already re-run after every successful admin category mutation via
   * AdminView's `onCategoriesChanged`. AgentView now READS that state instead of
   * fetching its own, so the agent sees exactly the list the rest of the app
   * sees. `/api/categories` remains the only category endpoint — nothing is
   * cached and no second list is introduced.
   */
  categories: any[];
  /**
   * The same App-level refresh callback AdminView receives as
   * `onCategoriesChanged` (NOT a new endpoint or a second fetch definition).
   * AgentView calls it when the Agent opens an item for review, so the
   * selector reflects the catalogue at the moment of use rather than whenever
   * the app last happened to load it. Optional so the component still renders
   * for any caller that only has data to pass.
   */
  refreshCategories?: () => void;
}

/**
 * PHASE 16.1 BATCH 3 (F-4) — TRUTHFUL AGENT-SIDE CLAIM BADGE.
 * Implementation lives in ./claimStatus (neutral module) so the extracted
 * AgentHub can share it without importing this view. Re-exported here so
 * existing import sites keep working.
 */
export { agentClaimBadge } from './claimStatus';

export default function AgentView({ lang, token, setToken, categories, refreshCategories }: AgentViewProps) {
  const t = translations[lang];

  // Auth States
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [showOtp, setShowOtp] = useState(false);

  // AUTHENTICATION errors only — rendered inside the signed-out card below.
  //
  // PHASE 16.1 BATCH 3 (F-1): this value used to be the sink for OPERATIONAL
  // failures too (reject drop-off, confirm viewing, confirm handover, camera
  // denial, and the drop-off code lookup). None of those are authentication
  // problems, and all of them happen while the agent is signed IN — where this
  // branch is not rendered at all, so the agent saw a spinner stop and nothing
  // else. Those failures now go to `operationError` below.
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // OPERATIONAL (post-sign-in) error channel — see F-1 above.
  //
  // Rendered inside the authenticated Agent Hub, and only there. Cleared at the
  // start of every operation so a stale message can never be mistaken for the
  // result of the action the agent just took.
  const [operationError, setOperationError] = useState('');

  // Application/Registration form states
  const [isRegistering, setIsRegistering] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [locationAddress, setLocationAddress] = useState('');
  const [payoutMethodType, setPayoutMethodType] = useState('Till Number');
  const [tillNumber, setTillNumber] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [shopPhotoBase64, setShopPhotoBase64] = useState<string | null>(null);
  const [idDocumentPhotoBase64, setIdDocumentPhotoBase64] = useState<string | null>(null);
  const [agreedTerms, setAgreedTerms] = useState(false);

  // Agent Queue States
  //
  // PHASE 16.1 BATCH 3 (F-5 / H-3) — `agentStatus` AND request failure are now
  // SEPARATE concerns.
  //
  // `agentStatus` used to be overwritten with 'pending' for ANY non-OK queue
  // response, which turned a transient 500, a dropped connection, or an expired
  // session into the "Vetting Pending" screen — i.e. the UI asserted an
  // account-status change that the server never reported. It is now only ever
  // ADVANCED to 'active' by a definitive 2xx, and is never REGRESSED by a
  // failure. The initial 'pending' value remains the honest "no definitive
  // answer yet" state.
  //
  // `queueError` carries the failure text instead, and `queueLoading` marks the
  // in-flight window so the pre-answer render is a loading state rather than a
  // claim about the account.
  const [agentStatus, setAgentStatus] = useState<string>('pending');
  const [queueError, setQueueError] = useState('');
  const [queueLoading, setQueueLoading] = useState(false);
  const [expectedDropoffs, setExpectedDropoffs] = useState<any[]>([]);
  const [holdingPickups, setHoldingPickups] = useState<any[]>([]);
  const [agentProfile, setAgentProfile] = useState<any | null>(null);
  const [agentEarnings, setAgentEarnings] = useState<{ totalEarned: number; completedPayoutsCount: number } | null>(null);

  // Modal / Inputs
  const [dropoffCodeInput, setDropoffCodeInput] = useState('');
  // PHASE 16.1 BATCH 3 (F-2) — `handoverCodeInput` was REMOVED here.
  //
  // It backed a "Enter Handover Code (CLM-...)" text box in the held-items
  // card, but no handler ever read the value: the real handover action collects
  // the OWNER'S secret pickup code inside `pickupCodeModal` (below) and posts it
  // to /api/agents/confirm-handover. The state and its input were dead UI, so
  // both are gone. No handover API semantics changed — see submitConfirmHandover.
  const [actionSuccessMsg, setActionSuccessMsg] = useState('');

  // Item verification/correction panel — the Agent reviews the Finder's
  // original submission before physically approving it. Confirming as
  // reported or saving a correction both go through the same
  // /api/agents/verify-item call; approving only proceeds to
  // /api/agents/confirm-dropoff once verification (and, for a sensitive
  // item's identity fields, physical verification) is complete — enforced
  // server-side, not just by this UI's button order.
  const [verifyingItemId, setVerifyingItemId] = useState<string | null>(null);
  const [verifyCategoryId, setVerifyCategoryId] = useState('');
  const [verifyName, setVerifyName] = useState('');
  const [verifyDocNumber, setVerifyDocNumber] = useState('');
  const [verifyDescription, setVerifyDescription] = useState('');
  const [verifyFoundArea, setVerifyFoundArea] = useState('');
  const [verifyPhysicallyChecked, setVerifyPhysicallyChecked] = useState(false);
  const [verifyReason, setVerifyReason] = useState('Finder entered wrong information');
  const [verifyReasonDetail, setVerifyReasonDetail] = useState('');
  const [verifyError, setVerifyError] = useState('');

  // PHASE 16.1 BATCH 3 (H-1 / M-6) — the private category list and its
  // mount-only fetch were REMOVED here.
  //
  // They were:
  //   const [categories, setCategories] = useState<any[]>([]);
  //   useEffect(() => {
  //     fetch('/api/categories').then(r => r.json()).then(setCategories).catch(() => {});
  //   }, []);
  //
  // ...i.e. a second owner of data App already owns, fetched once and never
  // refreshed. `categories` now arrives as a PROP from App's single category
  // state, so the verification selector shows exactly the active list the rest
  // of the app uses, and it participates in the existing admin-refresh path
  // (AdminView.onCategoriesChanged → App.fetchCategories) instead of keeping a
  // frozen snapshot.

  const openVerificationPanel = (item: any) => {
    // Refresh the shared category list at the moment of use, through the
    // EXISTING App-level fetch (the same callback AdminView receives). This is
    // a read of the one category source, not a second one: it guarantees a
    // category created — or deactivated — since the last app-level load is
    // reflected in the selector below. Fire-and-forget: the panel still opens
    // immediately with the list currently in hand.
    refreshCategories?.();
    setVerifyingItemId(item.id);
    setVerifyCategoryId(item.category_id || '');
    setVerifyName(item.ocr_extracted_name || '');
    setVerifyDocNumber(item.ocr_extracted_number || '');
    setVerifyDescription(item.description || '');
    setVerifyFoundArea(item.location_description || '');
    setVerifyPhysicallyChecked(false);
    setVerifyReason('Finder entered wrong information');
    setVerifyReasonDetail('');
    setVerifyError('');
    setActionSuccessMsg('');
  };

  const hasCorrections = (item: any) => {
    if (!item) return false;
    return (
      verifyCategoryId !== (item.category_id || '') ||
      verifyName !== (item.ocr_extracted_name || '') ||
      verifyDocNumber !== (item.ocr_extracted_number || '') ||
      verifyDescription !== (item.description || '') ||
      verifyFoundArea !== (item.location_description || '')
    );
  };

  // Submits verification/correction, then — only if the Agent has
  // checked "physically verified" — immediately proceeds to
  // confirm-dropoff in the same action. This combines the design brief's
  // separate "verify" and "approve & accept" steps into one button when
  // the Agent has already looked at the item; if they haven't checked
  // the physical-verification box, this only saves the correction and
  // leaves the item in the queue for them to come back and approve once
  // they've actually inspected it.
  const handleSubmitVerification = async (item: any, outcome: 'confirmed' | 'corrected') => {
    setVerifyError('');
    setActionSuccessMsg('');
    setActionProcessing(true);
    // BATCH 4B-1 (B3): this action belongs to ONE drop-off item, so only that
    // card's controls go busy while the request is in flight.
    setProcessingItemId(item?.id ?? null);

    const changed = hasCorrections(item);
    if (outcome === 'corrected' && !changed) {
      setVerifyError(lang === 'en' ? 'No fields were actually changed — use "Confirm As Reported" instead, or edit a field first.' : 'Hakuna sehemu iliyobadilishwa — tumia "Thibitisha Kama Ilivyoripotiwa", au badilisha sehemu kwanza.');
      finishProcessing();
      return;
    }

    try {
      const verifyResponse = await fetch('/api/agents/verify-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          dropoffCode: item.id,
          categoryId: verifyCategoryId,
          name: item.is_sensitive_document ? (verifyName || null) : null,
          documentNumber: item.is_sensitive_document ? (verifyDocNumber || null) : null,
          description: verifyDescription || null,
          foundArea: verifyFoundArea,
          reason: changed ? verifyReason : '',
          reasonDetail: changed ? (verifyReasonDetail || null) : null,
          physicallyVerified: verifyPhysicallyChecked,
        }),
      });
      const verifyData = await verifyResponse.json();
      if (!verifyResponse.ok) {
        throw new Error(verifyData.error || 'Verification failed');
      }

      if (!verifyPhysicallyChecked) {
        // Correction/confirmation saved, but the Agent hasn't physically
        // inspected the item yet — leave it in the queue rather than
        // approving it now.
        setActionSuccessMsg(lang === 'en' ? 'Saved. Physically inspect the item, then check the box and confirm to approve it.' : 'Imehifadhiwa. Kagua bidhaa kimwili, kisha weka alama kwenye kisanduku na uthibitishe ili kuikubali.');
        setVerifyingItemId(null);
        fetchQueues();
        finishProcessing();
        return;
      }

      // Physically verified — proceed straight to approval.
      const approveResponse = await fetch('/api/agents/confirm-dropoff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ dropoffCode: item.id }),
      });
      const approveData = await approveResponse.json();
      if (!approveResponse.ok) {
        throw new Error(approveData.error || 'Approval failed');
      }

      setActionSuccessMsg(approveData.message);
      setVerifyingItemId(null);
      fetchQueues();
    } catch (e: any) {
      setVerifyError(e.message);
    } finally {
      finishProcessing();
    }
  };

  // Rejection States
  const [rejectingItemId, setRejectingItemId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState<string>("Not a real item");
  const [rejectionCustomText, setRejectionCustomText] = useState<string>("");

  // Action Loading State
  const [actionProcessing, setActionProcessing] = useState(false);

  // PHASE 16.1 BATCH 4B-1 (B3) - THE PER-ITEM BUSY IDENTITY.
  //
  // `actionProcessing` above is a single global flag, so while ONE card's action
  // was in flight every card in the Hub was disabled AND every action button
  // showed a spinner - a slow handover greyed out an unrelated drop-off, and a
  // drop-off verification greyed out every held item. This state records WHICH
  // record's action is actually running, and the Hub (which stays presentational
  // and hook-free) receives it as `processingItemId`:
  //   * drop-off actions (verify/correct, reject)     -> the drop-off code (item.id)
  //   * held-item actions (confirm viewing, handover) -> the claim id
  // R4M- drop-off codes and CLM- claim ids are disjoint namespaces, so a single
  // field is unambiguous across the two queues.
  //
  // `actionProcessing` is deliberately KEPT rather than replaced: the
  // modal-driven operations (confirm-viewing, handover submission) still use it,
  // it is what Batch 3's `aria-busy={actionProcessing}` anchor reflects, and it
  // remains the broad "an operation is in flight" flag. Neither flag authorizes
  // anything - the server's ownership guards, the claim-status CAS in
  // transitionClaimStatus, and the pickup-code check remain the authoritative
  // protections against a duplicate or unauthorized submission.
  const [processingItemId, setProcessingItemId] = useState<string | null>(null);

  // Single exit point for "no action is running any more": the global flag and
  // the per-item identity are always cleared together, so a card cannot be left
  // permanently busy by clearing one and forgetting the other.
  const finishProcessing = () => {
    setActionProcessing(false);
    setProcessingItemId(null);
  };

  // Confirmation Modal State
  //
  // PHASE 16.1 BATCH 3 (F-6) — `onConfirm` now RESOLVES TO A BOOLEAN so the
  // modal can tell success from failure. It used to be `() => void` and the
  // Confirm button fire-and-forgot it while unconditionally closing the modal,
  // so the dialog vanished before the request had even failed. The dialog now
  // stays open on failure (the Hub's operational error channel explains why) and
  // closes only once the action reports success. The server-side CAS in
  // transitionClaimStatus remains the authoritative duplicate-submission
  // protection; `modalBusy` below is a UX guard only.
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    onConfirm: () => Promise<boolean>;
  } | null>(null);
  const [modalBusy, setModalBusy] = useState(false);

  // Handover Pickup Code Modal State — collects the owner's secret pickup
  // code and a handover evidence photo before /api/agents/confirm-handover
  // is called.
  const [pickupCodeModal, setPickupCodeModal] = useState<{
    claimId: string;
    code: string;
    photoBase64: string | null;
  } | null>(null);
  const handoverPhotoInputRef = useRef<HTMLInputElement>(null);
  const [useHandoverCamera, setUseHandoverCamera] = useState(false);
  const handoverVideoRef = useRef<HTMLVideoElement | null>(null);
  const handoverCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // ---------------------------------------------------------------------------
  // PHASE 16.1 BATCH 3 (A-8) — DIALOG SEMANTICS, ESCAPE AND FOCUS.
  //
  // Both modals are real blocking dialogs, but until now they were plain
  // <div>s: no role, no accessible name, no focus move into the dialog, no
  // Escape handling and no focus restoration on close. A keyboard or
  // screen-reader user could be left focused on the page behind the overlay.
  //
  // This is deliberately ONE small effect shared by both existing modals
  // rather than a new (third) modal primitive — extraction is a later batch.
  // Capture order matters: the element focused BEFORE the dialog opened is
  // remembered and restored on close, so a keyboard user returns to the control
  // they activated rather than to the top of the document.
  // ---------------------------------------------------------------------------
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const anyModalOpen = Boolean(confirmModal || pickupCodeModal);

  useEffect(() => {
    if (!anyModalOpen) return;

    previouslyFocusedRef.current = (typeof document !== 'undefined'
      ? (document.activeElement as HTMLElement | null)
      : null);

    // Move focus into the dialog itself (tabIndex={-1} on the panel), which is
    // the least surprising option when neither modal has a single obvious first
    // field. The pickup-code input keeps its own autoFocus.
    dialogRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Closing is a pure dismissal: no request is sent, so this cannot
        // bypass or duplicate the server-side work. `modalBusy` is respected so
        // Escape cannot dismiss a dialog whose action is still in flight.
        if (modalBusy) return;
        setConfirmModal(null);
        setPickupCodeModal(null);
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [anyModalOpen, modalBusy]);

  // Fetch Agent Queues on Token availability.
  //
  // PHASE 16.1 BATCH 3 (F-5 / H-3) — a FAILED REQUEST NO LONGER CLAIMS THE
  // AGENT BECAME PENDING.
  //
  // Before: any non-OK response ran `setAgentStatus('pending')`, so a 500, a
  // dropped connection, or an expired session replaced the whole Hub with the
  // "Vetting Pending" screen — the UI asserted an account-status change the
  // server never reported. Note that BOTH of this route's guards can answer
  // 403 (`authenticateJWT` returns 403 for an EXPIRED session; `requireActiveAgent`
  // returns 403 for a non-actionable agent), so a status code alone could never
  // justify asserting a vetting state.
  //
  // Now: `agentStatus` is advanced to 'active' ONLY by a definitive 2xx and is
  // never regressed by a failure. Every failure lands in `queueError` instead.
  // The server stays the sole authority on whether this agent may act — nothing
  // here grants or withholds anything; it only stops the UI from inventing a
  // status. `queueLoading` marks the in-flight window so the pre-answer render
  // is a loading state rather than a claim about the account.
  const fetchQueues = async () => {
    if (!token) return;
    setQueueLoading(true);
    try {
      const response = await fetch('/api/agents/queue', {
        headers: { Authorization: `Bearer ${token}` },
      });

      // A non-JSON body (a proxy error page, a truncated response) must not
      // throw out of the failure handling below.
      let data: any = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (!response.ok) {
        // Preferred message: the server's own explanation, when it supplied
        // one. Both guards' 403/401 bodies are deliberately user-facing,
        // bilingual copy (e.g. "Akaunti yako ya Agent bado haijaidhinishwa au
        // imesitishwa." / "Muda wako wa kuingia umeisha. Tafadhali ingia
        // tena."), so surfacing it tells the agent the real reason instead of a
        // invented one. Never the raw status code or an internal detail.
        const serverMessage = typeof data?.error === 'string' && data.error.trim() ? data.error.trim() : '';
        setQueueError(serverMessage || (lang === 'en'
          ? "We couldn't load your agent hub just now. Please try again."
          : 'Imeshindwa kupakia ukurasa wako wa wakala sasa. Tafadhali jaribu tena.'));
        return;
      }

      setQueueError('');
      setAgentStatus('active');
      setAgentProfile(data.agent);
      setAgentEarnings(data.earnings || null);
      setExpectedDropoffs(data.pendingDropoffs);
      setHoldingPickups(data.holdingItems);
    } catch (e) {
      console.error(e);
      // A thrown fetch (offline, DNS, CORS, abort) is a request failure, never
      // an account-status change.
      setQueueError(lang === 'en'
        ? "We couldn't reach Return4me. Check your connection and try again."
        : 'Imeshindwa kufikia Return4me. Angalia mtandao wako na ujaribu tena.');
    } finally {
      setQueueLoading(false);
    }
  };

  const retryQueue = () => {
    setQueueError('');
    fetchQueues();
  };

  useEffect(() => {
    fetchQueues();
  }, [token]);

  // Request login/onboarding OTP
  const handleAuthRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');

    if (isRegistering && contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
      setAuthError('Tafadhali weka barua pepe sahihi (Please enter a valid email address).');
      return;
    }

    setAuthLoading(true);

    try {
      // PHASE 16.1 BATCH 3 (F-3) — the dead `payload` object was REMOVED here.
      //
      // It used to be built as `{ phone, role: 'agent', businessName,
      // locationAddress, tillNumber, nationalId }` for the registration case and
      // then never referenced: this call hard-codes `body: { phone }` below (the
      // OTP request only needs the number). Its presence implied registration
      // data was submitted at request time when it was not.
      //
      // The registration data's REAL submission point is unchanged and still
      // POST /api/auth/verify-otp (handleOtpVerify below), which sends
      // businessName / locationAddress / payoutMethodType / tillNumber /
      // nationalId / termsAccepted / contactEmail / the two base64 images
      // alongside the OTP. The registration API contract, OTP sequencing, rate
      // limiting, validation, pending-agent creation, terms handling and image
      // limits are ALL untouched by this removal.
      const response = await fetch('/api/auth/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to dispatch OTP');
      }


      setShowOtp(true);
    } catch (e: any) {
      setAuthError(e.message);
    } finally {
      setAuthLoading(false);
    }
  };

  // Verify OTP & save token
  const handleOtpVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setAuthLoading(true);

    try {
      const response = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone,
          code: otp,
          role: 'agent',
          businessName,
          locationAddress,
          payoutMethodType,
          tillNumber,
          nationalId,
          termsAccepted: agreedTerms,
          contactEmail,
          shopPhotoBase64,
          idDocumentPhotoBase64,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'OTP Verification failed');
      }

      setToken(data.token);
    } catch (e: any) {
      setAuthError(e.message);
    } finally {
      setAuthLoading(false);
    }
  };

  // Look up a pending item by drop-off code and open its verification
  // panel, rather than confirming immediately — confirm-dropoff now
  // requires verification to have happened first (server-enforced).
  const handleLookupDropoff = (e: React.FormEvent) => {
    e.preventDefault();
    // PHASE 16.1 BATCH 3 (F-1) — this is an OPERATIONAL action taken while the
    // agent is signed in, so its failure belongs in `operationError` (which the
    // Hub renders). It previously wrote to `authError`, which is only rendered
    // inside the signed-OUT card — so a bad drop-off code produced no visible
    // feedback at all.
    setOperationError('');
    const item = expectedDropoffs.find(i => i.id.trim().toUpperCase() === dropoffCodeInput.trim().toUpperCase());
    if (!item) {
      setOperationError(lang === 'en' ? 'No pending item found with that drop-off code.' : 'Hakuna bidhaa inayosubiri yenye msimbo huo.');
      return;
    }
    openVerificationPanel(item);
    setDropoffCodeInput('');
  };

  const handleRejectDropoff = async (dropoffCode: string) => {
    setActionSuccessMsg('');
    // PHASE 16.1 BATCH 3 (F-1) — operational failure channel, not `authError`.
    setOperationError('');
    setActionProcessing(true);
    // BATCH 4B-1 (B3): busy state is scoped to THIS drop-off code.
    setProcessingItemId(dropoffCode);

    const finalReason = rejectionReason === "Other" ? `Other: ${rejectionCustomText}` : rejectionReason;

    try {
      const response = await fetch('/api/agents/reject-dropoff', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ dropoffCode, reason: finalReason }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Reject drop-off failed');
      }

      setActionSuccessMsg(data.message);
      setRejectingItemId(null);
      fetchQueues(); // Reload queues
    } catch (e: any) {
      setOperationError(e.message);
    } finally {
      finishProcessing();
    }
  };

  // Confirm visual check of owner ID and physical handover — requires the
  // owner's secret pickup code (sent to them privately via SMS/email once
  // payment was confirmed), so a separate dedicated modal collects it here
  // rather than reusing the generic yes/no confirmModal.
  const handleConfirmHandover = (claimId: string) => {
    setActionSuccessMsg('');
    setOperationError('');
    setPickupCodeModal({ claimId, code: '', photoBase64: null });
  };

  const handleHandoverPhotoCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !pickupCodeModal) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      setPickupCodeModal({ ...pickupCodeModal, photoBase64: reader.result as string });
    };
    reader.readAsDataURL(file);
  };

  const startHandoverCamera = async () => {
    setOperationError('');
    setUseHandoverCamera(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (handoverVideoRef.current) {
        handoverVideoRef.current.srcObject = stream;
        handoverVideoRef.current.play();
      }
    } catch (e) {
      console.error('Camera access denied:', e);
      setOperationError(lang === 'en' ? 'Could not access camera. Please use file upload instead.' : 'Imeshindwa kufungua kamera. Tafadhali weka picha ya faili badala yake.');
      setUseHandoverCamera(false);
    }
  };

  const stopHandoverCamera = () => {
    if (handoverVideoRef.current && handoverVideoRef.current.srcObject) {
      const stream = handoverVideoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      handoverVideoRef.current.srcObject = null;
    }
    setUseHandoverCamera(false);
  };

  const captureHandoverFrame = () => {
    if (handoverVideoRef.current && handoverCanvasRef.current && pickupCodeModal) {
      const video = handoverVideoRef.current;
      const canvas = handoverCanvasRef.current;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg');
        setPickupCodeModal({ ...pickupCodeModal, photoBase64: dataUrl });
        stopHandoverCamera();
      }
    }
  };

  const submitConfirmHandover = async () => {
    if (!pickupCodeModal) return;
    const { claimId, code, photoBase64 } = pickupCodeModal;
    if (!code || code.trim() === '') {
      setOperationError(lang === 'en' ? 'Ask the owner for their secret pickup code first.' : 'Muulize mmiliki msimbo wake wa siri kwanza.');
      return;
    }
    if (!photoBase64) {
      setOperationError(lang === 'en' ? 'Take a photo of the claimant with the item before confirming handover — this protects both of you if a dispute comes up later.' : 'Piga picha ya mdai akiwa na bidhaa kabla ya kuthibitisha — hii inawalinda nyote wawili endapo mzozo utatokea baadaye.');
      return;
    }
    setOperationError('');
    setActionProcessing(true);
    // BATCH 4B-1 (B3): the held-item card for THIS claim shows the busy state;
    // the modal's own Confirm button keeps its modalBusy protection.
    setProcessingItemId(claimId);
    try {
      const response = await fetch('/api/agents/confirm-handover', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId, pickupCode: code.trim(), handoverPhotoBase64: photoBase64 }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Confirm handover failed');
      }

      setActionSuccessMsg(data.message);
      setPickupCodeModal(null);
      fetchQueues(); // Reload queues
    } catch (e: any) {
      // PHASE 16.1 BATCH 3 (F-1) — a failed handover (wrong pickup code, paused
      // platform, unmet dispute/legal-hold fail-safe, upload failure) now shows
      // in the Hub instead of vanishing into the unrendered `authError`. The
      // modal deliberately STAYS OPEN so the agent can correct the code and
      // retry; the server's pickup-code check and settlement CAS remain the
      // authoritative protections.
      setOperationError(e.message);
    } finally {
      finishProcessing();
    }
  };

  // Confirm owner viewed and verified the item physically
  const handleConfirmViewing = (claimId: string) => {
    setActionSuccessMsg('');
    // PHASE 16.1 BATCH 3 (F-1) — operational channel.
    setOperationError('');

    setConfirmModal({
      title: lang === 'en' ? 'Confirm Viewing' : 'Thibitisha Ukaguzi',
      message: lang === 'en'
        ? "Are you sure you want to confirm that the owner has visually inspected and verified this item? This will trigger the 15-minute payment window and cannot be undone."
        : "Je, una uhakika unataka kuthibitisha kwamba mmiliki amekagua na kuthibitisha bidhaa hii kwa macho? Hii itaanzisha muda wa dakika 15 wa malipo na kitendo hiki hakiwezi kubatilishwa.",
      // PHASE 16.1 BATCH 3 (F-6) — resolves to TRUE only on success, so the
      // modal closes after the action completes and stays open when it fails.
      onConfirm: async () => {
        setActionProcessing(true);
        // BATCH 4B-1 (B3): the busy identity is the CLAIM this confirmation
        // targets, so unrelated drop-offs and held items stay actionable while
        // the request is in flight. Escape/close protection stays modalBusy's.
        setProcessingItemId(claimId);
        try {
          const response = await fetch(`/api/agents/claims/${claimId}/confirm-viewing`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
          });

          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'Confirm viewing failed');
          }

          setActionSuccessMsg(data.message);
          fetchQueues(); // Reload queues
          return true;
        } catch (e: any) {
          setOperationError(e.message);
          return false;
        } finally {
          finishProcessing();
        }
      }
    });
  };

  return (
    <div className="w-full fade-in">
      
      {/* 1. NOT LOGGED IN / ONBOARDING VIEW */}
      {!token && (
        <div className="bg-white rounded-2xl border border-stone-100 p-6 md:p-8 shadow-sm max-w-lg mx-auto space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-3xl font-extrabold text-primary-green">{t.agentTitle}</h1>
            <p className="text-stone-500 text-xs max-w-sm mx-auto">{t.agentSubtitle}</p>
          </div>

          {authError && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 rounded-2xl flex items-center space-x-2 text-xs">
              <AlertCircle size={16} />
              <span>{authError}</span>
            </div>
          )}

          {/* OTP verify form */}
          {showOtp ? (
            <form onSubmit={handleOtpVerify} className="space-y-4">

              <div className="space-y-1">
                <label htmlFor="agent-otp" className="block text-xs font-bold text-primary-green uppercase tracking-wider">SMS OTP Verification Code</label>
                <input
                  id="agent-otp"
                  type="text"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  maxLength={4}
                  placeholder="••••"
                  className="w-full border-2 border-stone-200 rounded-xl py-3 text-center text-xl font-mono tracking-widest focus:outline-none focus:border-accent-orange"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={authLoading}
                className="w-full bg-accent-strong hover:bg-accent-strong-hover text-white py-3.5 rounded-2xl font-bold transition flex items-center justify-center space-x-2"
              >
                <span>Verify OTP & Open Dashboard</span>
                <ArrowRight size={18} />
              </button>
            </form>
          ) : (
            /* Request OTP / Register form */
            <form onSubmit={handleAuthRequest} className="space-y-4">
              
              {/* Toggle new agent registration vs login */}
              <div className="grid grid-cols-2 bg-brand-beige p-1 rounded-xl gap-1">
                <button
                  type="button"
                  onClick={() => setIsRegistering(false)}
                  className={`py-2 rounded-lg text-xs font-bold transition ${!isRegistering ? 'bg-white text-primary-green shadow' : 'text-stone-500'}`}
                >
                  Agent Login
                </button>
                <button
                  type="button"
                  onClick={() => setIsRegistering(true)}
                  className={`py-2 rounded-lg text-xs font-bold transition ${isRegistering ? 'bg-white text-primary-green shadow' : 'text-stone-500'}`}
                >
                  Apply to be Agent
                </button>
              </div>

              {/* Registration Specific Fields */}
              {isRegistering && (
                <div className="space-y-4 fade-in">
                  <div className="space-y-1">
                    <label htmlFor="agent-business-name" className="block text-xs font-bold text-primary-green uppercase tracking-wider">{t.businessName} *</label>
                    <input
                      id="agent-business-name"
                      type="text"
                      value={businessName}
                      onChange={(e) => setBusinessName(e.target.value)}
                      placeholder="e.g. Hurlingham Cyber Café"
                      className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm"
                      required
                    />
                  </div>

                  <div className="space-y-1">
                    <label htmlFor="agent-location" className="block text-xs font-bold text-primary-green uppercase tracking-wider">Physical Street/Building Location *</label>
                    <input
                      id="agent-location"
                      type="text"
                      value={locationAddress}
                      onChange={(e) => setLocationAddress(e.target.value)}
                      placeholder="e.g. Argwings Kodhek Rd, prestige plaza"
                      className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm"
                      required
                    />
                  </div>

                  <div className="space-y-4">
                    <div className="space-y-1">
                      <label htmlFor="agent-payout-method" className="block text-xs font-bold text-primary-green uppercase tracking-wider">Payout Method *</label>
                      <select
                        id="agent-payout-method"
                        value={payoutMethodType}
                        onChange={(e) => setPayoutMethodType(e.target.value)}
                        className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-white"
                        required
                      >
                        <option value="Till Number">Till Number (M-Pesa Buy Goods)</option>
                        <option value="Paybill Number">Paybill Number</option>
                        <option value="Pochi la Biashara">Pochi la Biashara</option>
                        <option value="Personal M-Pesa">Personal M-Pesa (Send Money)</option>
                      </select>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label htmlFor="agent-till-number" className="block text-xs font-bold text-primary-green uppercase tracking-wider">Payout Code / Number *</label>
                        <input
                          id="agent-till-number"
                          type="text"
                          value={tillNumber}
                          onChange={(e) => setTillNumber(e.target.value)}
                          placeholder="Till / Paybill / Phone"
                          className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm font-mono"
                          required
                        />
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="agent-national-id" className="block text-xs font-bold text-primary-green uppercase tracking-wider">{t.nationalId} *</label>
                        <input
                          id="agent-national-id"
                          type="text"
                          value={nationalId}
                          onChange={(e) => setNationalId(e.target.value)}
                          placeholder="e.g. 32019482"
                          className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm font-mono"
                          required
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label htmlFor="agent-contact-email" className="block text-xs font-bold text-primary-green uppercase tracking-wider">
                        Email Address (Optional / Barua Pepe - Sio Lazima)
                      </label>
                      <input
                        id="agent-contact-email"
                        type="email"
                        value={contactEmail}
                        onChange={(e) => setContactEmail(e.target.value)}
                        placeholder="e.g. agent@return4me.co.ke"
                        className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm font-sans"
                      />
                    </div>

                    {/* Shop Photo Upload */}
                    <div className="space-y-1">
                      <label htmlFor="agent-shop-photo" className="block text-xs font-bold text-primary-green uppercase tracking-wider">
                        Business / Shop Front Photo (Picha ya Duka/Biashara)
                      </label>
                      <input
                        id="agent-shop-photo"
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/heic"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            if (file.size > 5 * 1024 * 1024) {
                              setAuthError('Picha ya duka ni kubwa mno. Tafadhali chagua picha chini ya 5MB.');
                              return;
                            }
                            const reader = new FileReader();
                            reader.onloadend = () => setShopPhotoBase64(reader.result as string);
                            reader.readAsDataURL(file);
                          }
                        }}
                        className="block w-full text-xs text-stone-500 file:mr-3 file:py-2 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-emerald-50 file:text-primary-green hover:file:bg-emerald-100 cursor-pointer"
                      />
                      {shopPhotoBase64 && (
                        <p className="text-[11px] text-emerald-600 font-semibold">Picha ya duka imepakiwa (Shop photo selected)</p>
                      )}
                    </div>

                    {/* ID Document Photo Upload */}
                    <div className="space-y-1">
                      <label htmlFor="agent-id-document-photo" className="block text-xs font-bold text-primary-green uppercase tracking-wider">
                        Agent ID Document Photo (Picha ya Kitambulisho cha Wakala)
                      </label>
                      <input
                        id="agent-id-document-photo"
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/heic"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            if (file.size > 5 * 1024 * 1024) {
                              setAuthError('Picha ya kitambulisho ni kubwa mno. Tafadhali chagua picha chini ya 5MB.');
                              return;
                            }
                            const reader = new FileReader();
                            reader.onloadend = () => setIdDocumentPhotoBase64(reader.result as string);
                            reader.readAsDataURL(file);
                          }
                        }}
                        className="block w-full text-xs text-stone-500 file:mr-3 file:py-2 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-orange-50 file:text-accent-orange hover:file:bg-orange-100 cursor-pointer"
                      />
                      {idDocumentPhotoBase64 && (
                        <p className="text-[11px] text-emerald-600 font-semibold">Picha ya kitambulisho imepakiwa (ID photo selected)</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* General phone */}
              <div className="space-y-1">
                <label htmlFor="agent-phone" className="block text-xs font-bold text-primary-green uppercase tracking-wider">Phone Number *</label>
                <div className="relative">
                  <input
                    id="agent-phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="0712345678"
                    className="w-full border border-stone-200 rounded-xl pl-10 pr-3 py-2.5 text-sm font-mono"
                    required
                  />
                  <Phone size={14} className="absolute left-3 top-3.5 text-stone-400" />
                </div>
              </div>

              {isRegistering && (
                <div className="flex items-start space-x-2 pt-2 pb-1 bg-brand-beige p-3 rounded-xl border border-stone-100">
                  <input
                    id="agreed-terms"
                    type="checkbox"
                    checked={agreedTerms}
                    onChange={(e) => setAgreedTerms(e.target.checked)}
                    className="mt-1 h-4 w-4 rounded border-stone-300 text-primary-green focus:ring-primary-green accent-primary-green cursor-pointer"
                    required
                  />
                  <label htmlFor="agreed-terms" className="text-xs text-stone-600 leading-tight select-none cursor-pointer">
                    I have read and agree to the Return4me{' '}
                    <button
                      type="button"
                      onClick={() => (window as any).setView?.('terms')}
                      className="text-primary-green hover:underline font-bold inline focus:outline-none"
                    >
                      Terms of Service
                    </button>{' '}
                    and{' '}
                    <button
                      type="button"
                      onClick={() => (window as any).setView?.('privacy')}
                      className="text-primary-green hover:underline font-bold inline focus:outline-none"
                    >
                      Privacy Policy
                    </button>
                    .
                  </label>
                </div>
              )}

              <button
                type="submit"
                disabled={authLoading}
                className="w-full bg-primary-green hover:bg-primary-hover text-white py-3.5 rounded-2xl font-bold transition flex items-center justify-center space-x-2"
              >
                {authLoading ? (
                  <Loader2 className="animate-spin" size={18} />
                ) : (
                  <>
                    <span>Request Login OTP</span>
                    <ArrowRight size={18} />
                  </>
                )}
              </button>
            </form>
          )}
        </div>
      )}

      {/* 2. QUEUE LOADING — the pre-answer state.
          PHASE 16.1 BATCH 3 (F-5 / H-3): the very first paint must not claim a
          vetting state before the server has actually answered. */}
      {token && queueLoading && !agentProfile && !queueError && (
        <div className="bg-white rounded-2xl border border-stone-100 p-8 shadow-sm max-w-md mx-auto text-center space-y-4 fade-in">
          <Loader2 className="animate-spin text-primary-green mx-auto" size={28} aria-hidden={true} />
          <p className="text-stone-600 text-sm font-semibold" role="status" aria-live="polite">
            {lang === 'en' ? 'Loading your agent hub…' : 'Inapakia ukurasa wako wa wakala…'}
          </p>
        </div>
      )}

      {/* 2b. QUEUE REQUEST FAILURE — TRUTHFUL, AND NEVER A VETTING CLAIM.
          PHASE 16.1 BATCH 3 (F-5 / H-3). This replaces the old behaviour where
          ANY failed queue request rendered the "Vetting Pending" screen.

          The server's own explanation is shown when it supplied one: both guards
          on /api/agents/queue answer with deliberate, user-facing bilingual copy,
          so an agent whose application really is still under review reads that
          ("Akaunti yako ya Agent bado haijaidhinishwa au imesitishwa."), and an
          agent whose session merely expired reads THAT instead — rather than
          both being told their account status changed when it may not have.
          Nothing here asserts, grants or withholds any status: the server stays
          the sole authority. */}
      {token && !queueLoading && queueError && !agentProfile && (
        <div className="bg-white rounded-2xl border border-stone-100 p-8 shadow-sm max-w-md mx-auto text-center space-y-5 fade-in">
          <div className="w-16 h-16 bg-red-50 text-red-600 rounded-full flex items-center justify-center mx-auto">
            <AlertCircle size={32} aria-hidden={true} />
          </div>
          <div className="space-y-2">
            <h2 className="text-2xl font-extrabold text-primary-green">
              {lang === 'en' ? 'Agent Hub unavailable' : 'Ukurasa wa Wakala Haupatikani'}
            </h2>
            <p className="text-stone-600 text-sm font-semibold" role="alert" aria-live="assertive">
              {queueError}
            </p>
          </div>
          <button
            type="button"
            onClick={retryQueue}
            disabled={queueLoading}
            aria-busy={queueLoading}
            className="w-full bg-primary-green hover:bg-primary-hover text-white py-3 rounded-2xl font-bold transition flex items-center justify-center space-x-2 disabled:opacity-50"
          >
            {queueLoading
              ? <Loader2 className="animate-spin" size={18} aria-hidden={true} />
              : <span>{lang === 'en' ? 'Try again' : 'Jaribu tena'}</span>}
          </button>
        </div>
      )}

      {/* 3. PENDING APPROVAL VIEW.
          Retained, but NO LONGER reachable by a failed request — only by the
          brief window before the server has answered, or by a future server
          response that states a non-active agent positively. */}
      {token && agentStatus === 'pending' && !queueError && !queueLoading && (
        <div className="bg-white rounded-2xl border border-stone-100 p-8 shadow-sm max-w-md mx-auto text-center space-y-5 fade-in">
          <div className="w-16 h-16 bg-orange-100 text-accent-orange rounded-full flex items-center justify-center mx-auto">
            <Lock size={32} />
          </div>
          <div>
            <h2 className="text-2xl font-extrabold text-primary-green">Vetting Pending</h2>
            <p className="text-stone-600 text-sm mt-1 font-semibold">
              {lang === 'sw'
                ? 'Taarifa zako zitakaguliwa na utaarifiwa kuhusu maombi yako.'
                : 'Their details will be checked and they\'ll be notified of their application.'}
            </p>
          </div>
          <div className="bg-brand-beige border border-stone-200 p-4 rounded-xl text-left text-xs text-stone-600 space-y-1.5 leading-tight">
            {lang === 'sw' ? (
              <>
                <span className="font-bold block mb-1">Mchakato wa Kuidhinisha:</span>
                <span>1. Uhakiki wa maelezo ya biashara na mahali ilipo</span>
                <span>2. Uhakiki salama wa Kitambulisho cha Kitaifa (KYC)</span>
                <span>3. Utapokea ujumbe wa SMS au barua pepe maombi yako yakishaidhinishwa!</span>
              </>
            ) : (
              <>
                <span className="font-bold block mb-1">Onboarding Process:</span>
                <span>1. Verification of Business Details & Location</span>
                <span>2. Secure KYC & National ID Hash Review</span>
                <span>3. SMS or Email notification dispatch upon activation!</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* 4. ACTIVE AGENT HUB VIEW — PHASE 16.1 BATCH 4 structural extraction.
          AgentView owns ALL hub state and callbacks; the Hub JSX itself lives
          in components/agent/AgentHub.tsx (single authoritative copy). */}
      {token && agentStatus === 'active' && agentProfile && (
        <AgentHub
          lang={lang}
          t={t}
          agentProfile={agentProfile}
          agentEarnings={agentEarnings}
          actionSuccessMsg={actionSuccessMsg}
          operationError={operationError}
          setOperationError={setOperationError}
          queueError={queueError}
          queueLoading={queueLoading}
          retryQueue={retryQueue}
          expectedDropoffs={expectedDropoffs}
          dropoffCodeInput={dropoffCodeInput}
          setDropoffCodeInput={setDropoffCodeInput}
          actionProcessing={actionProcessing}
          processingItemId={processingItemId}
          handleLookupDropoff={handleLookupDropoff}
          verifyingItemId={verifyingItemId}
          setVerifyingItemId={setVerifyingItemId}
          openVerificationPanel={openVerificationPanel}
          verifyCategoryId={verifyCategoryId}
          setVerifyCategoryId={setVerifyCategoryId}
          verifyName={verifyName}
          setVerifyName={setVerifyName}
          verifyDocNumber={verifyDocNumber}
          setVerifyDocNumber={setVerifyDocNumber}
          verifyDescription={verifyDescription}
          setVerifyDescription={setVerifyDescription}
          verifyFoundArea={verifyFoundArea}
          setVerifyFoundArea={setVerifyFoundArea}
          verifyPhysicallyChecked={verifyPhysicallyChecked}
          setVerifyPhysicallyChecked={setVerifyPhysicallyChecked}
          verifyReason={verifyReason}
          setVerifyReason={setVerifyReason}
          verifyReasonDetail={verifyReasonDetail}
          setVerifyReasonDetail={setVerifyReasonDetail}
          verifyError={verifyError}
          hasCorrections={hasCorrections}
          handleSubmitVerification={handleSubmitVerification}
          rejectingItemId={rejectingItemId}
          setRejectingItemId={setRejectingItemId}
          rejectionReason={rejectionReason}
          setRejectionReason={setRejectionReason}
          rejectionCustomText={rejectionCustomText}
          setRejectionCustomText={setRejectionCustomText}
          handleRejectDropoff={handleRejectDropoff}
          handleConfirmHandover={handleConfirmHandover}
          handleConfirmViewing={handleConfirmViewing}
          categories={categories}
          holdingPickups={holdingPickups}
          refreshCategories={refreshCategories}
        />
      )}

      {/* Custom Confirmation Modal.
          PHASE 16.1 BATCH 3 (A-8): real dialog semantics — role, aria-modal,
          an accessible name via aria-labelledby, a focusable container the
          shared effect focuses on open, and focus restoration on close. Escape
          handling lives in that same effect.
          PHASE 16.1 BATCH 3 (F-6): the Confirm button now AWAITS the action and
          closes the dialog only when it reports success, so a failure no longer
          makes the dialog disappear before the agent can read why. */}
      {confirmModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-stone-900/60 fade-in">
          <div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-confirm-modal-title"
            className="bg-white border border-stone-200 rounded-2xl p-6 shadow-sm max-w-sm w-full space-y-4 fade-in outline-none"
          >
            <div className="flex items-start space-x-3 text-amber-600">
              <CheckCircle className="w-6 h-6 shrink-0 mt-0.5 animate-pulse" aria-hidden={true} />
              <div className="space-y-1">
                <h3 id="agent-confirm-modal-title" className="font-extrabold text-sm text-stone-900 uppercase tracking-wider">
                  {confirmModal.title}
                </h3>
                <p className="text-stone-500 text-xs leading-relaxed font-semibold">
                  {confirmModal.message}
                </p>
              </div>
            </div>
            <div className="flex justify-end space-x-2 pt-2">
              <button
                onClick={() => setConfirmModal(null)}
                disabled={modalBusy}
                className="bg-stone-100 hover:bg-stone-200 text-stone-600 text-xs font-bold px-4 py-2 rounded-xl transition disabled:opacity-50"
              >
                {lang === 'en' ? 'Cancel' : 'Ghairi'}
              </button>
              <button
                disabled={modalBusy}
                aria-busy={modalBusy}
                onClick={async () => {
                  // UX guard against a double-click. The AUTHORITATIVE
                  // duplicate-submission protection remains the server-side
                  // compare-and-swap in transitionClaimStatus (409 on a lost
                  // race) — this only stops the second click from being sent.
                  if (modalBusy) return;
                  setModalBusy(true);
                  try {
                    const ok = await confirmModal.onConfirm();
                    // Close ONLY on success. On failure the dialog stays open so
                    // the Hub's operational error channel can explain what
                    // happened while the agent still has the action in view.
                    if (ok) setConfirmModal(null);
                  } finally {
                    setModalBusy(false);
                  }
                }}
                className="bg-primary-green hover:bg-primary-hover text-white text-xs font-bold px-4 py-2 rounded-xl transition flex items-center space-x-1.5 disabled:opacity-50"
              >
                {modalBusy ? <Loader2 className="animate-spin" size={12} aria-hidden={true} /> : null}
                <span>{lang === 'en' ? 'Confirm' : 'Thibitisha'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Handover Pickup Code Modal.
          PHASE 16.1 BATCH 3 (A-8): dialog semantics + focus, via the same
          shared effect the confirmation modal uses (no third modal primitive). */}
      {pickupCodeModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-stone-900/60 fade-in">
          <div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-handover-modal-title"
            className="bg-white border border-stone-200 rounded-2xl p-6 shadow-sm max-w-sm w-full space-y-4 fade-in outline-none"
          >
            <div className="flex items-start space-x-3 text-amber-600">
              <CheckCircle className="w-6 h-6 shrink-0 mt-0.5" aria-hidden={true} />
              <div className="space-y-1">
                <h3 id="agent-handover-modal-title" className="font-extrabold text-sm text-stone-900 uppercase tracking-wider">
                  {lang === 'en' ? 'Confirm Handover' : 'Thibitisha Kukabidhi'}
                </h3>
                <p className="text-stone-500 text-xs leading-relaxed font-semibold">
                  {lang === 'en'
                    ? 'Ask the owner to read out their secret pickup code (sent to them by SMS/email when they paid). Enter it below to release payment. This cannot be undone.'
                    : 'Muulize mmiliki asome msimbo wake wa siri wa kuchukua (uliotumwa kwake kwa SMS/barua pepe alipolipa). Weka hapa chini kutoa malipo. Kitendo hiki hakiwezi kubatilishwa.'}
                </p>
              </div>
            </div>
            <input
              type="text"
              inputMode="numeric"
              autoFocus
              value={pickupCodeModal.code}
              onChange={(e) => setPickupCodeModal({ ...pickupCodeModal, code: e.target.value })}
              placeholder={lang === 'en' ? 'Enter owner\'s secret pickup code' : 'Weka msimbo wa siri wa mmiliki'}
              aria-label={lang === 'en' ? 'Owner\'s secret pickup code' : 'Msimbo wa siri wa mmiliki'}
              className="w-full border border-stone-300 rounded-xl px-4 py-3 text-center text-lg font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-primary-green"
            />

            <div className="space-y-2">
              <p className="text-[11px] font-bold text-stone-600">
                {lang === 'en' ? 'Photo of claimant with the item (required)' : 'Picha ya mdai akiwa na bidhaa (inahitajika)'}
              </p>
              <input
                ref={handoverPhotoInputRef}
                type="file"
                accept="image/*"
                onChange={handleHandoverPhotoCapture}
                aria-label={lang === 'en' ? 'Photo of claimant with the item' : 'Picha ya mdai akiwa na bidhaa'}
                className="hidden"
              />

              {useHandoverCamera ? (
                <div className="relative bg-black rounded-xl overflow-hidden aspect-video">
                  {/* PHASE 16.1 BATCH 3 (A-7) — the live preview had no
                      accessible name, so assistive technology announced an
                      unnamed media element. Capture behaviour is unchanged; only
                      the name was added. */}
                  <video
                    ref={handoverVideoRef}
                    aria-label={lang === 'en'
                      ? 'Live camera preview of the claimant with the item'
                      : 'Kamera ya moja kwa moja ya mdai akiwa na bidhaa'}
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute bottom-3 left-0 right-0 flex justify-center space-x-3">
                    <button
                      type="button"
                      onClick={captureHandoverFrame}
                      className="bg-accent-orange text-white px-4 py-2 rounded-lg font-bold text-xs shadow-lg transition hover:bg-accent-hover"
                    >
                      {lang === 'en' ? 'Capture' : 'Piga'}
                    </button>
                    <button
                      type="button"
                      onClick={stopHandoverCamera}
                      className="bg-stone-800 text-white px-4 py-2 rounded-lg font-bold text-xs transition hover:bg-stone-700"
                    >
                      {lang === 'en' ? 'Cancel' : 'Ghairi'}
                    </button>
                  </div>
                </div>
              ) : pickupCodeModal.photoBase64 ? (
                <div className="relative rounded-xl overflow-hidden border border-stone-200 group">
                  <img
                    src={pickupCodeModal.photoBase64}
                    alt="Handover evidence"
                    className="w-full h-40 object-cover"
                  />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition space-x-3">
                    <button
                      type="button"
                      onClick={startHandoverCamera}
                      className="bg-white text-primary-green p-2.5 rounded-full hover:bg-stone-100 shadow-md transition"
                      title={lang === 'en' ? 'Retake with camera' : 'Piga tena kwa kamera'}
                      aria-label={lang === 'en' ? 'Retake with camera' : 'Piga tena kwa kamera'}
                    >
                      <Camera size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handoverPhotoInputRef.current?.click()}
                      className="bg-white text-primary-green p-2.5 rounded-full hover:bg-stone-100 shadow-md transition"
                      title={lang === 'en' ? 'Upload a different photo' : 'Pakia picha nyingine'}
                      aria-label={lang === 'en' ? 'Upload a different photo' : 'Pakia picha nyingine'}
                    >
                      <Upload size={16} />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="border-2 border-dashed border-stone-300 rounded-xl py-5 text-center bg-stone-50 space-y-3">
                  <p className="text-stone-400 text-[10px]">
                    {lang === 'en' ? 'Take a photo now, or upload one from this device' : 'Piga picha sasa, au pakia moja kutoka kwa kifaa hiki'}
                  </p>
                  <div className="flex items-center justify-center gap-2.5">
                    <button
                      type="button"
                      onClick={startHandoverCamera}
                      className="bg-primary-green hover:bg-primary-hover text-white px-3.5 py-2 rounded-lg text-xs font-bold transition flex items-center gap-1.5"
                    >
                      <Camera size={13} />
                      <span>{lang === 'en' ? 'Take Photo' : 'Piga Picha'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handoverPhotoInputRef.current?.click()}
                      className="bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 px-3.5 py-2 rounded-lg text-xs font-bold transition flex items-center gap-1.5"
                    >
                      <Upload size={13} />
                      <span>{lang === 'en' ? 'Upload File' : 'Pakia Faili'}</span>
                    </button>
                  </div>
                </div>
              )}
              <canvas ref={handoverCanvasRef} className="hidden" />
            </div>
            {/* PHASE 16.1 BATCH 3 (F-1) — the modal now shows OPERATIONAL
                failures (a wrong/absent owner pickup code, a missing photo, a
                failed upload), which is where the agent is actually looking when
                the action fails. This used to read `authError`, which no
                operational failure writes any more.

                Deliberately NOT a live region: the Hub's `role="alert"` channel
                above already announces this exact text, and two assertive
                regions carrying the same message would announce it twice. This
                is the visual placement, not a second announcement. */}
            {operationError && (
              <p className="text-red-600 text-xs font-semibold">{operationError}</p>
            )}
            <div className="flex justify-end space-x-2 pt-2">
              <button
                onClick={() => { stopHandoverCamera(); setPickupCodeModal(null); setOperationError(''); }}
                disabled={actionProcessing}
                className="bg-stone-100 hover:bg-stone-200 text-stone-600 text-xs font-bold px-4 py-2 rounded-xl transition disabled:opacity-50"
              >
                {lang === 'en' ? 'Cancel' : 'Ghairi'}
              </button>
              <button
                onClick={submitConfirmHandover}
                disabled={actionProcessing}
                aria-busy={actionProcessing}
                className="bg-primary-green hover:bg-primary-hover text-white text-xs font-bold px-4 py-2 rounded-xl transition disabled:opacity-50"
              >
                {actionProcessing
                  ? (lang === 'en' ? 'Confirming…' : 'Inathibitisha…')
                  : (lang === 'en' ? 'Confirm & Release Payment' : 'Thibitisha na Toa Malipo')}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
