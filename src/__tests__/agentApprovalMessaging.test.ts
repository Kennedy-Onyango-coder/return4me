import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { AgentApiError, agentApi } from '../services/agentApi';

// AW BATCH — ACCURATE AGENT APPROVAL MESSAGING.
//
// The dashboard used to render one misleading "Agent Hub unavailable" heading
// for every failed queue request. The server now returns a typed `code` so the
// UI can distinguish "pending approval" from "suspended" from every other
// denial, without weakening the authentication / active-agent boundary.

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
const viewTs = fs.readFileSync(path.resolve(__dirname, '../components/AgentView.tsx'), 'utf8');
const hookTs = fs.readFileSync(path.resolve(__dirname, '../hooks/useAgentOperations.ts'), 'utf8');

function requireActiveAgentBody(): string {
  const start = serverTs.indexOf('function requireActiveAgent(req: Request, res: Response, next: NextFunction) {');
  expect(start, 'requireActiveAgent not found').toBeGreaterThan(-1);
  return serverTs.slice(start, start + 2600);
}

describe('approval messaging — the server returns a typed denial code', () => {
  const body = requireActiveAgentBody();

  it('keeps the authenticated-agent guard and the actionable predicate intact', () => {
    expect(body).toContain("if (req.user?.role !== 'agent' || !req.user.agentId) {");
    expect(body).toContain('if (!isAgentActionable(agent)) {');
  });

  it('distinguishes a pending application from a suspended account', () => {
    expect(body).toContain("agent.status === 'pending'");
    expect(body).toContain("code: 'AGENT_PENDING_APPROVAL'");
    expect(body).toContain("agent.status === 'suspended'");
    expect(body).toContain("code: 'AGENT_SUSPENDED'");
    const pendingIdx = body.indexOf("code: 'AGENT_PENDING_APPROVAL'");
    const suspendedIdx = body.indexOf("code: 'AGENT_SUSPENDED'");
    expect(pendingIdx).toBeGreaterThan(-1);
    expect(suspendedIdx).toBeGreaterThan(-1);
    expect(pendingIdx).not.toBe(suspendedIdx);
  });

  it('sends no pending-approval code for non-agent, missing, or other inactive accounts', () => {
    expect(body).toContain("code: 'AGENT_NOT_APPROVED'");
    expect(body).toContain("code: 'AGENT_NOT_FOUND'");
    expect(body).toContain("code: 'AGENT_INACTIVE'");
  });
});

describe('approval messaging — the typed code reaches the UI', () => {
  it('surfaces the server code on AgentApiError', () => {
    const err = new AgentApiError('Your agent application is still under review.', 403, 'AGENT_PENDING_APPROVAL');
    expect(err.code).toBe('AGENT_PENDING_APPROVAL');
    expect(err.status).toBe(403);
  });

  it('the hook captures the code from the error and clears it on retry', () => {
    expect(hookTs).toContain('const [queueErrorCode, setQueueErrorCode] = useState<string | null>(null);');
    expect(hookTs).toContain('setQueueErrorCode(serverCode)');
    expect(hookTs).toContain('setQueueErrorCode(null)');
  });

  it('the dashboard maps each code to the right heading and keeps a generic fallback', () => {
    expect(viewTs).toContain("queueErrorCode === 'AGENT_PENDING_APPROVAL'");
    expect(viewTs).toContain('Application pending approval');
    expect(viewTs).toContain("queueErrorCode === 'AGENT_SUSPENDED'");
    expect(viewTs).toContain('Account suspended');
    expect(viewTs).toContain('Agent Hub unavailable');
  });
});

describe('approval messaging — the transport surfaces the code from a 403 response', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); });
  afterEach(() => vi.unstubAllGlobals());

  it('getQueue rejects with the pending-approval code', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ code: 'AGENT_PENDING_APPROVAL', error: 'Your agent application is still under review. You will be able to access your hub once an administrator approves it.' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    ));
    await expect(agentApi.getQueue('token')).rejects.toMatchObject({
      name: 'AgentApiError',
      message: 'Your agent application is still under review. You will be able to access your hub once an administrator approves it.',
      status: 403,
      code: 'AGENT_PENDING_APPROVAL',
    });
  });

  it('getQueue rejects with a distinct suspended code, never the pending code', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ code: 'AGENT_SUSPENDED', error: 'Your agent account has been suspended. Contact Return4me support for assistance.' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    ));
    await expect(agentApi.getQueue('token')).rejects.toMatchObject({
      status: 403,
      code: 'AGENT_SUSPENDED',
    });
  });
});
