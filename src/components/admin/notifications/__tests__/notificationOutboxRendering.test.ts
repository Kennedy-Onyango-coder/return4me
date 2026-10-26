import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import NotificationOutboxTable from '../NotificationOutboxTable';
import { mapAdminNotificationItem, type AdminNotificationRow } from '../../../../services/adminNotificationsApi';
import { NOT_RECORDED_TEXT } from '../notificationOutboxPresentation';

// =============================================================================
// BATCH A2 — WHAT THE OUTBOX TABLE ACTUALLY RENDERS
// =============================================================================
// Assertions are made against REAL rendered HTML (`react-dom/server`, the same
// approach as the sibling payout and audit rendering tests), with the fixtures
// built through the REAL mapper, so the whitelist and the table are exercised
// together.
//
// Pinned, in order of consequence:
//   1. a retry control exists ONLY for a row the server would accept;
//   2. the recipient is the MASKED reference, never a raw number — and a field
//      the mapper does not name cannot reach the DOM at all;
//   3. a missing value says so instead of rendering a blank cell or a zero;
//   4. status meaning is carried by TEXT, so it survives greyscale and a screen
//      reader;
//   5. no logging and no markup injection in the components.
// =============================================================================

const RAW_PHONE = '254712345678';

function row(overrides: Record<string, unknown> = {}): AdminNotificationRow {
  const mapped = mapAdminNotificationItem({
    id: 'ne-1',
    eventType: 'ITEM_HANDED_OVER',
    channel: 'email',
    provider: 'resend',
    status: 'retryable_failure',
    recipientReference: 'o***@example.com',
    lastError: 'provider_550_message_rejected',
    businessReference: 'CLM-1',
    retryClass: 'reconstructable',
    retryable: true,
    attemptCount: 2,
    retryAttemptCount: 1,
    createdAt: '2026-01-01T09:00:00.000Z',
    updatedAt: null,
    sentAt: null,
    nextAttemptAt: null,
    ...overrides,
  });
  if (!mapped) throw new Error('fixture did not map');
  return mapped;
}

function render(rows: AdminNotificationRow[], inFlightId: string | null = null): string {
  return renderToStaticMarkup(
    React.createElement(NotificationOutboxTable, {
      rows,
      inFlightId,
      onRequestRetry: () => undefined,
    }),
  );
}

describe('the table offers a retry only where the server would accept one', () => {
  it('renders one enabled Retry for an eligible row', () => {
    const html = render([row()]);
    expect(html).toContain('Retry');
    expect(html).toContain('aria-label="Retry ITEM_HANDED_OVER notification"');
    expect(html).not.toContain('disabled=""');
  });

  it('renders NO control at all for an ineligible row, and states why', () => {
    const ineligible = row({ status: 'unknown' });
    const html = render([ineligible]);
    expect(html).not.toMatch(/<button/);
    // The reason is rendered, not implied. Its quoted status is HTML-escaped by
    // React, so the assertion is made on the unquoted leading sentence.
    expect(html).toContain('Only a retryable failure can be re-sent');
    expect(html).toContain('Unknown outcome');
  });

  it('disables every retry while one retry is in flight', () => {
    const html = render([row(), row({ id: 'ne-2' })], 'ne-1');
    expect(html).toContain('disabled=""');
    // Both rows still show their control; neither may start a second send.
    expect(html.match(/Retry<\/button>/g)?.length).toBe(2);
  });
});

describe('the recipient is the masked reference — a named-field whitelist', () => {
  it('renders the masked reference and never a raw number from the payload', () => {
    const html = render([row({ recipientPhone: RAW_PHONE, phone: RAW_PHONE })]);
    expect(html).toContain('o***@example.com');
    expect(html).not.toContain(RAW_PHONE);
  });

  it('says the recipient was not recorded instead of leaving a blank cell', () => {
    const html = render([row({ recipientReference: null })]);
    expect(html).toContain(NOT_RECORDED_TEXT);
  });
});

describe('status meaning is carried by text, not by colour', () => {
  it('prints the status label and its meaning', () => {
    const html = render([row({ status: 'unknown' })]);
    expect(html).toContain('Unknown outcome');
    expect(html).toContain('may already have arrived');
  });

  it('flags a status this console does not recognise', () => {
    const html = render([row({ status: 'quantum_failure' })]);
    expect(html).toContain('Unrecognised status');
  });

  it('prints the attempt history, or says it was not recorded', () => {
    expect(render([row()])).toContain('2 attempts, 1 retry');
    expect(render([row({ attemptCount: null, retryAttemptCount: null })]))
      .toContain('Attempts not recorded');
  });
});

describe('the table is a labelled data region with real headers', () => {
  it('names itself and its columns for assistive technology', () => {
    const html = render([row()]);
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Notification delivery failures"');
    expect(html).toContain('<caption');
    expect(html).toContain('scope="col"');
    expect(html).toContain('Recipient (masked)');
  });

  it('renders nothing at all for an empty window (the panel owns that copy)', () => {
    expect(render([])).toBe('');
  });
});

describe('the components cannot log or inject markup', () => {
  const sources = [
    'src/components/admin/notifications/NotificationOutboxTable.tsx',
    'src/components/admin/notifications/NotificationOutboxPanel.tsx',
    'src/components/admin/notifications/notificationOutboxPresentation.ts',
    'src/services/adminNotificationsApi.ts',
  ];

  it('contains no console call and no dangerouslySetInnerHTML', () => {
    for (const relative of sources) {
      const source = readFileSync(path.resolve(process.cwd(), relative), 'utf8');
      // Scoped to actual console CALLS: these modules are heavily commented, and a
      // prose sentence ending in "the console." is not a logging statement.
      expect(source, relative).not.toMatch(/console\.(log|error|warn|info|debug)\s*\(/);
      expect(source, relative).not.toContain('dangerouslySetInnerHTML');
    }
  });
});
