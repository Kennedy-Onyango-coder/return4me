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
  /** Optional extra classes for the rendered <h2> only.
   *  Purely additive and opt-in: omitted means exactly the previous markup, so
   *  every existing consumer is byte-for-byte unaffected. It exists because the
   *  default `text-heading` step (18/26) is the CARD-heading rung of the UX-01
   *  ladder, while a page-level section heading belongs on `text-section`
   *  (24/32). A page that needs the bigger rung — the public homepage — passes
   *  it here instead of forking the primitive or hand-rolling a second header. */
  titleClassName?: string;
  /** Wrapper (layout) classes, not the heading itself. */
  className?: string;
}

/**
 * Shared section header: eyebrow (optional) + title + description.
 * Establishes the app's typography hierarchy for section tops so the
 * views stop hand-rolling their own (currently 5+ slightly different
 * patterns in App.tsx / OwnerView / AgentView / AdminView).
 */
export default function SectionHeading({ eyebrow, title, description, titleId, titleClassName = '', className = '' }: SectionHeadingProps) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      {eyebrow && (
        <p className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">
          {eyebrow}
        </p>
      )}
      <h2 id={titleId} className={`text-heading font-extrabold tracking-tight text-[var(--appearance-text-primary)] ${titleClassName}`}>{title}</h2>
      {description && (
        <p className="text-body text-[var(--appearance-text-muted)] leading-relaxed max-w-2xl">{description}</p>
      )}
    </div>
  );
}
