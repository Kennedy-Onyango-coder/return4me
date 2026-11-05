import React from 'react';
import { Breadcrumb, type BreadcrumbItem } from './Breadcrumb';

export type PageHeaderProps = {
  /** The page-level heading. Rendered as the surface's ONE `<h1>`. */
  title: string;
  /** Optional supporting sentence. Omitted when a surface has no real copy. */
  description?: string;
  /** Optional trail. Omitted rather than filled with a fabricated location. */
  items?: BreadcrumbItem[];
  /** Optional trailing actions (filters, refresh, primary CTA). */
  actions?: React.ReactNode;
  className?: string;
};

/**
 * The shared page header for an admin surface: one `<h1>`, its supporting
 * sentence, an optional breadcrumb trail and an optional action cluster.
 *
 * NOT mounted by `AdminView` in Stage 3B, on purpose. The console already owns
 * exactly one registry-driven title band (title + description read from
 * `describeAdminSectionCopy(activeTab)`), and that band's `<h1>` is the
 * console's single page-level heading — pinned by
 * `src/__tests__/adminConsoleSectionChrome.test.ts`. Mounting this header
 * alongside it would give the page two `<h1>`s and duplicate the section
 * description, which Stage 3B §7 forbids. It exists here as the sanctioned
 * primitive for the per-section pages introduced from Stage 4 onward, where a
 * surface needs its own header instead of sharing the console band.
 */
export function PageHeader({
  title,
  description,
  items,
  actions,
  className = '',
}: PageHeaderProps) {
  return (
    <header
      className={`r4m-page-header border-b border-[var(--appearance-border)] pb-4 ${className}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          {items && items.length > 0 ? (
            <Breadcrumb items={items} className="mb-1" />
          ) : null}
          <h1 className="text-subsection sm:text-section font-extrabold tracking-tight text-[var(--appearance-text-primary)]">
            {title}
          </h1>
          {description ? (
            <p className="max-w-2xl leading-relaxed text-body text-[var(--appearance-text-muted)]">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}

export default PageHeader;
