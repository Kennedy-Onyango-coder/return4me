import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// REGRESSION COVERAGE — Admin Agents-tab data freshness (no React Testing
// Library / jsdom infra exists in this repo; the established pattern for
// frontend behaviour that isn't directly unit-testable is a static
// source-audit test, see e.g. activeAgentAuthorization.test.ts and the route
// audit tests in src/__tests__).
//
// Problem this pins down (production-audit P1): the Admin Dashboard only
// fetched /api/admin/dashboard on login and after admin mutations. If a new
// agent registered while an admin was ALREADY authenticated, the admin could
// return to the Agents tab and see a stale list that hid the just-registered
// pending application — the "agent says waiting-for-approval, admin sees
// nothing" symptom. Fix: refetch on entering the Agents tab, deduplicated by an
// in-flight guard so a tab entry never spawns a second concurrent request.
const adminViewTs = fs.readFileSync(path.resolve(__dirname, '../components/AdminView.tsx'), 'utf8');

describe('Admin Agents tab data freshness', () => {
  it('refetches the dashboard when the admin enters the Agents tab (a just-registered agent must not be hidden by a stale list)', () => {
    expect(adminViewTs).toMatch(/activeTab === 'agents' && token/);
    expect(adminViewTs).toMatch(/fetchDashboardData\(\)/);
  });

  it('deduplicates concurrent dashboard fetches instead of firing duplicate requests on tab entry', () => {
    // In-flight guard: fetchDashboardData returns early while one is running,
    // and clears the flag in finally.
    expect(adminViewTs).toMatch(/dashboardFetchInFlightRef\.current\s*\)\s*return/);
    expect(adminViewTs).toMatch(/dashboardFetchInFlightRef\.current = false;/);
  });

  it('renders pending agents by default (status filter defaults to "all", which includes "pending")', () => {
    // The Agents directory must not silently exclude pending applications —
    // /api/admin/dashboard returns them and the tab must surface them.
    expect(adminViewTs).toMatch(/agentStatusFilter === 'all' \|\| a\.status === agentStatusFilter/);
  });
});
