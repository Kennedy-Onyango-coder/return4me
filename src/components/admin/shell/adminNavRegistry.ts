// BATCH B0 / AD1 — admin console navigation registry.
//
// The single source of truth for the admin shell's section list, group order,
// icons, labels AND the console's page-level heading copy (title + description).
// Presentation metadata only: it holds no data, makes no requests and changes no
// behaviour. AdminView renders the console title band from here — AD1 retired the
// local table it used to keep, so a section's page-level <h1>, its supporting
// description and the sidebar/top-bar label can no longer drift apart across two
// lists. Every section is backed by an existing endpoint.
//
// PROGRAMME 1 added two sections, both of them surfaces over endpoints that
// already existed or that this programme added as READ-ONLY reads:
//   * `payouts` — Payout Integrity: the unresolved-payout rows
//     (GET /api/admin/payout-reconciliation, Batch 2) plus the launch-policy
//     verdict per hub from the dashboard payload already in hand (WS1/WS2). It
//     is promoted from a collapsed disclosure on the Overview to its own
//     section because the work behind it — checking each unresolved payout with
//     the provider, and correcting hubs that cannot be paid at all — is a queue
//     an operator works, not a figure they glance at.
//   * `audit` — Audit Log: a bounded, filterable read of the admin audit trail
//     (GET /api/admin/audit-logs, WS4). Read-only; there is no way to edit or
//     delete an audit entry from the console.
// Both sit in the group they belong to (Money / Configuration) and neither adds
// a mutation to the console.
import {
  BarChart2,
  Users,
  Package,
  HelpCircle,
  ClipboardList,
  FileSearch,
  Coins,
  FileCheck,
  ShieldCheck,
  AlertTriangle,
  Banknote,
  ScrollText,
  type LucideIcon,
} from 'lucide-react';

export type AdminSectionId =
  | 'stats'
  | 'agents'
  | 'found_items'
  | 'disputes'
  | 'claims'
  | 'lost_reports'
  | 'ledger'
  | 'review'
  | 'categories'
  | 'strikes'
  | 'payouts'
  | 'audit';

/** The console's page-level heading copy for one section. */
export interface AdminSectionCopy {
  title: string;
  description: string;
}

export interface AdminNavItem extends AdminSectionCopy {
  id: AdminSectionId;
  /** The sidebar / top-bar LABEL — deliberately not always the page-level TITLE:
   *  the disputes section is labelled `Disputes & Refunds` but heads `Disputes`,
   *  and the review section is labelled `Review` but heads `Manual Review`. Two
   *  fields, because two different strings were always rendered; collapsing them
   *  into one would silently rename a heading or a nav item. */
  label: string;
  icon: LucideIcon;
}

export interface AdminNavGroup {
  id: string;
  label: string;
  items: AdminNavItem[];
}

/** All existing sections, grouped for the B0 sidebar, plus the two surfaces
 *  PROGRAMME 1 added (`payouts`, `audit`). Order within each group follows the
 *  pre-existing console order, and every item carries the page-level heading copy
 *  the console title band renders — AD1 moved the original ten title/description
 *  pairs here byte for byte from AdminView's retired table. */
export const ADMIN_NAV_GROUPS: AdminNavGroup[] = [
  {
    id: 'overview',
    label: 'Overview',
    items: [
      {
        id: 'stats',
        label: 'Overview',
        icon: BarChart2,
        title: 'Overview',
        description: 'Monitor platform activity, recovery performance, and operational health.',
      },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    items: [
      {
        id: 'claims',
        label: 'Claims',
        icon: ClipboardList,
        title: 'Claims',
        description: 'Monitor and administer active and completed recovery claims.',
      },
      {
        id: 'ledger',
        label: 'Ledger',
        icon: Coins,
        title: 'Ledger',
        description: 'Review settlement and financial ledger activity.',
      },
      {
        id: 'disputes',
        label: 'Disputes & Refunds',
        icon: HelpCircle,
        title: 'Disputes',
        description: 'Investigate claims requiring administrative resolution.',
      },
      {
        id: 'payouts',
        label: 'Payout Integrity',
        icon: Banknote,
        title: 'Payout Integrity',
        description: 'Reconcile unresolved payouts and review every hub that cannot be paid.',
      },
    ],
  },
  {
    id: 'operations',
    label: 'Operations',
    items: [
      {
        id: 'agents',
        label: 'Agents Hub',
        icon: Users,
        title: 'Agents Hub',
        description: 'Review agent activity, verification, and operational status.',
      },
      {
        id: 'found_items',
        label: 'Found Items',
        icon: Package,
        title: 'Found Items',
        description: 'Review recovered items and their current recovery state.',
      },
      {
        id: 'lost_reports',
        label: 'Lost Reports',
        icon: FileSearch,
        title: 'Lost Reports',
        description: 'Review submitted lost-item reports and their discovery status.',
      },
      {
        id: 'review',
        label: 'Review',
        icon: FileCheck,
        title: 'Manual Review',
        description: 'Review operational items requiring administrative attention.',
      },
    ],
  },
  {
    id: 'configuration',
    label: 'Configuration',
    items: [
      {
        id: 'categories',
        label: 'Categories & Fees',
        icon: ShieldCheck,
        title: 'Categories & Fees',
        description: 'Configure recovery categories, fees, and finder/agent/platform allocation.',
      },
      {
        id: 'strikes',
        label: 'Payment Strikes',
        icon: AlertTriangle,
        title: 'Payment Strikes',
        description: 'Review agent strikes and enforcement history.',
      },
      {
        id: 'audit',
        label: 'Audit Log',
        icon: ScrollText,
        title: 'Audit Log',
        description: 'Read the bounded, newest-first record of administrative actions.',
      },
    ],
  },
];

/** Flat lookup: section id → group + item. Used for the top-bar title. */
const SECTION_LOOKUP = new Map<AdminSectionId, { groupLabel: string; item: AdminNavItem }>();
for (const group of ADMIN_NAV_GROUPS) {
  for (const item of group.items) {
    SECTION_LOOKUP.set(item.id, { groupLabel: group.label, item });
  }
}

export function describeAdminSection(id: AdminSectionId): { groupLabel: string; item: AdminNavItem } | null {
  return SECTION_LOOKUP.get(id) ?? null;
}

/**
 * The console's page-level heading copy for a section (AD1).
 *
 * Unlike `describeAdminSection` above — which the top bar deliberately falls back
 * from when a section is unknown — this THROWS on an unknown id. The title band
 * always has a section to render, the id comes from the closed `activeTab` union,
 * and this registry covers every member of that union, so a miss here is a
 * programming error; a silent `undefined` would blank the console's only <h1>
 * instead of failing loudly.
 */
export function describeAdminSectionCopy(id: AdminSectionId): AdminSectionCopy {
  const described = SECTION_LOOKUP.get(id);
  if (!described) throw new Error(`Unknown admin section: ${id}`);
  return described.item;
}

/** The section ids in registry order — the shell renders exactly these. */
export const ADMIN_SECTION_IDS: AdminSectionId[] = ADMIN_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));
