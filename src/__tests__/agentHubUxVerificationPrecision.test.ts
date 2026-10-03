// AGENTHUB UX MODERNIZATION BATCH 4 - verification form precision.
//
// UX-06: the verification error is a GENERIC server message, so no field
// mapping is possible (see the Batch 4 report). These tests prove nothing
// was fabricated and that form-level semantics are truthful.
//
// UX-04-adjacent: the panel has ONE submit action whose label changed from
// four compound English-only strings to a single-consequence label plus a
// truthful bilingual consequence hint.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(process.cwd(), 'src');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const PANEL = read('components/agent/AgentVerificationPanel.tsx');
const HUB = read('components/agent/AgentHub.tsx');
const TRANSLATIONS = read('types.ts');
const SURFACE = PANEL + HUB;

// Strip comments so a phrase asserted absent cannot be satisfied by prose.
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

describe('AGENTHUB UX BATCH 4 - verification form precision', () => {
  // ---------------------------------------------------------------- errors
  it('keeps the verification error form-level and fabricates no field mapping', () => {
    const panelCode = code(PANEL);
    expect(panelCode).toMatch(/role="alert"/);
    expect(panelCode).not.toMatch(/aria-invalid/);
    expect(panelCode).not.toMatch(/agent-verify-error-/);
  });

  it('does not nest a second live region around the alert', () => {
    const panelCode = code(PANEL);
    expect(panelCode).not.toMatch(/role="alert"[^>]*aria-live/);
    expect((panelCode.match(/role="alert"/g) || []).length).toBe(1);
  });

  it('preserves the existing field ids and label associations', () => {
    for (const id of [
      'agent-verify-category',
      'agent-verify-doc-name',
      'agent-verify-doc-number',
      'agent-verify-description',
      'agent-verify-exact-place',
      'agent-verify-reason',
      'agent-verify-reason-detail',
    ]) {
      expect(PANEL).toContain(`id="${id}"`);
      expect(PANEL).toContain(`htmlFor="${id}"`);
    }
  });

  it('keeps the sensitive guard, physical check, and outcome selection intact', () => {
    const panelCode = code(PANEL);
    expect(panelCode).toMatch(/is_sensitive_document/);
    expect(panelCode).toMatch(/verifyPhysicallyChecked/);
    expect(panelCode).toMatch(
      /hasCorrections\(item\) \? 'corrected' : 'confirmed'/
    );
  });

  it('preserves busy semantics and the shared submit handler', () => {
    expect(PANEL).toContain('aria-busy={isItemBusy(item.id)}');
    expect(PANEL).toContain('disabled={isItemBusy(item.id)}');
    expect(PANEL).toContain('handleSubmitVerification');
  });

  // ------------------------------------------------------- action hierarchy
  it('replaces the four compound labels with a single-consequence label', () => {
    const panelCode = code(PANEL);
    for (const legacy of [
      'Save Corrections & Approve',
      'Save Corrections & Continue',
      'Confirm As Reported & Approve',
      'Confirm As Reported',
    ]) {
      expect(panelCode).not.toContain(legacy);
    }
    expect(panelCode).toMatch(
      /hasCorrections\(item\) \? t\.agentVerifySaveCorrections : t\.agentVerifyConfirmReported/
    );
  });

  it('states the real consequence of the current state instead of hiding it', () => {
    const panelCode = code(PANEL);
    expect(panelCode).toMatch(
      /verifyPhysicallyChecked \? t\.agentVerifyApprovesToo : t\.agentVerifySavesOnly/
    );
    expect(panelCode).toMatch(/t\.agentVerifySubmitHint/);
  });

  it('uses bilingual infrastructure and passes t from the parent', () => {
    expect(PANEL).toMatch(/^\s*t: any;$/m);
    expect(HUB).toContain('t={t}');
    expect(PANEL).not.toMatch(/useLang|setLang/);
  });

  it('adds every new key to both translation bundles with parity', () => {
    for (const key of [
      'agentVerifyConfirmReported',
      'agentVerifySaveCorrections',
      'agentVerifyApprovesToo',
      'agentVerifySavesOnly',
      'agentVerifySubmitHint',
    ]) {
      const occurrences = TRANSLATIONS.split(`${key}:`).length - 1;
      expect(occurrences).toBe(2); // English + Kiswahili
    }
  });

  it('implies no payment, refund, payout, or claim-approval consequence', () => {
    // Bounded to ONLY the five new verification values, so the neighbouring
    // Batch 2 rejection keys (which legitimately mention payment) are not
    // swept into this assertion.
    const enBlock =
      TRANSLATIONS.split('agentVerifyConfirmReported:')[1]?.split('//')[0] ?? '';
    for (const forbidden of [
      'payment',
      'refund',
      'payout',
      'paid',
      'mpesa',
      'claim approved',
    ]) {
      expect(enBlock.toLowerCase()).not.toContain(forbidden);
    }
  });

  // -------------------------------------------------------- architecture
  it('keeps the panel presentation-only and hook-free', () => {
    const panelCode = code(PANEL);
    for (const hook of [
      'useState',
      'useEffect',
      'useMemo',
      'useCallback',
      'useReducer',
      'useRef',
    ]) {
      expect(panelCode).not.toContain(hook);
    }
    expect(panelCode).not.toMatch(/fetch\(/);
    expect(panelCode).not.toContain('agentApi');
    expect(panelCode).not.toContain('useAgentOperations');
  });

  it('leaves AgentHub hook-free and keeps one category map', () => {
    const hubCode = code(HUB);
    for (const hook of [
      'useState',
      'useEffect',
      'useMemo',
      'useCallback',
      'useReducer',
      'useRef',
    ]) {
      expect(hubCode).not.toContain(hook);
    }
    expect((SURFACE.match(/categories\.map\(/g) || []).length).toBe(1);
  });

  it('preserves the Batch 1 focus contract', () => {
    expect(PANEL).toMatch(/panelFocusRef\(item\.id, 'verify'\)/);
    expect(PANEL).toContain('tabIndex={-1}');
    expect(HUB).toContain("panelTriggerId(item.id, 'verify')");
  });

  it('preserves the Batch 2 destructive rejection contract untouched', () => {
    const rejection = read('components/agent/AgentRejectionPanel.tsx');
    expect(rejection).toMatch(/panelFocusRef\(item\.id, 'reject'\)/);
    expect(HUB).toMatch(/variant="danger"/);
  });
});
