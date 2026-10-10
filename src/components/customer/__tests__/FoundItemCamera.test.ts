// PHASE 3 — FOUND-ITEM CAMERA REGRESSION CONTRACTS.
//
// The repository has no DOM harness (vitest environment: 'node'), so this file
// uses the same two devices as the rest of the suite:
//
//   1. a SOURCE CONTRACT — the shipped file is read from disk with its comments
//      removed, and the lifecycle/capability rules are asserted against the code
//      that actually ships, so prose can neither satisfy a "must exist" pin nor
//      defeat a "must never come back" tripwire;
//   2. a SERVER RENDER of the shell — renderToStaticMarkup() proves which region
//      is emitted for a given prop without a browser.
//
// The capture itself is never exercised: no media device is opened and no
// network request is made.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import FoundItemCamera from '../FoundItemCamera';

const CAMERA_TSX = fs.readFileSync(path.resolve(__dirname, '..', 'FoundItemCamera.tsx'), 'utf8');

/** The shipped source with comments removed and line endings normalised. */
const SOURCE = CAMERA_TSX
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
  .replace(/(^|[\s{(,;=[])\/\*[\s\S]*?\*\//g, '$1')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  .replace(/\r\n/g, '\n');

const FINDER = fs.readFileSync(path.resolve(__dirname, '..', '..', 'FinderView.tsx'), 'utf8');

const baseProps = {
  open: false,
  onCapture: vi.fn(),
  onClose: vi.fn(),
  persistedCaptureKey: 'foundItemPhoto',
};

const render = (props: Partial<React.ComponentProps<typeof FoundItemCamera>> = {}) =>
  renderToStaticMarkup(React.createElement(FoundItemCamera, { ...baseProps, ...props }));

describe('FoundItemCamera render contract (server render)', () => {
  it('renders nothing while it is closed', () => {
    const html = render({ open: false });
    expect(html).not.toContain('camera-view');
    expect(html).not.toContain('aria-modal');
    expect(html).not.toContain('<video');
  });

  it('renders ONE labelled dialog region, and never distorts the frame', () => {
    const html = render({ open: true, ariaLabel: 'Take a snap of the item' });
    expect(html).toContain('data-testid="camera-view"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Take a snap of the item"');
    expect(html).toContain('<video');
    // object-contain, so the camera's own aspect ratio is never cropped.
    expect(html).toContain('object-contain');
    expect(html).toContain('<canvas');
  });

  it('opens in the acquiring state: one way out, and no capture before a frame exists', () => {
    const html = render({ open: true });
    expect(html).toContain('aria-label="Close camera and return to the report form"');
    expect(html).toContain('Preparing the camera');
    // Capture and review belong to the states that follow the live stream.
    expect(html).not.toContain('>Capture<');
    expect(html).not.toContain('Use this photo');
    expect(html).not.toContain('Retake');
  });

  it('never captures without a gesture', () => {
    const onCapture = vi.fn();
    const onClose = vi.fn();
    render({ open: true, onCapture, onClose });
    expect(onCapture).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('FoundItemCamera lifecycle contract (shipped source)', () => {
  it('acquires the camera only after the surface opens, and tears it down', () => {
    expect(SOURCE).toContain('const stopTracks = useCallback(() => {');
    expect(SOURCE).toContain('.forEach((track) => track.stop());');
    expect(SOURCE).toContain('streamRef.current = null;');
    expect(SOURCE).toContain('video.srcObject = null;');
    // The acquisition effect is gated on `open` and cleans up through the SAME
    // path, so close, unmount and camera-switch cannot leak a live track.
    expect(SOURCE).toContain('if (!open) return;');
    expect(SOURCE).toContain('cancelled = true;');
    expect(SOURCE).toContain('}, [open, facingMode, stopTracks]);');
  });

  it('stops every track BEFORE the frame is handed over or dropped', () => {
    const accept = SOURCE.slice(SOURCE.indexOf('const acceptCapture'), SOURCE.indexOf('const retake'));
    const stopAt = accept.indexOf('stopTracks();');
    expect(stopAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(accept.indexOf('onCapture(dataUrl);'));
    expect(accept.indexOf('onCapture(dataUrl);')).toBeLessThan(accept.indexOf('onClose();'));

    const close = SOURCE.slice(SOURCE.indexOf('const close = () => {'), SOURCE.indexOf('const applyTorch'));
    expect(close.indexOf('stopTracks();')).toBeLessThan(close.indexOf('onClose();'));
  });

  it('captures one JPEG and mirrors it under the caller key, without blocking on storage', () => {
    expect(SOURCE).toContain("canvas.toDataURL('image/jpeg', 0.92)");
    expect(SOURCE).toContain('context.drawImage(video, 0, 0, canvas.width, canvas.height);');
    expect(SOURCE).toContain('window.localStorage.setItem(persistedCaptureKey, dataUrl);');
    // A private-mode/quota failure is swallowed, so the report is never blocked:
    // the best-effort write is followed by the state that publishes the preview.
    expect(CAMERA_TSX.indexOf('window.localStorage.setItem')).toBeLessThan(
      CAMERA_TSX.indexOf('previewed: true, previewUrl: dataUrl'),
    );
  });

  it('reads the real track capabilities instead of assuming them', () => {
    expect(SOURCE).toContain('interface FoundItemCameraCapabilities extends MediaTrackCapabilities {');
    expect(SOURCE).toContain('torch?: boolean;');
    expect(SOURCE).toContain('zoom?: { min: number; max: number; step: number };');
    expect(SOURCE).toContain('track?.getCapabilities?.()');
    expect(SOURCE).toContain('navigator.mediaDevices.enumerateDevices()');
    expect(SOURCE).toContain('getUserMedia({ video: { facingMode: { ideal: facingMode } } })');
    // Each extra control is gated on what the device actually reported.
    for (const gate of [
      '{torchSupported && (',
      '{zoomSupported && !state.previewed && (',
      '{switchSupported && !state.previewed && (',
    ]) {
      expect(SOURCE, `missing capability gate ${gate}`).toContain(gate);
    }
  });

  it('degrades gracefully when the device has no camera at all', () => {
    expect(SOURCE).toContain('This device or browser does not expose a camera.');
    expect(SOURCE).toContain("errorMsg ?? 'Preparing the camera");
    // The unavailable state still offers the single way out.
    expect(SOURCE).toContain('variant="inverse"');
  });
});

describe('FoundItemCamera design-system contract', () => {
  it('builds on the shared primitives and the icon ladder', () => {
    expect(SOURCE).toContain("import { Button, ICON_SIZE } from '../ui';");
    expect(SOURCE).toContain('variant="accent"');
    expect(SOURCE).toContain('variant="inverse"');
    // Every icon takes its size from the shared ladder and is decorative.
    expect(SOURCE).not.toMatch(/size=\{\d+\}/);
    expect(SOURCE).toMatch(/size=\{ICON_SIZE\.(metadata|ui|emphasis|heading|feature)\}/);
    expect((SOURCE.match(/aria-hidden="true"/g) || []).length).toBeGreaterThanOrEqual(12);
  });

  it('keeps the 44px target floor and adds no off-ladder type or focus treatment', () => {
    expect(SOURCE).toContain('size="md"');
    expect(SOURCE).toContain('size="lg"');
    expect(SOURCE).not.toContain('size="sm"');
    expect(SOURCE).not.toMatch(/text-\[\d+px\]/);
    expect(SOURCE).toContain('rounded-panel');
    expect(SOURCE).not.toContain('outline-none');
    expect(SOURCE).not.toContain('focus:ring');
    expect(SOURCE).not.toContain('focus-visible:');
  });

  it('takes every chromatic colour of the capture chrome from the design system', () => {
    expect(SOURCE).not.toMatch(
      /\b(?:bg|text|border|ring)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?\b/,
    );
  });
});

describe('FoundItemCamera is the surface the found-item report opens', () => {
  it('is imported and driven by FinderView, with the upload fallback intact', () => {
    expect(FINDER).toContain("import FoundItemCamera from './customer/FoundItemCamera';");
    expect(FINDER).toContain('<FoundItemCamera open={useCamera}');
    expect(FINDER).toContain('persistedCaptureKey="foundItemPhoto"');
    expect(FINDER).toContain('const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {');
    expect(FINDER).toContain("fetch('/api/items/analyze'");
  });
});

