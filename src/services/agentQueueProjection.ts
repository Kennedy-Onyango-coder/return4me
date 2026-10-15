import type { Agent } from '../db/database';
import type { AgentQueueSelf } from '../types/agent';

// B2 — explicit queue self-DTO projection. GET /api/agents/queue returns only
// the four fields the signed-in agent dashboard actually renders. The full
// database agent record (national_id_hash, contact phone/email, coordinates,
// provenance, document URLs, verification status, warnings, deposit, etc.) is
// never serialized into this response.
export function toAgentQueueSelf(agent: Agent): AgentQueueSelf {
  return {
    business_name: agent.business_name,
    location_address: agent.location_address,
    payout_method_type: agent.payout_method_type,
    mpesa_till_or_paybill: agent.mpesa_till_or_paybill,
  };
}
