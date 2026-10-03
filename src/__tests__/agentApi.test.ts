import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRejectionPayload } from '../hooks/useAgentOperations';
import { AgentApiError, agentApi } from '../services/agentApi';

// Pure operational helpers are testable without a DOM harness: the rejection
// reason contract is deterministic, React-free, and localization-free.
describe('useAgentOperations pure helpers', () => {
  it('passes a preset rejection reason through unchanged', () => {
    expect(buildRejectionPayload('Not a real item', 'ignored')).toEqual({ reason: 'Not a real item' });
  });

  it('prefixes a custom reason only for the "Other" preset', () => {
    expect(buildRejectionPayload('Other', 'Wrong category')).toEqual({ reason: 'Other: Wrong category' });
  });

  it('keeps an empty custom reason visible rather than silently dropping it', () => {
    expect(buildRejectionPayload('Other', '')).toEqual({ reason: 'Other: ' });
  });
});

const response = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
  ...init,
});

describe('typed operational Agent API transport', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('gets the queue with an explicit bearer token and returns the existing projection', async () => {
    const queue = { agent: { id: 'agent-1' }, earnings: { totalEarned: 0, completedPayoutsCount: 0 }, pendingDropoffs: [], holdingItems: [] };
    fetchMock.mockResolvedValue(response(queue));
    await expect(agentApi.getQueue('agent-token')).resolves.toEqual(queue);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/queue', expect.objectContaining({
      method: 'GET', headers: { Authorization: 'Bearer agent-token' },
    }));
  });

  it('verifies an item with the exact existing payload', async () => {
    fetchMock.mockResolvedValue(response({ success: true, message: 'Saved' }));
    const payload = { dropoffCode: 'R4M-1', categoryId: 'phone', name: null, documentNumber: null, description: null, foundArea: 'Near market', reason: '', reasonDetail: null, physicallyVerified: true };
    await agentApi.verifyItem('token', payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/verify-item', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' }, body: JSON.stringify(payload),
    }));
  });

  it('confirms drop-off, rejects drop-off, confirms viewing, and confirms handover with unchanged contracts', async () => {
    fetchMock.mockImplementation(async () => response({ success: true, message: 'Done' }));
    await agentApi.confirmDropoff('token', { dropoffCode: 'R4M-1' });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/agents/confirm-dropoff', expect.objectContaining({ method: 'POST', body: JSON.stringify({ dropoffCode: 'R4M-1' }) }));

    await agentApi.rejectDropoff('token', { dropoffCode: 'R4M-1', reason: 'Not a real item' });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/agents/reject-dropoff', expect.objectContaining({ method: 'POST', body: JSON.stringify({ dropoffCode: 'R4M-1', reason: 'Not a real item' }) }));

    await agentApi.confirmViewing('token', 'CLM-1');
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/agents/claims/CLM-1/confirm-viewing', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer token' }) }));

    await agentApi.confirmHandover('token', { claimId: 'CLM-1', pickupCode: '123456', handoverPhotoBase64: 'data:image/jpeg;base64,AA==' });
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/agents/confirm-handover', expect.objectContaining({ method: 'POST', body: JSON.stringify({ claimId: 'CLM-1', pickupCode: '123456', handoverPhotoBase64: 'data:image/jpeg;base64,AA==' }) }));
  });

  it('preserves server error messages and fallback messages', async () => {
    fetchMock.mockResolvedValueOnce(response({ error: 'Not assigned to this Agent.' }, { status: 403 }));
    await expect(agentApi.verifyItem('token', {} as never)).rejects.toMatchObject({ name: 'AgentApiError', message: 'Not assigned to this Agent.', status: 403 });

    fetchMock.mockResolvedValueOnce(response({}, { status: 500 }));
    await expect(agentApi.rejectDropoff('token', { dropoffCode: 'R4M-1', reason: 'x' })).rejects.toEqual(expect.objectContaining({ message: 'Reject drop-off failed', status: 500 }));
  });

  it('turns a malformed successful response into the existing fallback error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not-json', { status: 200 }));
    await expect(agentApi.confirmHandover('token', { claimId: 'CLM-1', pickupCode: '1', handoverPhotoBase64: null })).rejects.toBeInstanceOf(AgentApiError);
  });
});
