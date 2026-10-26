import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_NAV_GROUPS,
  ADMIN_SECTION_IDS,
  describeAdminSectionCopy,
  describeAdminSection,
} from '../../shell/adminNavRegistry';

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
