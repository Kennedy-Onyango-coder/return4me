import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// PHASE 2 — THE ADMIN CONSOLE PANEL IS WIRED TO THE EXISTING ROUTES
// =============================================================================
// This repository has no jsdom/RTL harness, so the interaction contract is
// pinned the way the other console tests pin it: against shipped source, with
// the React-free request client's behaviour covered separately by
// services/__tests__/adminAgentPayoutDestinationChangesApi.test.ts.
//
// These assertions prove:
//   * the panel is DISCOVERABLE in the Payout Integrity section;
//   * each control calls the intended client method with the required body;
//   * the approval control is withheld from the attesting administrator;
//   * one in-flight action blocks a duplicate submission;
//   * success, refusal, permission and load errors have visible states;
//   * the screen never claims SMS/email verification or renders a raw number.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../../../../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

const adminView = read('src/components/AdminView.tsx');
const panel = read('src/components/admin/payouts/AgentPayoutDestinationChangesPanel.tsx');
const client = read('src/services/adminAgentPayoutDestinationChangesApi.ts');
const presentation = read(
  'src/components/admin/payouts/agentPayoutDestinationChangesPresentation.ts',
);

const sliceBetween = (src: string, start: string, end: string) => {
  const from = src.indexOf(start);
  const to = from === -1 ? -1 : src.indexOf(end, from + start.length);
  return from === -1 || to === -1 ? '' : src.slice(from, to);
};

describe('the workflow is discoverable in Payout Integrity', () => {
  it('mounts the panel in the payouts section and passes the signed-in administrator', () => {
    const section = sliceBetween(adminView, "{activeTab === 'payouts' && (", "{activeTab === 'audit' && (");
    expect(section.length).toBeGreaterThan(0);
    expect(section).toContain('<AgentPayoutDestinationChangesPanel');
    expect(section).toContain('token={token}');
    expect(section).toContain('currentAdministrator={adminIdentity.username}');
  });

  it('uses the existing routes rather than inventing new endpoints', () => {
    expect(client).toContain(
      "export const ADMIN_AGENT_PAYOUT_CHANGES_PATH = '/api/admin/agent-payout-destination-changes'",
    );
    expect(client).toContain("agentPayoutChangeActionPath(changeId, 'attest')");
    expect(client).toContain("agentPayoutChangeActionPath(changeId, 'approve')");
    expect(client).toContain("agentPayoutChangeActionPath(changeId, 'reject')");
  });
});

describe('each control calls its route with the required payload', () => {
  it('records the attestation with a password and a bounded note, and no method field', () => {
    expect(panel).toContain('attestAgentPayoutDestinationChange(token, detail.id, {');
    expect(panel).toContain('password: attestPassword,');
    expect(panel).toContain('note,');
    expect(panel).toContain('maxLength={AGENT_PAYOUT_ATTESTATION_NOTE_MAX_LENGTH}');
    expect(panel).toContain('AGENT_PAYOUT_ATTESTATION_METHOD');
    expect(panel).not.toContain("name={'method'}");
    expect(panel).not.toContain('SMS verified');
    expect(panel).not.toContain('email OTP verified');
  });

  it('records a separate approval with its own password re-entry', () => {
    expect(panel).toContain('approveAgentPayoutDestinationChange(token, detail.id, {');
    expect(panel).toContain('password: approvePassword,');
    expect(panel).toContain("autoComplete={'current-password'}");
  });

  it('rejects with a required bounded reason and no password field the route does not require', () => {
    expect(panel).toContain('rejectAgentPayoutDestinationChange(token, detail.id, { reason })');
    expect(panel).toContain('maxLength={AGENT_PAYOUT_CHANGE_MAX_REJECTION_REASON_LENGTH}');
    expect(panel).toContain('A rejection reason is required.');
  });

  it('withholds approval from the attester and says why', () => {
    expect(panel).toContain('approvalActionFor(detail, currentAdministrator)');
    expect(presentation).toContain("reason: 'same_administrator'");
    expect(presentation).toContain('A DIFFERENT administrator must approve it.');
  });

  it('sends one request per deliberate submission', () => {
    expect(panel).toContain('if (!detail || actionInFlight !== null) return;');
    expect(panel).toContain("setActionInFlight('attest')");
    expect(panel).toContain("setActionInFlight('approve')");
    expect(panel).toContain("setActionInFlight('reject')");
    // Every credential is cleared on both success and failure.
    expect(panel).toContain("setAttestPassword('')");
    expect(panel).toContain("setApprovePassword('')");
  });
});

describe('the screen is truthful about evidence and state', () => {
  it('renders the masked destination only', () => {
    expect(panel).toContain('detail.masked_proposed_destination');
    expect(panel).not.toMatch(/\.proposed_destination\b/);
    expect(panel).toContain('the full number never leaves the server');
  });

  it('distinguishes a phone-call attestation from phone verification', () => {
    expect(panel).toContain('An attestation is NOT phone verification');
    expect(panel).toContain('No code was sent');
    expect(panel).toContain('this screen cannot send an SMS');
    expect(panel).toContain('Phone verification (delivery channel)');
  });

  it('renders Requested, Attested, Approved, Activated, Rejected and Expired', () => {
    const timeline = read('src/config/agentPayoutVerification.ts');
    expect(timeline).toContain("key: 'requested'");
    expect(timeline).toContain("key: 'attested'");
    expect(timeline).toContain("key: 'approved'");
    expect(timeline).toContain("key: 'activated'");
    expect(presentation).toContain("key: 'rejected'");
    expect(presentation).toContain("key: 'expired'");
    expect(panel).toContain('buildAgentPayoutTimeline(detail)');
  });

  it('keeps pending, success, refusal and error states visible', () => {
    expect(panel).toContain('setListError(');
    expect(panel).toContain('setDetailError(');
    expect(panel).toContain('setActionError(');
    expect(panel).toContain('setActionMessage(');
    expect(panel).toContain('applyUpdatedRequest(result.request)');
    expect(panel).toContain("handleActionError('attest', error)");
    expect(panel).toContain("handleActionError('approve', error)");
    expect(panel).toContain("handleActionError('reject', error)");
    expect(panel).toContain('loading={listLoading}');
    expect(panel).toContain("loading={actionInFlight === 'attest'}");
    expect(panel).toContain('setActionError({ message: error.message, code: error.code })');
  });

  it('re-reads on conflict and on refresh without re-sending an action', () => {
    expect(panel).toContain("if (error.kind === 'conflict' || error.kind === 'not_found')");
    expect(panel).toContain('refreshList();');
    expect(panel).toContain('const refreshList = useCallback');
    expect(panel).toContain('fetchAgentPayoutDestinationChange(token, selectedId)');
  });
});
