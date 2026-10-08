import { useEffect, useRef, useState } from 'react';
import { AgentApiError, agentApi } from '../services/agentApi';

type Language = 'en' | 'sw';

/** Pure request construction keeps the exact existing API payload visible and testable. */
export function buildRejectionPayload(reason: string, customText: string) {
  return { reason: reason === 'Other' ? `Other: ${customText}` : reason };
}

export function useAgentOperations({ token, refreshCategories }: {
  token: string | null;
  refreshCategories?: () => void;
}) {
  const [agentStatus, setAgentStatus] = useState<string>('pending');
  const [queueError, setQueueError] = useState('');
  const [queueLoading, setQueueLoading] = useState(false);
  const [expectedDropoffs, setExpectedDropoffs] = useState<any[]>([]);
  const [holdingPickups, setHoldingPickups] = useState<any[]>([]);
  const [agentProfile, setAgentProfile] = useState<any | null>(null);
  // Issue B — the Agent Hub's earnings projection carries BOTH states: completed
  // (paid) earnings and settlement-window pending earnings. The server computes
  // both from authoritative ledger rows; the browser never derives money.
  const [agentEarnings, setAgentEarnings] = useState<{ totalEarned: number; completedPayoutsCount: number; pendingSettlementEarnings: number; pendingSettlementsCount: number } | null>(null);
  const [dropoffCodeInput, setDropoffCodeInput] = useState('');
  const [operationError, setOperationError] = useState('');
  const [actionSuccessMsg, setActionSuccessMsg] = useState('');
  const [actionProcessing, setActionProcessing] = useState(false);
  const [processingItemId, setProcessingItemId] = useState<string | null>(null);

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

  const [rejectingItemId, setRejectingItemId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('Not a real item');
  const [rejectionCustomText, setRejectionCustomText] = useState('');

  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    onConfirm: () => Promise<boolean>;
  } | null>(null);
  const [modalBusy, setModalBusy] = useState(false);
  const [pickupCodeModal, setPickupCodeModal] = useState<{
    claimId: string;
    code: string;
    photoBase64: string | null;
  } | null>(null);
  const [useHandoverCamera, setUseHandoverCamera] = useState(false);
  const handoverPhotoInputRef = useRef<HTMLInputElement>(null);
  const handoverVideoRef = useRef<HTMLVideoElement | null>(null);
  const handoverCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const anyModalOpen = Boolean(confirmModal || pickupCodeModal);

  const finishProcessing = () => { setActionProcessing(false); setProcessingItemId(null); };

  const fetchQueues = async () => {
    if (!token) return;
    setQueueLoading(true);
    try {
      const data = await agentApi.getQueue(token);
      setQueueError(''); setAgentStatus('active'); setAgentProfile(data.agent);
      setAgentEarnings(data.earnings || null); setExpectedDropoffs(data.pendingDropoffs); setHoldingPickups(data.holdingItems);
    } catch (e) {
      console.error(e);
      const serverMessage = e instanceof AgentApiError ? e.message.trim() : '';
      setQueueError(serverMessage || ("We couldn't load your agent hub right now. Check your connection and try again."));
    } finally { setQueueLoading(false); }
  };
  const retryQueue = () => { setQueueError(''); void fetchQueues(); };
  useEffect(() => { void fetchQueues(); }, [token]);

  const openVerificationPanel = (item: any) => {
    refreshCategories?.(); setVerifyingItemId(item.id); setVerifyCategoryId(item.category_id || '');
    setVerifyName(item.ocr_extracted_name || ''); setVerifyDocNumber(item.ocr_extracted_number || '');
    setVerifyDescription(item.description || ''); setVerifyFoundArea(item.location_description || '');
    setVerifyPhysicallyChecked(false); setVerifyReason('Finder entered wrong information');
    setVerifyReasonDetail(''); setVerifyError(''); setActionSuccessMsg('');
  };
  const hasCorrections = (item: any) => Boolean(item) && (verifyCategoryId !== (item.category_id || '') || verifyName !== (item.ocr_extracted_name || '') || verifyDocNumber !== (item.ocr_extracted_number || '') || verifyDescription !== (item.description || '') || verifyFoundArea !== (item.location_description || ''));

  const handleSubmitVerification = async (item: any, outcome: 'confirmed' | 'corrected') => {
    setVerifyError(''); setActionSuccessMsg(''); setActionProcessing(true); setProcessingItemId(item?.id ?? null);
    const changed = hasCorrections(item);
    if (outcome === 'corrected' && !changed) { setVerifyError('No fields were actually changed — use "Confirm As Reported" instead, or edit a field first.'); finishProcessing(); return; }
    try {
      await agentApi.verifyItem(token!, { dropoffCode: item.id, categoryId: verifyCategoryId, name: item.is_sensitive_document ? (verifyName || null) : null, documentNumber: item.is_sensitive_document ? (verifyDocNumber || null) : null, description: verifyDescription || null, foundArea: verifyFoundArea, reason: changed ? verifyReason : '', reasonDetail: changed ? (verifyReasonDetail || null) : null, physicallyVerified: verifyPhysicallyChecked });
      if (!verifyPhysicallyChecked) { setActionSuccessMsg('Saved. Physically inspect the item, then check the box and confirm to approve it.'); setVerifyingItemId(null); void fetchQueues(); return; }
      const approveData = await agentApi.confirmDropoff(token!, { dropoffCode: item.id });
      setActionSuccessMsg(approveData.message); setVerifyingItemId(null); void fetchQueues();
    } catch (e: any) { setVerifyError(e.message); } finally { finishProcessing(); }
  };

  const handleLookupDropoff = (event: React.FormEvent) => {
    event.preventDefault(); setOperationError('');
    const item = expectedDropoffs.find(i => i.id.trim().toUpperCase() === dropoffCodeInput.trim().toUpperCase());
    if (!item) { setOperationError('No pending item found with that drop-off code.'); return; }
    openVerificationPanel(item); setDropoffCodeInput('');
  };
  const handleRejectDropoff = async (dropoffCode: string) => {
    setActionSuccessMsg(''); setOperationError(''); setActionProcessing(true); setProcessingItemId(dropoffCode);
    try { const data = await agentApi.rejectDropoff(token!, { dropoffCode, ...buildRejectionPayload(rejectionReason, rejectionCustomText) }); setActionSuccessMsg(data.message); setRejectingItemId(null); void fetchQueues(); }
    catch (e: any) { setOperationError(e.message); } finally { finishProcessing(); }
  };

  const handleConfirmHandover = (claimId: string) => { setActionSuccessMsg(''); setOperationError(''); setPickupCodeModal({ claimId, code: '', photoBase64: null }); };
  const handleHandoverPhotoCapture = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file || !pickupCodeModal) return;
    const reader = new FileReader();
    reader.onloadend = () => setPickupCodeModal({ ...pickupCodeModal, photoBase64: reader.result as string });
    reader.readAsDataURL(file);
  };
  const stopHandoverCamera = () => {
    if (handoverVideoRef.current?.srcObject) { const stream = handoverVideoRef.current.srcObject as MediaStream; stream.getTracks().forEach(track => track.stop()); handoverVideoRef.current.srcObject = null; }
    setUseHandoverCamera(false);
  };
  const startHandoverCamera = async () => {
    setOperationError(''); setUseHandoverCamera(true);
    try { const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); if (handoverVideoRef.current) { handoverVideoRef.current.srcObject = stream; await handoverVideoRef.current.play(); } }
    catch (e) { console.error('Camera access denied:', e); setOperationError('Could not access camera. Please use file upload instead.'); setUseHandoverCamera(false); }
  };
  const captureHandoverFrame = () => {
    if (!handoverVideoRef.current || !handoverCanvasRef.current || !pickupCodeModal) return;
    const video = handoverVideoRef.current, canvas = handoverCanvasRef.current;
    canvas.width = video.videoWidth; canvas.height = video.videoHeight; canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    setPickupCodeModal({ ...pickupCodeModal, photoBase64: canvas.toDataURL('image/jpeg') }); stopHandoverCamera();
  };
  const submitConfirmHandover = async () => {
    if (!pickupCodeModal) return;
    const { claimId, code, photoBase64 } = pickupCodeModal;
    if (!code || code.trim() === '') { setOperationError('Ask the owner for their secret pickup code first.'); return; }
    if (!photoBase64) { setOperationError('Take a photo of the claimant with the item before confirming handover — this protects both of you if a dispute comes up later.'); return; }
    setOperationError(''); setActionProcessing(true); setProcessingItemId(claimId);
    try { const data = await agentApi.confirmHandover(token!, { claimId, pickupCode: code.trim(), handoverPhotoBase64: photoBase64 }); setActionSuccessMsg(data.message); setPickupCodeModal(null); void fetchQueues(); }
    catch (e: any) { setOperationError(e.message); } finally { finishProcessing(); }
  };
  const handleConfirmViewing = (claimId: string) => {
    setActionSuccessMsg(''); setOperationError('');
    setConfirmModal({ title: 'Confirm Viewing', message: "Are you sure you want to confirm that the owner has visually inspected and verified this item? This will open the claim's 24-hour payment window and cannot be undone.", onConfirm: async () => {
      setActionProcessing(true); setProcessingItemId(claimId);
      try { const data = await agentApi.confirmViewing(token!, claimId); setActionSuccessMsg(data.message); void fetchQueues(); return true; }
      catch (e: any) { setOperationError(e.message); return false; } finally { finishProcessing(); }
    } });
  };

  useEffect(() => {
    if (!anyModalOpen) return;

    previouslyFocusedRef.current = (typeof document !== 'undefined'
      ? (document.activeElement as HTMLElement | null)
      : null);

    dialogRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
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

  return { agentStatus, queueError, queueLoading, expectedDropoffs, holdingPickups, agentProfile, agentEarnings, dropoffCodeInput, setDropoffCodeInput, operationError, setOperationError, actionSuccessMsg, setActionSuccessMsg, actionProcessing, processingItemId, verifyingItemId, setVerifyingItemId, verifyCategoryId, setVerifyCategoryId, verifyName, setVerifyName, verifyDocNumber, setVerifyDocNumber, verifyDescription, setVerifyDescription, verifyFoundArea, setVerifyFoundArea, verifyPhysicallyChecked, setVerifyPhysicallyChecked, verifyReason, setVerifyReason, verifyReasonDetail, setVerifyReasonDetail, verifyError, rejectingItemId, setRejectingItemId, rejectionReason, setRejectionReason, rejectionCustomText, setRejectionCustomText, confirmModal, setConfirmModal, modalBusy, setModalBusy, pickupCodeModal, setPickupCodeModal, useHandoverCamera, handoverPhotoInputRef, handoverVideoRef, handoverCanvasRef, dialogRef, retryQueue, openVerificationPanel, hasCorrections, handleSubmitVerification, handleLookupDropoff, handleRejectDropoff, handleConfirmHandover, handleHandoverPhotoCapture, startHandoverCamera, stopHandoverCamera, captureHandoverFrame, submitConfirmHandover, handleConfirmViewing };
}
