import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { translations } from '../types';
import { agentClaimBadge } from '../components/claimStatus';

const root = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.resolve(root, relative), 'utf8');
const hub = read('src/components/agent/AgentHub.tsx');
const view = read('src/components/AgentView.tsx');
const types = read('src/types.ts');

const count = (source: string, value: string) => source.split(value).length - 1;

describe('Phase 16.1 Batch 4B-3 Agent Hub modernization', () => {
  it('preserves the one-way, hook-free architecture and canonical queue prop', () => {
    expect(count(view, '<AgentHub')).toBe(1);
    expect(view).toContain("import AgentHub from './agent/AgentHub'");
    expect(hub).not.toMatch(/from ['"].*AgentView/);
    expect(hub).not.toMatch(/\buse(State|Effect|Memo|Callback|Ref)\s*\(/);
    expect(hub).toContain('expectedDropoffs: any[];');
    expect(hub).not.toContain('expectedDropups');
  });

  it('gives both card types semantic identity, existing context, and distinct bilingual roles', () => {
    expect(count(hub, '<article')).toBe(2);
    expect(count(hub, 'itemReference(item)')).toBe(2);
    expect(count(hub, 'itemHeading(item)')).toBe(2);
    expect(count(hub, '<ItemMetadata item={item} />')).toBe(2);
    expect(hub).toContain('t.agentDropoffQueueRole');
    expect(hub).toContain('t.agentHandoverQueueRole');
    for (const lang of ['en', 'sw'] as const) {
      expect(translations[lang].agentDropoffQueueRole).toBeTruthy();
      expect(translations[lang].agentHandoverQueueRole).toBeTruthy();
      expect(translations[lang].agentDropoffsEmpty).toBeTruthy();
      expect(translations[lang].agentHandoversEmpty).toBeTruthy();
    }
  });

  it('uses only existing truthful metadata and does not parse or invent geography', () => {
    expect(hub).toContain('item.category_name || item.category_id');
    expect(hub).toContain('item.county, item.found_area, item.found_area_details');
    expect(hub).toContain('item.created_at ? <p>');
    const helper = hub.slice(hub.indexOf('const itemContextLabel'), hub.indexOf('const claimBadgeVariant'));
    expect(helper).not.toMatch(/split\(|match\(|city|sub-?county|neighbou?r|coordinate|latitude|longitude/i);
    expect(hub.slice(hub.indexOf('return ('))).not.toMatch(/owner_phone|owner_email|payment_reference|payment_status/);
  });

  it('preserves canonical, informational, and actionable workflow semantics', () => {
    expect(hub).toContain('agentClaimBadge(item.associatedClaim?.status,');
    expect(hub).toContain('getClaimStatusDisplay(item.associatedClaim.status');
    expect(agentClaimBadge(undefined, 'en').label).toBe('No Claim Information');
    expect(hub).toContain('t.agentPendingPaymentNote');
    const payment = hub.slice(hub.indexOf("associatedClaim?.status === 'pending_payment'"), hub.indexOf('{!item.associatedClaim &&'));
    expect(payment).not.toMatch(/<Button|<button|handleConfirm|handleReject|handleConfirmHandover/);
    expect(hub).toContain("item.associatedClaim?.status === 'disputed'");
    expect(hub).toContain("item.associatedClaim?.status === 'released'");
    expect(hub).toContain('handleConfirmViewing(item.associatedClaim.id)');
    expect(hub).toContain('handleConfirmHandover(item.associatedClaim.id)');
    expect(hub).toContain('Confirm Owner Viewed & Verified Item');
    expect(hub).toContain('Complete Handover');
  });

  it('emphasizes Review, keeps Reject destructive, and preserves per-item busy identity', () => {
    expect(hub).toMatch(/<Button onClick=\{\(\) => props\.openVerificationPanel\(item\)\}>/);
    expect(hub).toMatch(/<Button variant="danger"[\s\S]{0,250}setRejectingItemId\(item\.id\)/);
    expect(view).toContain('const [processingItemId, setProcessingItemId] = useState<string | null>(null);');
    expect(view).toContain('const [actionProcessing, setActionProcessing] = useState(false);');
    expect(hub).toContain('props.processingItemId === id');
    expect(hub).not.toMatch(/disabled=\{props\.actionProcessing\}[\s\S]{0,400}(expectedDropoffs|holdingPickups)\.map/);
  });

  it('preserves loading, refresh, and three independent error channels', () => {
    expect(hub).toMatch(/role="status"[\s\S]{0,180}aria-live="polite"/);
    expect(hub).toContain('onClick={props.retryQueue}');
    expect(hub).toContain('disabled={props.queueLoading}');
    expect(hub).toContain('props.operationError');
    expect(hub).toContain('props.verifyError');
    expect(hub).toContain('props.queueError');
    expect(hub).not.toMatch(/setInterval\(|setTimeout\(/);
  });

  it('meets typography, button, focus, responsive, and privacy boundaries', () => {
    expect(hub).not.toMatch(/text-\[(9|10|11)px\]/);
    expect(hub).toContain('focus-visible:ring-2');
    expect(hub).toContain('break-words');
    expect(hub).toContain('break-all');
    expect(hub).toContain('overflow-hidden');
    expect(hub).toContain('flex-wrap');
    expect(hub).not.toMatch(/fetch\(|\/api\/agents|setInterval\(|setTimeout\(/);
    expect(hub).not.toMatch(/owner_phone|owner_email|payment_reference|owner_id_proof/);
  });

  it('keeps B4B-3 scope inside presentation, translations, and focused tests', () => {
    expect(types).toContain('agentDropoffQueueRole:');
    expect(count(types, 'agentDropoffQueueRole:')).toBe(2);
    expect(count(types, 'agentHandoverQueueRole:')).toBe(2);
    const changed = ['src/components/agent/AgentHub.tsx', 'src/types.ts', 'src/__tests__/agentHubComprehensionBatch4B1.test.ts', 'src/__tests__/agentHubExtractionBatch4.test.ts'];
    for (const file of changed) expect(fs.existsSync(path.resolve(root, file))).toBe(true);
  });
});
