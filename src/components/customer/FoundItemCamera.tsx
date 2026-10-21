// FOUND-ITEM CAMERA (Phase 3) — dedicated, near-full-view capture for the
// found-item report flow.
//
// Opened from the "Take a photo" control in FinderView, this surface owns the
// whole capture lifecycle: it acquires the rear camera, reads the track's real
// capabilities so flash/torch, zoom and the rear/front switch appear only when
// the device exposes them, previews the frame it captured, and stops every
// track on close, accept and unmount. It owns no geo state, calls no service
// and holds no other form state: it hands the caller one JPEG data URL through
// onCapture, and mirrors the same frame into localStorage under the caller's
// key so a reload can restore the photo.
//
// Presentation only — the report fields, the validation rules, the payload
// keys and the single POST to /api/items/report are untouched by this file.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  CheckCheck,
  Flashlight,
  Loader2,
  Minus,
  Plus,
  RotateCcw,
  SwitchCamera,
  X,
  Zap,
} from 'lucide-react';
import { Button, ICON_SIZE } from '../ui';

/**
 * The Media Capture spec puts `torch` and `zoom` on a video track, but the DOM
 * lib pinned by this repository does not model them yet, so the capability bag
 * and the constraint set are widened locally instead of reaching for `any`.
 * Both names are real members of MediaTrackCapabilities and of the constraint
 * set in the spec.
 */
interface FoundItemCameraCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
  zoom?: { min: number; max: number; step: number };
}

interface FoundItemCameraConstraints extends MediaTrackConstraintSet {
  torch?: boolean;
  zoom?: number;
}

export interface FoundItemCameraProps {
  /** The surface renders only while this is true. */
  open: boolean;
  /** Receives the captured frame as a JPEG data URL. */
  onCapture: (dataUrl: string) => void;
  /** Called after accept, and from every explicit close. */
  onClose: () => void;
  /** localStorage key the last capture is mirrored under. */
  persistedCaptureKey: string;
  /** Accessible name of the live preview. */
  previewLabel?: string;
  /** Accessible name of the dialog itself. */
  ariaLabel?: string;
}

interface CaptureState {
  ready: boolean;
  capturing: boolean;
  previewed: boolean;
  previewUrl: string;
}

/** True when the device lists more than one video input (rear and front). */
async function hasSecondVideoInput(): Promise<boolean> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'videoinput').length > 1;
  } catch {
    return false;
  }
}

export default function FoundItemCamera({
  open,
  onCapture,
  onClose,
  persistedCaptureKey,
  previewLabel = 'Live camera preview',
  ariaLabel = 'Take a photo of the item',
}: FoundItemCameraProps): React.JSX.Element | null {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);

  const [state, setState] = useState<CaptureState>({
    ready: false,
    capturing: false,
    previewed: false,
    previewUrl: '',
  });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [zoomSupported, setZoomSupported] = useState(false);
  const [zoomMin, setZoomMin] = useState(1);
  const [zoomMax, setZoomMax] = useState(1);
  const [zoomStep, setZoomStep] = useState(0.1);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [switchSupported, setSwitchSupported] = useState(false);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');

  /** The single teardown path: every live track stopped, every ref released. */
  const stopTracks = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    trackRef.current = null;
    const video = videoRef.current;
    if (video) {
      video.srcObject = null;
    }
  }, []);

  // Acquire the camera for this open, against the facing mode the switch is
  // currently asking for. Nothing runs on mount: the Finder has already pressed
  // a control by the time this surface exists. The cleanup IS the teardown, so
  // closing the surface, unmounting it or switching camera can never leave a
  // live track behind.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const acquire = async () => {
      try {
        const media = navigator.mediaDevices;
        if (!media || typeof media.getUserMedia !== 'function') {
          throw new Error(
            'This device or browser does not expose a camera. You can still report the item with a photo from your device.',
          );
        }
        const stream = await media.getUserMedia({ video: { facingMode: { ideal: facingMode } } });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const track = stream.getVideoTracks()[0] ?? null;
        const capabilities = (track?.getCapabilities?.() ?? {}) as FoundItemCameraCapabilities;
        streamRef.current = stream;
        trackRef.current = track;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        const secondCamera = await hasSecondVideoInput();
        if (cancelled) {
          stopTracks();
          return;
        }
        const zoom = capabilities.zoom;
        const zoomIsUsable =
          !!zoom && Number.isFinite(zoom.min) && Number.isFinite(zoom.max) && zoom.max > zoom.min;
        setTorchSupported(capabilities.torch === true);
        setTorchOn(false);
        setZoomSupported(zoomIsUsable);
        setZoomMin(zoomIsUsable && zoom ? zoom.min : 1);
        setZoomMax(zoomIsUsable && zoom ? zoom.max : 1);
        setZoomStep(zoomIsUsable && zoom && zoom.step > 0 ? zoom.step : 0.1);
        setZoomLevel(zoomIsUsable && zoom ? zoom.min : 1);
        setSwitchSupported(secondCamera);
        setErrorMsg(null);
        setState((current) => ({ ...current, ready: true, capturing: false }));
      } catch (error) {
        if (cancelled) return;
        setErrorMsg(
          error instanceof Error && error.message
            ? error.message
            : 'This device or browser does not expose a camera. You can still report the item with a photo from your device.',
        );
        setState((current) => ({ ...current, ready: false, capturing: false }));
      }
    };

    void acquire();

    return () => {
      cancelled = true;
      stopTracks();
    };
  }, [open, facingMode, stopTracks]);

  /** Capture the current frame into the canvas, then show it for review. */
  const captureFrame = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d') ?? null;
    if (!video || !canvas || !context || video.videoWidth === 0 || video.videoHeight === 0) {
      setErrorMsg('The camera is not ready yet. Hold still for a moment, then press Capture again.');
      return;
    }
    setState((current) => ({ ...current, capturing: true }));
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    let dataUrl = '';
    try {
      dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    } catch {
      setState((current) => ({ ...current, capturing: false }));
      setErrorMsg('The frame could not be read. Try again, or report the item with a photo from your device.');
      return;
    }
    try {
      window.localStorage.setItem(persistedCaptureKey, dataUrl);
    } catch {
      // Storage can be unavailable (private mode, full quota). The frame still
      // reaches the caller through onCapture, so the report is never blocked.
    }
    setErrorMsg(null);
    setState({ ready: true, capturing: false, previewed: true, previewUrl: dataUrl });
  };

  /** Accept: hand the frame to the report form, then close the surface. */
  const acceptCapture = () => {
    const dataUrl = state.previewUrl;
    if (!dataUrl) return;
    stopTracks();
    onCapture(dataUrl);
    onClose();
  };

  /** Retake: drop the preview. The live track never stopped, so this is instant. */
  const retake = () => {
    setTorchOn(false);
    setErrorMsg(null);
    setState((current) => ({ ...current, previewed: false, previewUrl: '', capturing: false }));
  };

  /** Explicit close — stop first, so no track ever outlives the surface. */
  const close = () => {
    stopTracks();
    onClose();
  };

  const applyTorch = (next: boolean) => {
    const track = trackRef.current;
    if (!track) return;
    const constraints = { advanced: [{ torch: next } as FoundItemCameraConstraints] };
    track
      .applyConstraints(constraints)
      .then(() => setTorchOn(next))
      .catch(() => {
        // The device advertised torch but refused the constraint — hide the
        // control instead of leaving a button that does nothing.
        setTorchSupported(false);
        setTorchOn(false);
      });
  };

  const applyZoom = (next: number) => {
    const clamped = Math.min(Math.max(next, zoomMin), zoomMax);
    const track = trackRef.current;
    if (!track) {
      setZoomLevel(clamped);
      return;
    }
    const constraints = { advanced: [{ zoom: clamped } as FoundItemCameraConstraints] };
    track
      .applyConstraints(constraints)
      .then(() => setZoomLevel(clamped))
      .catch(() => setZoomSupported(false));
  };

  const switchCamera = () => {
    setFacingMode((mode) => (mode === 'environment' ? 'user' : 'environment'));
  };

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      data-testid="camera-view"
    >
      <div className="absolute inset-0" onClick={close} aria-hidden="true" />

      <div className="relative w-full max-w-3xl aspect-[4/3] max-h-[calc(100vh-2rem)] overflow-hidden rounded-panel bg-black shadow-2xl">
        {/* The live element stays mounted in every state, so the captured frame
            can be drawn from it and a retake needs no re-acquisition.
            object-contain keeps the camera's own aspect ratio rather than
            cropping what the Finder is framing. */}
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full bg-black object-contain"
          aria-label={previewLabel}
          autoPlay
          playsInline
          muted
        />
        {state.previewed && (
          <img
            src={state.previewUrl}
            alt={previewLabel}
            className="absolute inset-0 h-full w-full object-contain"
          />
        )}

        {/* Top bar. These controls sit on a photographic backdrop, so they use
            the primitive's own `inverse` variant — the one the design system
            keeps for dark and photographic surfaces — on the same 44px target
            floor as the report form's footer. */}
        <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-black/70 to-transparent px-3 py-3">
          <Button
            variant="inverse"
            size="md"
            onClick={close}
            aria-label="Close camera and return to the report form"
          >
            <X size={ICON_SIZE.heading} aria-hidden="true" />
            <span>Cancel</span>
          </Button>

          <div className="flex items-center gap-2">
            {torchSupported && (
              <Button
                variant="inverse"
                size="md"
                onClick={() => applyTorch(!torchOn)}
                aria-pressed={torchOn}
                aria-label={torchOn ? 'Turn the light off' : 'Turn the light on'}
              >
                {torchOn ? (
                  <Zap size={ICON_SIZE.heading} aria-hidden="true" />
                ) : (
                  <Flashlight size={ICON_SIZE.heading} aria-hidden="true" />
                )}
              </Button>
            )}

            {zoomSupported && !state.previewed && (
              <div className="flex items-center gap-1">
                <Button
                  variant="inverse"
                  size="md"
                  onClick={() => applyZoom(zoomLevel - zoomStep)}
                  disabled={zoomLevel <= zoomMin}
                  aria-label="Zoom out"
                >
                  <Minus size={ICON_SIZE.heading} aria-hidden="true" />
                </Button>
                <span className="text-caption font-bold text-white" aria-live="polite">
                  {zoomLevel.toFixed(1)}x
                </span>
                <Button
                  variant="inverse"
                  size="md"
                  onClick={() => applyZoom(zoomLevel + zoomStep)}
                  disabled={zoomLevel >= zoomMax}
                  aria-label="Zoom in"
                >
                  <Plus size={ICON_SIZE.heading} aria-hidden="true" />
                </Button>
              </div>
            )}

            {switchSupported && !state.previewed && (
              <Button
                variant="inverse"
                size="md"
                onClick={switchCamera}
                aria-label="Switch between the rear and the front camera"
              >
                <SwitchCamera size={ICON_SIZE.heading} aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>

        {/* No camera, or permission refused: the same surface, and the only
            control is the way out, so a denied camera never traps the Finder. */}
        {!state.ready && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/70 p-6 text-center">
            {errorMsg ? (
              <Camera size={ICON_SIZE.feature} className="text-white" aria-hidden="true" />
            ) : (
              <Loader2
                size={ICON_SIZE.feature}
                className="animate-spin text-white"
                aria-hidden="true"
              />
            )}
            <p className="max-w-sm text-body text-white" role="status" aria-live="polite">
              {errorMsg ?? 'Preparing the camera…'}
            </p>
            <Button variant="inverse" size="md" onClick={close}>
              <span>Close</span>
            </Button>
          </div>
        )}

        {/* Live view: the capture action is the accent CTA, on the lg step. */}
        {state.ready && !state.previewed && (
          <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 bg-gradient-to-t from-black/70 to-transparent px-4 pb-5 pt-10">
            <Button
              variant="accent"
              size="lg"
              onClick={captureFrame}
              disabled={state.capturing}
              aria-busy={state.capturing || undefined}
            >
              {state.capturing ? (
                <Loader2 size={ICON_SIZE.heading} className="animate-spin" aria-hidden="true" />
              ) : (
                <Camera size={ICON_SIZE.heading} aria-hidden="true" />
              )}
              <span>Capture</span>
            </Button>
            <p className="text-small text-white/80">
              Frame the item, then press Capture. Nothing is added to your report until you use
              the photo.
            </p>
          </div>
        )}

        {/* Review: retake, or accept. Accept is the only path into the report
            form, and it stops every track before it takes that path. */}
        {state.previewed && (
          <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 bg-gradient-to-t from-black/80 to-transparent px-4 pb-5 pt-10">
            <p className="text-body-large font-bold text-white" role="status" aria-live="polite">
              Photo captured
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button variant="inverse" size="lg" onClick={retake}>
                <RotateCcw size={ICON_SIZE.heading} aria-hidden="true" />
                <span>Retake</span>
              </Button>
              <Button
                variant="accent"
                size="lg"
                onClick={acceptCapture}
                disabled={!state.previewUrl}
              >
                <CheckCheck size={ICON_SIZE.heading} aria-hidden="true" />
                <span>Use this photo</span>
              </Button>
            </div>
          </div>
        )}
      </div>

      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
    </div>
  );

}
