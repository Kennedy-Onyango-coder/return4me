import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// BATCH B — BACKEND LANGUAGE INVARIANT (requirements 1, 2).
//
// Part 1 of this batch removed the remaining Kiswahili and mixed
// Kiswahili/English language from the BACKEND: server.ts, the route modules, the
// services, the schema/seed layer and the server-side config. This file is the
// machine-checkable record of that, so the cleanup cannot silently regress the
// next time somebody adds an error message or an email template.
//
// WHAT THIS FILE DELIBERATELY DOES *NOT* CLAIM
//   It does not claim the whole repository is English only, because two things
//   outside its scope legitimately still contain Kiswahili:
//
//     * FRONTEND i18n (`src/components/**`, `src/types.ts`, the `lang === 'sw'`
//       branches). Those are deliberate bilingual UI copy owned by the earlier
//       frontend batch and asserted by their own tests; this batch changes no
//       frontend file.
//
//     * i18n DATA VALUES — `categories.name_sw`, and the `blurbSw` / `labelSw`
//       fields in config/categoryTaxonomy.ts. These are not messages: they are the
//       Swahili half of a bilingual data column that the product reads with
//       `lang === 'sw' ? name_sw : name_en`. Deleting them would be data loss and
//       would break existing tests, and the brief explicitly forbids removing a
//       data value merely because it contains Kiswahili. They are asserted BELOW
//       to still be present, so the exclusion is a recorded decision rather than
//       an oversight.
// =============================================================================

const ROOT = path.resolve(__dirname, '../..');

function read(rel: string): string {
  return fs.readFileSync(path.resolve(ROOT, rel), 'utf8');
}

function walk(rel: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.resolve(ROOT, rel), { withFileTypes: true })) {
    const relPath = `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(relPath, out);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(relPath);
  }
  return out;
}

/**
 * Every backend source file, excluding tests (tests legitimately quote old
 * strings in negative assertions) and the frontend.
 */
const BACKEND_FILES = [
  'src/server.ts',
  ...walk('src/routes'),
  ...walk('src/services'),
  ...walk('src/db'),
  ...walk('src/config'),
  ...walk('src/utils'),
].filter((f) => !f.includes('__tests__') && !f.endsWith('.test.ts'));

/**
 * Kiswahili words that were actually used as MESSAGE text in this codebase.
 * Derived from the pre-change tree, so it is evidence rather than guesswork.
 */
const KISWAHILI_MARKERS = [
  'Ruhusa', 'Wasimamizi', 'Msimamizi', 'Tafadhali', 'Msimbo', 'misimbo', 'Bidhaa',
  'Nambari', 'Akaunti', 'Malipo', 'Maelezo', 'Wakala', 'Mzozo', 'Hakuna',
  'Hitilafu', 'Uthibitisho', 'Kitambulisho', 'Tarehe', 'Ushahidi', 'Onyo',
  'Kaunti', 'Majina', 'Vigezo', 'Ufikiaji', 'Kipindi', 'Mahali', 'Kiasi',
  'Maudhui', 'Faili', 'herufi', 'marekebisho', 'Haijapatikana', 'Taarifa',
  'Imeshindikana', 'Imeshindwa', 'Umetafuta', 'Umeripoti', 'Umeangalia',
  'Umekwishajaribu', 'Umekwishatuma', 'Umekosea', 'Umejaribu', 'Nenosiri',
  'Barua pepe', 'Haipatikani', 'haipatikani', 'Jisajili', 'kujisajili',
  'Funguo', 'Taslimu', 'Mkoba', 'Shajara', 'Daftari', 'Baiskeli',
];

/**
 * The i18n DATA columns. Lines that DEFINE one of these are excluded from the
 * message scan, and separately asserted to still exist.
 */
const DATA_VALUE_LINE = /^\s*(name_sw|blurbSw|labelSw)\s*:/;

function messageTextOf(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => !DATA_VALUE_LINE.test(line))
    .join('\n');
}

describe('Batch B — the backend speaks English only', () => {
  it('the known Kiswahili admin refusal is now English, everywhere it was used', () => {
    const server = read('src/server.ts');

    expect(server).not.toContain('Ruhusa hii ni ya Wasimamizi (Admins) tu.');
    expect(server).not.toContain('Ruhusa imekataliwa.');
    // The replacement is present and is stated once per file as the canonical
    // refusal, so an operator sees one consistent message.
    expect(server).toContain("Administrator access required.");
    expect(server).toContain("Access denied.");
  });

  it('no backend source file contains any Kiswahili MESSAGE text', () => {
    const offenders: string[] = [];

    for (const file of BACKEND_FILES) {
      const text = messageTextOf(read(file));
      for (const marker of KISWAHILI_MARKERS) {
        if (new RegExp(`\\b${marker}\\b`).test(text)) offenders.push(`${file} -> ${marker}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the bilingual email halves and their divider are gone', () => {
    const email = read('src/services/email.ts');
    const emailOtp = read('src/services/emailOtp.ts');
    const templates = read('src/services/emailTemplates.ts');
    const customerAuth = read('src/services/customerAuth.ts');

    // The Swahili half of every templated email.
    for (const source of [email, emailOtp, customerAuth]) {
      expect(source).not.toContain("emailDivider('Kiswahili')");
      expect(source).not.toContain('headingSw');
      expect(source).not.toContain('introSw');
      expect(source).not.toContain('codeLabelSw');
      expect(source).not.toContain('hintSw');
    }

    // The helper itself is gone, including its 'Kiswahili' default.
    expect(templates).not.toContain('export function emailDivider');

    // And the subjects are single-language now.
    expect(email).toContain("'Payment Confirmed - Return4me'");
    expect(email).toContain("'Item Handed Over Successfully - Return4me'");
    expect(email).toContain("'Your Found Item Has Been Returned - Return4me'");
    expect(email).not.toContain('Malipo Imethibitishwa');
    expect(email).not.toContain('Bidhaa Imekabidhiwa');
  });

  it('a bilingual "{Swahili} / {English}" message no longer exists in the backend', () => {
    // The repository's bilingual convention. A surviving Kiswahili half in front
    // of an English half is the exact shape this batch removed, so the specific
    // repaired examples are pinned.
    const server = read('src/server.ts');
    const claims = read('src/routes/claims.ts');
    const agentOps = read('src/routes/agentOps.ts');

    expect(server).not.toContain('Mahali pa Agent pamesasishwa. /');
    expect(server).not.toContain('Kiasi cha kurejesha hakijaweza kubainishwa. /');
    expect(server).not.toContain('Ombi lako ni kubwa kupita kiasi. /');
    expect(claims).not.toContain('Majibu ya usalama si sahihi. ');
    expect(agentOps).not.toContain('Msimbo wa kuwasilisha (Drop-off code) si sahihi.');

    expect(server).toContain("message: 'Agent location updated.'");
    expect(agentOps).toContain("The drop-off code is not correct.");
  });

  it('keeps the category i18n DATA values it deliberately did not touch', () => {
    // Not messages: the Swahili column the product reads when the UI language is
    // Swahili. Recorded here so the exclusion is a decision, not a silent gap.
    const database = read('src/db/database.ts');
    expect(database).toContain('name_sw: "Kitambulisho cha Kitaifa"');

    const taxonomy = read('src/config/categoryTaxonomy.ts');
    expect(taxonomy).toMatch(/blurbSw:/);
    expect(taxonomy).toMatch(/labelSw:/);
  });

  it('translates the operator-facing strings an admin actually reads', () => {
    expect(read('src/routes/adminClaims.ts')).not.toContain('Ruhusa imekataliwa.');
    expect(read('src/services/adminPermissions.ts')).toContain("error: 'Access denied.'");
    expect(read('src/services/storage.ts')).not.toContain('Faili batili au tupu.');
    expect(read('src/services/storage.ts')).toContain('Image size exceeds the 8MB limit.');
  });
});

// =============================================================================
// THE ASSIGNMENT VOCABULARY IS DECLARED, NOT INVENTED AT A CALL SITE.
// =============================================================================
describe('Batch B — the assignment notification events are part of the closed vocabulary', () => {
  it('declares the three events with their channel, recipient and retry class', () => {
    const events = read('src/config/notificationEvents.ts');

    for (const eventType of ['AGENT_ITEM_ASSIGNED', 'FINDER_AGENT_ASSIGNED', 'CLAIMANT_AGENT_ASSIGNED']) {
      expect(events).toContain(`eventType: '${eventType}'`);
    }

    // Email, transactional, retryable because none of them carries a secret.
    expect(events).toMatch(/eventType: 'AGENT_ITEM_ASSIGNED',[\s\S]{0,220}channel: 'email'/);
    expect(events).toMatch(/eventType: 'AGENT_ITEM_ASSIGNED',[\s\S]{0,220}retryClass: 'reconstructable'/);
    expect(events).toMatch(/eventType: 'FINDER_AGENT_ASSIGNED',[\s\S]{0,220}recipientKind: 'finder'/);
    expect(events).toMatch(/eventType: 'CLAIMANT_AGENT_ASSIGNED',[\s\S]{0,220}recipientKind: 'owner'/);
  });

  it('gives every new event an auditable origin, as the existing vocabulary does', () => {
    const events = read('src/config/notificationEvents.ts');
    for (const eventType of ['AGENT_ITEM_ASSIGNED', 'FINDER_AGENT_ASSIGNED', 'CLAIMANT_AGENT_ASSIGNED']) {
      expect(events).toMatch(
        new RegExp(`eventType: '${eventType}'[\\s\\S]{0,400}origin: 'services/agentAssignmentNotifications\\.ts`),
      );
    }
  });
});
