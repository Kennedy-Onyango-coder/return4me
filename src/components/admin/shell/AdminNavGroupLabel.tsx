// BATCH B0 — admin sidebar group label.
//
// The small group heading above each sidebar section group (Overview, Money,
// Operations, Configuration). Presentation only: a paragraph, never a
// heading, so the console keeps its single page-level h1.
import React from 'react';

export default function AdminNavGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p
      aria-hidden="true"
      className="r4m-admin-nav-group px-3 pt-3 pb-1 text-small font-extrabold uppercase tracking-wide text-[var(--appearance-text-muted)]"
    >
      {children}
    </p>
  );
}
