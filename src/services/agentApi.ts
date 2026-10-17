import type {
  AgentMutationResponse,
  AgentPayoutChangeRequestResponse,
  AgentPayoutSettingsResponse,
  AgentQueueResponse,
  ConfirmDropoffPayload,
  ConfirmHandoverPayload,
  RejectDropoffPayload,
  VerifyAgentItemPayload,
} from '../types/agent';

export class AgentApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'AgentApiError';
    this.status = status;
    this.code = code;
  }
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function jsonHeaders(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', ...authHeaders(token) };
}

async function parseJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function request<T>(token: string, path: string, init: RequestInit, fallbackMessage: string): Promise<T> {
  const response = await fetch(path, { ...init, headers: init.headers ?? authHeaders(token) });
  const data = await parseJson(response);
  if (!response.ok) {
    const message = typeof data?.error === 'string' && data.error.trim() ? data.error.trim() : fallbackMessage;
    const code = typeof data?.code === 'string' ? data.code : null;
    throw new AgentApiError(message, response.status, code);
  }
  if (data === null) throw new AgentApiError(fallbackMessage, response.status);
  return data as T;
}

export const agentApi = {
  getQueue(token: string): Promise<AgentQueueResponse> {
    return request<AgentQueueResponse>(token, '/api/agents/queue', {
      method: 'GET',
      headers: authHeaders(token),
    }, '');
  },

  verifyItem(token: string, payload: VerifyAgentItemPayload): Promise<AgentMutationResponse> {
    return request<AgentMutationResponse>(token, '/api/agents/verify-item', {
      method: 'POST', headers: jsonHeaders(token), body: JSON.stringify(payload),
    }, 'Verification failed');
  },

  confirmDropoff(token: string, payload: ConfirmDropoffPayload): Promise<AgentMutationResponse> {
    return request<AgentMutationResponse>(token, '/api/agents/confirm-dropoff', {
      method: 'POST', headers: jsonHeaders(token), body: JSON.stringify(payload),
    }, 'Approval failed');
  },

  rejectDropoff(token: string, payload: RejectDropoffPayload): Promise<AgentMutationResponse> {
    return request<AgentMutationResponse>(token, '/api/agents/reject-dropoff', {
      method: 'POST', headers: jsonHeaders(token), body: JSON.stringify(payload),
    }, 'Reject drop-off failed');
  },

  confirmViewing(token: string, claimId: string): Promise<AgentMutationResponse> {
    return request<AgentMutationResponse>(token, `/api/agents/claims/${encodeURIComponent(claimId)}/confirm-viewing`, {
      method: 'POST', headers: jsonHeaders(token),
    }, 'Confirm viewing failed');
  },

  confirmHandover(token: string, payload: ConfirmHandoverPayload): Promise<AgentMutationResponse> {
    return request<AgentMutationResponse>(token, '/api/agents/confirm-handover', {
      method: 'POST', headers: jsonHeaders(token), body: JSON.stringify(payload),
    }, 'Confirm handover failed');
  },

  /**
   * AGENT DASHBOARD BATCH 2 — my payout settings.
   *
   * The response contains a MASKED destination only. The full number is never
   * downloaded to the browser, so the form can never echo a stored value back.
   */
  getPayoutSettings(token: string): Promise<AgentPayoutSettingsResponse> {
    return request<AgentPayoutSettingsResponse>(token, '/api/agents/payout-settings', {
      method: 'GET', headers: authHeaders(token),
    }, 'Could not load payout settings');
  },

  /**
   * Submit a proposed Personal M-Pesa replacement. The number is sent once, over
   * the authenticated request; it is never read back.
   */
  requestPayoutDestinationChange(
    token: string,
    destination: string,
  ): Promise<AgentPayoutChangeRequestResponse> {
    return request<AgentPayoutChangeRequestResponse>(
      token,
      '/api/agents/payout-settings/change-request',
      {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({ destination, payoutMethodType: 'Personal M-Pesa' }),
      },
      'Could not submit payout destination change',
    );
  },
};
