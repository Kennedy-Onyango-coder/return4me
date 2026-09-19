import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// PHASE 15 (BATCH 4) - CUSTOMER ACCOUNT GATE + LOST-REPORT WIZARD
// =============================================================================
// Both surfaces were modernized as PRESENTATION only. These tripwires pin the
// behaviour that must not move with the markup: the gate's endpoints and
// request bodies, the absence of any second authentication mechanism, its
// single page heading and control semantics, and the wizard's single submit
// path, payload keys and field/label pairing.
//
// Same rationale as the repository's other boundary suites: there is no
// jsdom/React harness, so the contract is asserted against the shipped source.

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const gate = read('src/components/CustomerAccountView.tsx');
const gateCode = stripComments(gate);
const wizardCode = stripComments(read('src/components/customer/LostReportWizard.tsx'));

describe('15-B4: the account gate keeps the existing customer session flow', () => {
  it('uses exactly the existing customer endpoints, in the same order', () => {
    const endpoints = Array.from(gateCode.matchAll(/'(\/api\/customer\/[^']*)'/g)).map((m) => m[1]);
    expect(endpoints).toEqual([
      '/api/customer/me',
      '/api/customer/register',
      '/api/customer/login',
      '/api/customer/register/verify',
      '/api/customer/login/verify',
      '/api/customer/logout',
    ]);
  });

  it('sends the same request bodies as before', () => {
    expect(gateCode).toContain('? { fullName: fullName.trim(), phone: normalized }');
    expect(gateCode).toContain(': { phone: normalized };');
    expect(gateCode).toContain('? { fullName: fullName.trim(), phone, code: code.trim() }');
    expect(gateCode).toContain(': { phone, code: code.trim() };');
    expect((gateCode.match(/JSON\.stringify\(body\)/g) || []).length).toBe(2);
  });

  it('introduces no second authentication mechanism', () => {
    expect(gateCode).not.toMatch(/localStorage|sessionStorage/);
    expect(gateCode).not.toMatch(/bearer/i);
    expect(gateCode).not.toMatch(/customer_token|agent_token|admin_token/);
    // The existing cookie session is resolved by the server, not the client.
    expect(gateCode).toContain("fetch('/api/customer/me')");
    expect(gateCode).toContain("credentials: 'same-origin'");
  });

  it('still reports session end to the app chrome', () => {
    expect(gate).toContain('onSessionEnded?');
  });
});

describe('15-B4: the gate renders one heading and keeps its controls semantic', () => {
  it('renders exactly one <h1>', () => {
    expect((gateCode.match(/<h1/g) || []).length).toBe(1);
  });

  it('keeps the register/sign-in switch and its tablist semantics', () => {
    expect(gateCode).toContain('role="tablist"');
    expect((gateCode.match(/role="tab"/g) || []).length).toBe(2);
    expect((gateCode.match(/aria-selected=/g) || []).length).toBe(2);
  });

  it('uses one submit control per form, through the shared primitives', () => {
    expect((gateCode.match(/type="submit"/g) || []).length).toBe(2); // details + OTP
    expect(gateCode).toContain('<Button');
    expect(gateCode).toContain('<Input');
    expect(gateCode).toContain('<Banner');
  });
});

describe('15-B4: the wizard still submits once, through the existing service', () => {
  it('has exactly one submit control and one createLostReport call', () => {
    expect((wizardCode.match(/type="submit"/g) || []).length).toBe(1);
    expect((wizardCode.match(/createLostReport\(payload\)/g) || []).length).toBe(1);
    expect(wizardCode).toContain('const payload: LostReportCreatePayload = {');
  });

  it('keeps every payload key and never calls the API directly', () => {
    for (const key of [
      'categoryId', 'county', 'locationArea', 'locationLandmark', 'lostAtFrom', 'lostAtTo',
      'brand', 'model', 'colour', 'material', 'description', 'distinctiveMarks',
      'documentType', 'documentNumber',
    ]) {
      expect(wizardCode, `payload key ${key}`).toContain(`${key}:`);
    }
    expect(wizardCode).not.toMatch(/fetch\(/);
    expect(wizardCode).not.toContain("'/api/");
  });

  it('labels every field and keeps the existing step contract', () => {
    const fields = (wizardCode.match(/<(Input|Select|Textarea)\b/g) || []).length;
    const labels = (wizardCode.match(/\n\s+label=\{/g) || []).length;
    expect(fields).toBeGreaterThan(8);
    expect(labels).toBeGreaterThanOrEqual(fields);
    expect(wizardCode).toContain('<Stepper');
    expect(wizardCode).toContain('LOST_REPORT_WIZARD_STEPS.map');
    expect(wizardCode).not.toMatch(/<h1/);
  });
});
