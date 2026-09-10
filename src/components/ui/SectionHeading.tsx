import React from 'react';

interface SectionHeadingProps {
  /** Small contextual kicker above the title (e.g. "YOUR CLAIMS").
   *  Readable 11px uppercase — the DS replacement for the app's old
   *  text-[9px]/[10px] eyebrow labels. */
  eyebrow?: string;
  title: string;
  description?: string;
  className?: string;
}

/**
 * Shared section header: eyebrow (optional) + title + description.
 * Establishes the app's typography hierarchy for section tops so the
 * views stop hand-rolling their own (currently 5+ slightly different
 * patterns in App.tsx / OwnerView / AgentView / AdminView).
 */
export default function SectionHeading({ eyebrow, title, description, className = '' }: SectionHeadingProps) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      {eyebrow && (
        <p className="text-[11px] font-extrabold uppercase tracking-widest text-brand-muted-text">
          {eyebrow}
        </p>
      )}
      <h2 className="text-lg font-extrabold tracking-tight text-primary-green">{title}</h2>
      {description && (
        <p className="text-sm text-brand-muted-text leading-relaxed max-w-2xl">{description}</p>
      )}
    </div>
  );
}
