import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { toAgentQueueSelf } from '../agentQueueProjection';
import type { Agent } from '../../db/database';

const root = path.resolve(import.meta.dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.resolve(root, rel), 'utf8');

// A fully-populated database agent record: every field parseAgent can produce.
const fullAgent: Agent = {
  id: 'AGENT-1',
  business_name: 'Umoja Handover Hub 1 Ltd',
  contact_phone: '+254711000000',
  location_address: 'Moi Avenue, Nairobi CBD',
  county: 'Nairobi',
  administrative_unit_id: 'sub-1',
  location_accuracy: 50,
  location_source: null,
  coordinate_source: null,
  latitude: -1.286389,
  longitude: 36.817223,
  mpesa_till_or_paybill: '1234567',
  payout_method_type: 'Personal M-Pesa',
  status: 'active',
  refundable_deposit: 5000,
  national_id_hash: 'SENSITIVE-NATIONAL-ID-HASH',
  rating: 4.6,
  rating_count: 12,
  needs_manual_geocoding: false,
  email_verified_at: '2026-01-01T00:00:00.000Z',
  contact_email: 'agent@example.test',
  shop_photo_url: 'https://private.example/shop.jpg',
  id_document_photo_url: 'https://private.example/id.jpg',
  warning_count: 0,
  last_warning_reason: null,
  last_warning_at: null,
  terms_accepted_at: '2026-01-01T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('B2 — AgentQueueSelf projection', () => {
  it('maps only the four dashboard-required fields', () => {
    expect(Object.keys(toAgentQueueSelf(fullAgent)).sort()).toEqual([
      'business_name',
      'location_address',
      'mpesa_till_or_paybill',
      'payout_method_type',
    ]);
  });

  it('preserves the required dashboard values', () => {
    expect(toAgentQueueSelf(fullAgent)).toEqual({
      business_name: 'Umoja Handover Hub 1 Ltd',
      location_address: 'Moi Avenue, Nairobi CBD',
      payout_method_type: 'Personal M-Pesa',
      mpesa_till_or_paybill: '1234567',
    });
  });

  it('never exposes sensitive or unrelated fields', () => {
    const dto = toAgentQueueSelf(fullAgent);
    for (const forbidden of [
      'id', 'national_id_hash', 'contact_phone', 'contact_email',
      'latitude', 'longitude', 'county', 'administrative_unit_id',
      'location_accuracy', 'location_source', 'coordinate_source',
      'shop_photo_url', 'id_document_photo_url', 'email_verified_at',
      'refundable_deposit', 'rating', 'rating_count', 'warning_count',
      'last_warning_reason', 'last_warning_at', 'terms_accepted_at',
      'created_at', 'needs_manual_geocoding', 'status',
    ]) {
      expect(dto, `must not expose ${forbidden}`).not.toHaveProperty(forbidden);
    }
  });
});

describe('B2 — queue route wires the projection (source contract)', () => {
  const routeSrc = read('src/routes/agentOps.ts');

  it('projects the agent through toAgentQueueSelf, not a spread or the raw record', () => {
    expect(routeSrc).toContain('agent: toAgentQueueSelf(req.activeAgent)');
    expect(routeSrc).not.toContain('agent: req.activeAgent');
    expect(routeSrc).not.toMatch(/agent:\s*\{\s*\.\.\.req\.activeAgent/);
  });
});
