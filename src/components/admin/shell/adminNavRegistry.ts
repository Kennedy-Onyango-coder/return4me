// BATCH B0 — admin console navigation registry.
//
// The single source of truth for the admin shell's section list, group order,
// icons and labels. Presentation metadata only: it holds no data, makes no
// requests and changes no behaviour. AdminView keeps its own CONSOLE_SECTIONS
// copy for content rendering; this registry drives the shell chrome (sidebar,
// top bar titles) so the two cannot drift apart silently — both lists cover
// the same ten sections backed by existing endpoints.
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
  | 'strikes';

export interface AdminNavItem {
  id: AdminSectionId;
  label: string;
  icon: LucideIcon;
}

export interface AdminNavGroup {
  id: string;
  label: string;
  items: AdminNavItem[];
}

/** All ten existing sections, grouped for the B0 sidebar. Order within each
 *  group follows the pre-existing console order. */
export const ADMIN_NAV_GROUPS: AdminNavGroup[] = [
  {
    id: 'overview',
    label: 'Overview',
    items: [{ id: 'stats', label: 'Overview', icon: BarChart2 }],
  },
  {
    id: 'money',
    label: 'Money',
    items: [
      { id: 'claims', label: 'Claims', icon: ClipboardList },
      { id: 'ledger', label: 'Ledger', icon: Coins },
      { id: 'disputes', label: 'Disputes & Refunds', icon: HelpCircle },
    ],
  },
  {
    id: 'operations',
    label: 'Operations',
    items: [
      { id: 'agents', label: 'Agents Hub', icon: Users },
      { id: 'found_items', label: 'Found Items', icon: Package },
      { id: 'lost_reports', label: 'Lost Reports', icon: FileSearch },
      { id: 'review', label: 'Review', icon: FileCheck },
    ],
  },
  {
    id: 'configuration',
    label: 'Configuration',
    items: [
      { id: 'categories', label: 'Categories & Fees', icon: ShieldCheck },
      { id: 'strikes', label: 'Payment Strikes', icon: AlertTriangle },
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

/** The ten section ids in registry order — the shell renders exactly these. */
export const ADMIN_SECTION_IDS: AdminSectionId[] = ADMIN_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));
