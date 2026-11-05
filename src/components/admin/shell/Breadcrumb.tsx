import React from 'react';
import { ChevronRight } from 'lucide-react';
import { ICON_SIZE } from '../../ui';

/**
 * One step in a breadcrumb trail.
 *
 * `href` is optional and normally omitted: this console navigates through its
 * own `activeTab` state, not the URL, so most crumbs are plain text rather than
 * links. `active` marks the current location — it is rendered as text with
 * `aria-current="page"`, never as a link.
 */
export type BreadcrumbItem = {
  label: string;
  href?: string;
  active?: boolean;
};

export interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
}

/**
 * A breadcrumb trail over the console's location context.
 *
 * Renders a real `<nav aria-label="Breadcrumb">` wrapping an ordered list, so
 * assistive technology announces the trail as one landmark and the steps as an
 * ordered sequence. No heading is rendered — the console keeps its single
 * page-level `<h1>` in the title band below.
 */
export function Breadcrumb({ items, className = '' }: BreadcrumbProps) {
  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className={`min-w-0 ${className}`}>
      <ol className="flex flex-wrap items-center gap-2 text-caption text-[var(--appearance-text-muted)]">
        {items.map((item, index) => {
          const isLink = Boolean(item.href) && !item.active;
          return (
            <li
              key={`${item.label}-${index}`}
              className="flex min-w-0 items-center gap-2"
            >
              {index > 0 ? (
                <ChevronRight
                  size={ICON_SIZE.metadata}
                  aria-hidden="true"
                  className="shrink-0 opacity-60"
                />
              ) : null}
              {isLink ? (
                <a
                  href={item.href}
                  className="truncate rounded-small transition-colors hover:text-[var(--appearance-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--appearance-primary)]"
                >
                  {item.label}
                </a>
              ) : (
                <span
                  aria-current={item.active ? 'page' : undefined}
                  className={`truncate ${
                    item.active
                      ? 'font-extrabold text-[var(--appearance-text-primary)]'
                      : ''
                  }`}
                >
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export default Breadcrumb;
