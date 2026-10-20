import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AdminAgentPayoutChangeApiError,
  agentPayoutChangeActionPath,
  agentPayoutChangesListPath,
  approveAgentPayoutDestinationChange,
  attestAgentPayoutDestinationChange,
  fetchAgentPayoutDestinationChanges,
  mapAgentPayoutAdminView,
  rejectAgentPayoutDestinationChange,
} from '../adminAgentPayoutDestinationChangesApi';

// =============================================================================
// PHASE 2 — THE ADMIN PAYOUT-DESTINATION-CHANGE REQUEST CONTRACT
// =============================================================================
// These are BEHAVIOUR tests of the React-free client the new Admin Console panel
// uses. They pin the parts a rendering test cannot:
//
//   * the exact route each control calls;
//   * the exact JSON body, so the password / note / reason fields cannot drift;
//   * the fixed attestation method (the body cannot express SMS or a code);
//   * the server's refusal code and message reaching the operator unchanged;
//   * a 403 permission denial being distinguishable from a generic failure.
// =============================================================================

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(result: Response | Error) {
  const mock = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

const ADMIN_VIEW = {
  id: 'APDC-ABC123',
  agent_id: 'agent-1',
  status: 'pending_verification',
  masked_proposed_destination: '0712***678',
  proposed_payout_method: 'personal_mpesa',
  destination_format_eligible: true,
  phone_verification: 'not_verified',
  phone_verified_at: null,
  attestation: 'not_attested',
  attested_at: null,
  attestation_method: null,
  admin_approval: 'not_requested',
  admin_approved_at: null,
  admin_rejected_at: null,
  rejection_reason: null,
  created_at: '2026-10-01T08:30:00.000Z',
  expires_at: '2026-10-15T08:30:00.000Z',
  activated_at: null,
  can_activate: false,
  activation_blockers: ['attestation_required', 'admin_approval_required'],
  attested_by: null,
  attestation_note: null,
  attestation_failure: 'attestation_missing',
  admin_approved_by: null,
  admin_rejected_by: null,
  attester_approver_conflict: false,
  timeline: [
    {
      key: 'requested',
      state: 'done',
      label: 'Change requested by the agent (format check only)',
      at: '2026-10-01T08:30:00.000Z',
      actor: null,
      note: null,
      next_action: null,
    },
  ],
};

describe('paths and list reads', () => {
  it('builds the documented paths without a component hand-concatenating a URL', () => {
    expect(agentPayoutChangesListPath()).toBe('/api/admin/agent-payout-destination-changes');
    expect(agentPayoutChangesListPath({ status: 'rejected', limit: 25, offset: 50 })).toBe(
      '/api/admin/agent-payout-destination-changes?status=rejected&limit=25&offset=50',
    );
    expect(agentPayoutChangeActionPath('APDC-1', 'attest')).toBe(
      '/api/admin/agent-payout-destination-changes/APDC-1/attest',
    );
  });

  it('reads the list with the session token and maps only the administrator projection', async () => {
    const mock = stubFetch(jsonResponse({ requests: [ADMIN_VIEW], has_more: false }));
    const result = await fetchAgentPayoutDestinationChanges('token-1', {
      status: 'pending_verification',
      limit: 25,
    });

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].masked_proposed_destination).toBe('0712***678');
    expect(result.has_more).toBe(false);
    const [path, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(
      '/api/admin/agent-payout-destination-changes?status=pending_verification&limit=25',
    );
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
  });

  it('refuses to fabricate a row from a malformed response', () => {
    expect(() => mapAgentPayoutAdminView({ id: 'x' })).toThrow(/malformed|timeline/i);
  });

  it('does not call the network without a session', async () => {
    const mock = stubFetch(jsonResponse({ requests: [], has_more: false }));
    await expect(fetchAgentPayoutDestinationChanges(null)).rejects.toBeInstanceOf(
      AdminAgentPayoutChangeApiError,
    );
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('the three administrator actions send exactly the route contract', () => {
  it('attests with { password, note } and never a caller-chosen method', async () => {
    const mock = stubFetch(
      jsonResponse({
        success: true,
        attested: true,
        message: 'Phone-call attestation recorded.',
        request: ADMIN_VIEW,
      }),
    );
    await attestAgentPayoutDestinationChange('token-1', 'APDC-ABC123', {
      password: 'admin-password',
      note: 'Called the agent and confirmed the number.',
    });

    const [path, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/admin/agent-payout-destination-changes/APDC-ABC123/attest');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      password: 'admin-password',
      note: 'Called the agent and confirmed the number.',
    });
    // The method is fixed server-side. The UI cannot express SMS, WhatsApp, a
    // code or an email OTP.
    expect(String(init.body)).not.toContain('method');
    expect(String(init.body)).not.toContain('sms');
    expect(String(init.body)).not.toContain('code');
  });

  it('approves with { password } and surfaces the server refusal unchanged', async () => {
    const mock = stubFetch(
      jsonResponse(
        {
          code: 'ATTESTER_APPROVER_CONFLICT',
          error: 'You recorded the phone-call attestation for this change, so a DIFFERENT administrator must approve it.',
          approved: false,
          activated: false,
          request: ADMIN_VIEW,
        },
        409,
      ),
    );
    let caught: unknown = null;
    try {
      await approveAgentPayoutDestinationChange('token-1', 'APDC-ABC123', { password: 'admin-password' });
    } catch (error) {
      caught = error;
    }

    const [path, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/admin/agent-payout-destination-changes/APDC-ABC123/approve');
    expect(JSON.parse(String(init.body))).toEqual({ password: 'admin-password' });
    expect(caught).toBeInstanceOf(AdminAgentPayoutChangeApiError);
    const failure = caught as AdminAgentPayoutChangeApiError;
    expect(failure.kind).toBe('conflict');
    expect(failure.status).toBe(409);
    expect(failure.code).toBe('ATTESTER_APPROVER_CONFLICT');
    expect(failure.message).toContain('DIFFERENT administrator');
    expect(failure.request?.id).toBe('APDC-ABC123');
  });

  it('rejects with the required reason and no invented password field', async () => {
    const mock = stubFetch(
      jsonResponse({ success: true, rejected: true, message: 'The change was rejected.', request: ADMIN_VIEW }),
    );
    await rejectAgentPayoutDestinationChange('token-1', 'APDC-ABC123', {
      reason: 'The number does not belong to this agent.',
    });

    const [path, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/admin/agent-payout-destination-changes/APDC-ABC123/reject');
    expect(JSON.parse(String(init.body))).toEqual({
      reason: 'The number does not belong to this agent.',
    });
  });

  it('distinguishes a permission denial from a generic failure', async () => {
    stubFetch(jsonResponse({ error: 'Forbidden' }, 403));
    const caught = await approveAgentPayoutDestinationChange('token-1', 'APDC-ABC123', {
      password: 'admin-password',
    }).catch((error) => error);
    expect(caught).toBeInstanceOf(AdminAgentPayoutChangeApiError);
    expect((caught as AdminAgentPayoutChangeApiError).kind).toBe('forbidden');
    expect((caught as AdminAgentPayoutChangeApiError).message).toMatch(/not permitted/i);
  });
});
