import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_NAV_GROUPS,
  ADMIN_SECTION_IDS,
  describeAdminSectionCopy,
  describeAdminSection,
  type AdminSectionId,
} from '../../shell/adminNavRegistry';
import { visibleAdminNavGroups } from '../../shell/MobileDrawer';

// =============================================================================
// BATCH A2 — THE SECTION IS ACTUALLY REACHABLE FROM THE CONSOLE
// =============================================================================
// A screen nobody can navigate to is dead code, so this file pins the wiring:
//   * the section id is registered exactly once, in the Operations group;
//   * the registry supplies the console's page-level <h1> copy for it (the title
//     band calls describeAdminSectionCopy, which THROWS for an unknown id — so a
//     missing entry would break the whole console, not just this section);
//   * AdminView imports the panel and mounts it under that section id.
//
// The last check is a SOURCE guard, not runtime rendering: AdminView is a
// 6,700-line authenticated component that cannot be mounted in this repository's
// node-only vitest environment. It is stated as such rather than presented as
// behavioural coverage — the panel's own behaviour is covered by the rendered
// and read-model suites beside this file.
// =============================================================================

const ADMIN_VIEW = readFileSync(
  path.resolve(process.cwd(), 'src/components/AdminView.tsx'),
  'utf8',
);

describe('the notification outbox is a registered console section', () => {
  it('appears exactly once, in the Operations group', () => {
    const occurrences = ADMIN_NAV_GROUPS
      .flatMap((group) => group.items.map((item) => ({ group: group.label, id: item.id })))
      .filter((item) => item.id === 'notifications');
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].group).toBe('Operations');
  });

  it('is registered in the flat id list the shell renders from', () => {
    expect(ADMIN_SECTION_IDS.filter((id) => id === 'notifications')).toHaveLength(1);
  });

  it('supplies the page-level heading copy the console renders', () => {
    const copy = describeAdminSectionCopy('notifications');
    expect(copy.title).toBe('Notification Outbox');
    expect(copy.description).toContain('retry');
    // The nav label and the heading title are deliberately separate fields.
    const described = describeAdminSection('notifications');
    expect(described?.item.label).toBe('Notification Outbox');
    expect(described?.groupLabel).toBe('Operations');
  });
});

describe('AdminView actually mounts the panel for that section', () => {
  it('imports the panel component', () => {
    expect(ADMIN_VIEW).toContain("from './admin/notifications/NotificationOutboxPanel'");
  });

  it('includes the section in the active-tab union', () => {
    expect(ADMIN_VIEW).toMatch(/\| 'notifications'>|'notifications'\s*>/);
  });

  it('renders the panel behind that section only', () => {
    expect(ADMIN_VIEW).toContain("{activeTab === 'notifications' && (");
    expect(ADMIN_VIEW).toContain('<NotificationOutboxPanel token={token} />');
  });

  it('renders a nav control that selects it', () => {
    expect(ADMIN_VIEW).toContain("onClick={() => setActiveTab('notifications')}");
    expect(ADMIN_VIEW).toContain('aria-current={activeTab === \'notifications\' ? \'page\' : undefined}');
  });
});

// =============================================================================
// STAGE 3C — THE DESTINATION IS WIRED, AND STAYS WIRED
// =============================================================================
// The seven assertions above pin the registry and the AdminView source guards.
// What they do not cover, and what mounting this section could silently break:
//   * the console's wired-section list, its nav buttons and its mount guards are
//     still ONE list — a section can no longer be added to one and not the others;
//   * the MOBILE drawer really offers the destination (asserted on the drawer's own
//     pure destination function, because the drawer renders through a portal and
//     `react-dom/server` cannot render one);
//   * ONE section renders at a time, so selecting another section REPLACES the
//     outbox instead of leaving it on screen under a section that does not own it;
//   * opening the section reads, and only reads.
// =============================================================================

const PANEL_SOURCE = readFileSync(
  path.resolve(process.cwd(), 'src/components/admin/notifications/NotificationOutboxPanel.tsx'),
  'utf8',
);
const MOBILE_DRAWER = readFileSync(
  path.resolve(process.cwd(), 'src/components/admin/shell/MobileDrawer.tsx'),
  'utf8',
);

const occurrences = (source: string, needle: string): number => source.split(needle).length - 1;

/** Everything between two markers of the console's own source. */
function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`marker not found: ${from} -> ${to}`);
  return source.slice(start, end);
}

/** `WIRED_ADMIN_SECTIONS`, read out of AdminView's source (it cannot be mounted). */
const WIRED_SECTIONS: AdminSectionId[] = (() => {
  const declaration = slice(
    ADMIN_VIEW,
    'const WIRED_ADMIN_SECTIONS',
    'export default function AdminView',
  );
  return [...declaration.matchAll(/'([a-z_]+)'/g)].map((match) => match[1] as AdminSectionId);
})();

/** The console's one navigation landmark — the buttons, not the panels. */
const NAV_MARKUP = slice(ADMIN_VIEW, '<nav', '</nav>');

/** Every panel mount guard in the console, in source order. */
const MOUNT_GUARDS = [...ADMIN_VIEW.matchAll(/\{activeTab === '([a-z_]+)' && \(/g)].map(
  (match) => match[1],
);

describe('STAGE 3C: the wired list, the nav buttons and the mount guards are one list', () => {
  it('wires every registered section — nothing is filtered out any more', () => {
    expect(WIRED_SECTIONS).toEqual(ADMIN_SECTION_IDS);
  });

  it('gives each wired section exactly one nav button and one mount guard', () => {
    for (const id of WIRED_SECTIONS) {
      expect(occurrences(NAV_MARKUP, `onClick={() => setActiveTab('${id}')}`), id).toBe(1);
      expect(
        occurrences(NAV_MARKUP, `aria-current={activeTab === '${id}' ? 'page' : undefined}`),
        id,
      ).toBe(1);
      expect(occurrences(ADMIN_VIEW, `{activeTab === '${id}' && (`), id).toBe(1);
    }
  });

  it('mounts exactly the sections it declares, and nothing else', () => {
    expect(new Set(MOUNT_GUARDS).size).toBe(MOUNT_GUARDS.length);
    expect([...MOUNT_GUARDS].sort()).toEqual([...WIRED_SECTIONS].sort());
  });
});

describe('STAGE 3C: the mobile drawer offers the destination', () => {
  it('lists Notification Outbox in the Operations group, from the registry', () => {
    const groups = visibleAdminNavGroups(WIRED_SECTIONS);
    const operations = groups.find((group) => group.label === 'Operations');
    expect(operations).toBeDefined();
    const item = operations?.items.find((entry) => entry.id === 'notifications');
    expect(item?.label).toBe('Notification Outbox');
    expect(item?.title).toBe('Notification Outbox');
    // The registry's own icon, not a second one chosen here.
    expect(item?.icon).toBe(describeAdminSection('notifications')?.item.icon);
  });

  it('renders it exactly once, last in that group', () => {
    const groups = visibleAdminNavGroups(ADMIN_SECTION_IDS);
    const flat = groups.flatMap((group) => group.items.map((item) => item.id));
    expect(flat.filter((id) => id === 'notifications')).toHaveLength(1);
    const operations = groups.find((group) => group.label === 'Operations');
    expect(operations?.items[operations.items.length - 1].id).toBe('notifications');
  });

  it('keeps the intersection real: a section the console cannot reach is dropped', () => {
    const groups = visibleAdminNavGroups(['stats'] as AdminSectionId[]);
    expect(groups.map((group) => group.label)).toEqual(['Overview']);
    expect(groups.flatMap((group) => group.items.map((item) => item.id))).toEqual(['stats']);
  });

  it('draws its list from the registry and the wired prop — never a second list', () => {
    expect(MOBILE_DRAWER).toContain('visibleAdminNavGroups(sections)');
    expect(MOBILE_DRAWER).toContain('ADMIN_NAV_GROUPS');
    // No destination table of its own: the drawer owns no section list.
    expect(MOBILE_DRAWER).not.toMatch(/const\s+[A-Z_]*(SECTIONS|DESTINATIONS)\s*[:=]/);
  });
});

describe('STAGE 3C: selecting the section opens it, selecting another replaces it', () => {
  it('opens the outbox from the single current-section value, not a second flag', () => {
    expect(ADMIN_VIEW).toContain("{activeTab === 'notifications' && (");
    expect(ADMIN_VIEW).toContain('<NotificationOutboxPanel token={token} />');
    // A second boolean could leave the outbox mounted under another section.
    expect(ADMIN_VIEW).not.toMatch(/\bnotificationsOpen\b/);
    expect(ADMIN_VIEW).not.toMatch(/\bshowNotifications\b/);
  });

  it('drives the panel from the same handler the sidebar buttons call', () => {
    expect(ADMIN_VIEW).toContain('onSelect={(section) => setActiveTab(section as typeof activeTab)}');
    expect(NAV_MARKUP).toContain("onClick={() => setActiveTab('notifications')}");
  });

  it('leaves no other section able to render it', () => {
    // The panel appears in ONE guarded block, so any other selection unmounts it.
    expect(occurrences(ADMIN_VIEW, '<NotificationOutboxPanel')).toBe(1);
    expect(
      occurrences(
        slice(
          ADMIN_VIEW,
          "{activeTab === 'notifications' && (",
          "{activeTab === 'stranded_items' && (",
        ),
        '<NotificationOutboxPanel',
      ),
    ).toBe(1);
  });
});

describe('STAGE 3C: mounting reads, and only reads', () => {
  it('performs exactly one read and names no endpoint of its own', () => {
    expect(occurrences(PANEL_SOURCE, 'fetchAdminNotifications(')).toBe(1);
    // The panel talks to the server only through the existing service.
    expect(PANEL_SOURCE).not.toMatch(/['"`]\/api\//);
    expect(occurrences(PANEL_SOURCE, 'fetch(')).toBe(0);
  });

  it('can reach the retry ONLY through the confirmed workflow', () => {
    expect(occurrences(PANEL_SOURCE, 'retryAdminNotification(')).toBe(1);
    const confirmStart = PANEL_SOURCE.indexOf('const confirmRetry = useCallback(');
    expect(confirmStart).toBeGreaterThan(-1);
    expect(PANEL_SOURCE.indexOf('await retryAdminNotification(')).toBeGreaterThan(confirmStart);
    // ...and the row's own control can only OPEN that dialog.
    expect(occurrences(PANEL_SOURCE, 'void confirmRetry()')).toBe(1);
    expect(PANEL_SOURCE).toContain('onRequestRetry={handleRequestRetry}');
  });
});
