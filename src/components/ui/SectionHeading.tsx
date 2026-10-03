import React from 'react';

interface SectionHeadingProps {
  /** Small contextual kicker above the title (e.g. "YOUR CLAIMS").
   *  Readable 12px uppercase — the caption step of the locked typography scale,
   *  and the DS replacement for the app's old sub-12px eyebrow labels. */
  eyebrow?: string;
  title: string;
  description?: string;
  /** Optional id on the rendered <h2>, so a wrapping <section> can point
   *  aria-labelledby at a real heading element instead of at a wrapper div.
   *  Purely additive: omitted here means exactly the previous markup. */
  titleId?: string;
  className?: string;
}

/**
 * Shared section header: eyebrow (optional) + title + description.
 * Establishes the app's typography hierarchy for section tops so the
 * views stop hand-rolling their own (currently 5+ slightly different
 * patterns in App.tsx / OwnerView / AgentView / AdminView).
 */
export default function SectionHeading({ eyebrow, title, description, titleId, className = '' }: SectionHeadingProps) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      {eyebrow && (
        <p className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">
          {eyebrow}
        </p>
      )}
      <h2 id={titleId} className="text-heading font-extrabold tracking-tight text-[var(--appearance-text-primary)]">{title}</h2>
      {description && (
        <p className="text-body text-[var(--appearance-text-muted)] leading-relaxed max-w-2xl">{description}</p>
      )}
    </div>
  );
}
