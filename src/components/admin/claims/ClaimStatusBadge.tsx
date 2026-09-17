import React from 'react';
import Badge from '../../ui/Badge';
import { presentClaimStatus } from './claimsPresentation';

/**
 * Renders ONE claim status. Explicit prop, never a spread claim object — the
 * component's inputs are the privacy boundary restated in the type system.
 * Meaning is carried by the human label; colour is only reinforcement, which is
 * what the shared Badge variant already guarantees.
 */
export default function ClaimStatusBadge({ status, lang }: { status: string; lang: 'en' | 'sw' }) {
  const { label, tone } = presentClaimStatus(status, lang);
  return <Badge variant={tone}>{label}</Badge>;
}
