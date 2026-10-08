import React from 'react';
import { verificationProfiles } from '../config/verificationProfiles';
import { verificationTranslation } from '../config/verificationTranslations';

// Only known verification fields are rendered, never arbitrary claim metadata.
// Include legacy keys so claims submitted before the profile refactor remain readable.
const labels = new Map([
  ...Object.values(verificationProfiles).flat().map(field => [field.key, field.labelKey] as [string, string]),
  ['lostDetails', 'verify.extraDetails'],
  ['lastNameOnDoc', 'verify.fullName'],
  ['whereLost', 'verify.lostLocation'],
  ['colorDetail', 'verify.colorDetail'],
]);

/** Private evidence for the assigned agent's physical-verification panel only. */
export default function ClaimVerificationEvidence({ answers, identifyingDetails }: {
  answers?: Record<string, unknown> | null;
  identifyingDetails?: string | null;
}) {
  const entries = [...labels].flatMap(([key, label]) => {
    const value = answers?.[key];
    return typeof value === 'string' && value.trim() ? [{ key, label, value }] : [];
  });
  if (!identifyingDetails?.trim() && !entries.length) return null;
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-left space-y-1.5">
      <p className="text-caption font-extrabold text-amber-700 uppercase tracking-widest">
        {'Claimant stated (before seeing item) — verify it matches:'}
      </p>
      {identifyingDetails?.trim() && (
        <p className="text-xs text-stone-700 font-medium break-words">
          <span className="font-bold">{'Identifying detail: '}</span>
          {identifyingDetails}
        </p>
      )}
      {entries.map(({ key, label, value }) => (
        <p key={key} className="text-xs text-stone-700 font-medium break-words">
          <span className="font-bold">{verificationTranslation(label)}: </span>
          {value}
        </p>
      ))}
    </div>
  );
}