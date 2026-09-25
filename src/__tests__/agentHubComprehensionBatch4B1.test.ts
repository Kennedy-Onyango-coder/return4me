import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.resolve(repoRoot, relativePath), 'utf8');

const hub = read('src/components/agent/AgentHub.tsx');
const view = read('src/components/AgentView.tsx');
const types = read('src/types.ts');
const claimStatus = read('src/components/claimStatus.ts');

describe('Phase 16.1 Batch 4B-1 Agent Hub comprehension', () => {
  it('B1 explains pending payment without exposing an agent action or private payment data', () => {
    expect(hub).toMatch(/associatedClaim\?\.status === 'pending_payment'[\s\S]{0,500}agentPendingPaymentNote/);
    const branch = hub.slice(
      hub.indexOf("associatedClaim?.status === 'pending_payment'"),
      hub.indexOf('{!item.associatedClaim &&'),
    );
    expect(branch).not.toMatch(/<button|handleConfirm|handleReject|verify-item|payment_reference|payment_status|owner_phone/);
    expect(types).toContain("agentPendingPaymentNote: 'Payment is pending. This item cannot be handed over until the owner completes payment.'");
    expect(types).toContain("agentPendingPaymentNote: 'Malipo yanasubiri. Bidhaa hii haiwezi kukabidhiwa hadi mmiliki akamilishe malipo.'");
  });

  it('B2 treats an absent associated claim as unavailable information, not proven claim absence', () => {
    expect(claimStatus).toContain("label: lang === 'en' ? 'No Claim Information' : 'Hakuna Taarifa ya Dai'");
    expect(claimStatus).not.toContain("label: lang === 'en' ? 'No Claim Yet' : 'Hakuna Dai Bado'");
    expect(hub).toMatch(/\{!item\.associatedClaim &&[\s\S]{0,300}agentNoClaimInfoNote/);
  });

  it('B3 scopes busy state to the exact drop-off or claim identity supplied by AgentView', () => {
    expect(view).toMatch(/setProcessingItemId\(item\?\.id \?\? null\)/);
    expect(view).toMatch(/setProcessingItemId\(dropoffCode\)/);
    expect(view).toMatch(/setProcessingItemId\(claimId\)/);
    expect(hub).toMatch(/const isItemBusy = \(id: string \| null \| undefined\) =>\s*Boolean\(id\) && props\.processingItemId === id/);
    expect(hub).toMatch(/disabled=\{isItemBusy\(item\.id\)\}[\s\S]{0,100}aria-busy=\{isItemBusy\(item\.id\)\}/);
    expect(hub).toMatch(/disabled=\{isItemBusy\(item\.associatedClaim\.id\)\}[\s\S]{0,100}aria-busy=\{isItemBusy\(item\.associatedClaim\.id\)\}/);
    // The global operation flag remains available for the lookup/modal UX and Batch 3 contracts.
    expect(view).toContain('const [actionProcessing, setActionProcessing] = useState(false);');
    expect(view).toContain('if (modalBusy) return;');
  });

  it('B5 and B6 visibly refresh through the existing callback without hiding or polling the queue', () => {
    expect(hub).toMatch(/props\.queueLoading &&[\s\S]{0,500}role="status"[\s\S]{0,200}aria-live="polite"[\s\S]{0,500}agentQueueRefreshing/);
    expect(hub).toMatch(/onClick=\{props\.retryQueue\}\s*disabled=\{props\.queueLoading\}\s*aria-busy=\{props\.queueLoading\}/);
    expect(hub).toMatch(/t\.agentQueueRefresh/);
    expect(view).not.toMatch(/setInterval\(|setTimeout\(/);
    // The list mapping is outside the conditional loading status, so stale but
    // useful queue content remains represented during a healthy refresh.
    expect(hub.indexOf('agentQueueRefreshing')).toBeLessThan(hub.indexOf('props.expectedDropoffs.map'));
  });

  it('B21 keeps queue, verification, and operational failures in their established channels', () => {
    const queueErrorBranch = hub.slice(hub.indexOf('{props.queueError &&'), hub.indexOf('{/* Quick Confirmation Actions */}'));
    const verifyErrorBranch = hub.slice(hub.indexOf('{props.verifyError &&'), hub.indexOf('<div className="flex flex-wrap gap-2 justify-end pt-1">'));
    const operationErrorBranch = hub.slice(hub.indexOf('{props.operationError &&'), hub.indexOf('{/* REFRESH FAILURE WHILE THE HUB IS ALREADY OPEN'));
    expect(queueErrorBranch).toContain('props.queueError');
    expect(queueErrorBranch).toContain('onClick={props.retryQueue}');
    expect(verifyErrorBranch).toContain('props.verifyError');
    expect(operationErrorBranch).toContain('props.operationError');
    expect(operationErrorBranch).toContain("setOperationError('')");
    expect(view).toMatch(/catch \(e: any\)[\s\S]{0,120}setVerifyError\(e\.message\)/);
  });


  it('B22 surfaces only already-authorized item context on both queue cards', () => {
    expect(hub.match(/itemHeading\(item\)/g) || []).toHaveLength(2);
    expect(hub.match(/itemLocationLabel\(item\)/g) || []).toHaveLength(1); // shared metadata component renders it for both cards
    expect(hub).toContain('item.category_name || item.category_id');
    expect(hub).toContain('item.county, item.found_area, item.found_area_details');
    const contextHelpers = hub.slice(
      hub.indexOf('const itemContextLabel'),
      hub.indexOf('return (        <div'),
    );
    expect(contextHelpers).not.toMatch(/split\(|match\(|city|sub-?county/i);
    expect(contextHelpers).not.toMatch(/owner_phone|owner_email|payment_reference|security_answers/);
  });

  it('B22 omits unavailable context honestly and provides bilingual labels', () => {
    expect(hub).toContain('t.agentItemContextUnavailable');
    expect(hub).toContain('item.created_at ? <p>');
    expect(hub).toContain('new Date(item.created_at).toLocaleDateString()');
    for (const key of [
      'agentItemContextItem', 'agentItemContextCategory', 'agentItemContextLocation',
      'agentItemContextReported', 'agentItemContextUnavailable',
    ]) {
      expect(types).toContain(`${key}:`);
      expect((types.match(new RegExp(`\\b${key}:`, 'g')) || [])).toHaveLength(2);
    }
  });

  it('B22 preserves all Batch 4B-1 behavior and extraction boundaries', () => {
    expect(hub).toContain("associatedClaim?.status === 'pending_payment'");
    expect(hub).toContain('t.agentNoClaimInfoNote');
    expect(hub).toContain('props.processingItemId');
    expect(hub).toContain('props.queueLoading');
    expect(hub).toContain('onClick={props.retryQueue}');
    expect(hub).toContain('props.operationError');
    expect(hub).toContain('props.verifyError');
    expect(hub).toContain('props.queueError');
    expect(hub).not.toContain('No Claim Yet');
    expect(hub).not.toContain('expectedDropups');
    expect(hub).not.toMatch(/\buse(State|Effect|Memo|Callback|Ref)\s*\(/);
  });

  it('preserves the extraction architecture, canonical prop, and hook-free presentational Hub', () => {
    expect(view).toMatch(/token && agentStatus === 'active' && agentProfile && \(\s*<AgentHub\b/);
    expect((view.match(/<AgentHub\b/g) || [])).toHaveLength(1);
    expect(hub).not.toMatch(/import .*AgentView|from ['"].*AgentView/);
    expect(hub).not.toMatch(/\buse(State|Effect|Memo|Callback|Ref)\s*\(/);
    expect(hub).toContain('expectedDropoffs: any[];');
    expect(hub).not.toContain('expectedDropups');
  });
});
