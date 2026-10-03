import type {
  AgentMutationResponse,
  AgentQueueResponse,
  ConfirmDropoffPayload,
  ConfirmHandoverPayload,
  RejectDropoffPayload,
  VerifyAgentItemPayload,
} from '../types/agent';

export class AgentApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'AgentApiError';
    this.status = status;
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
    throw new AgentApiError(message, response.status);
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
};
