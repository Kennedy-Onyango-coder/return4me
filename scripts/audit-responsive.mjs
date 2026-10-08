// =============================================================================
// RESPONSIVE / PRODUCT-UX RENDER AUDIT  (Batch C, Part 24)
// =============================================================================
// Reads the app the way a user does: it serves the REAL production build
// (dist/) over a synthetic, in-process API (no application server, no database,
// no live provider, no production data), drives headless Microsoft Edge over the
// DevTools Protocol, and measures the ACTUAL rendered layout of every
// representative screen at every representative viewport.
//
// It is a measurement instrument, not a test: it prints findings and writes
// docs/responsive-audit-results.json. Nothing here mutates application state.
//
// Usage:  node scripts/audit-responsive.mjs
// =============================================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const root = process.cwd();
const PORT = 4183;
const CDP_PORT = 9233;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const log = (m) => console.log(`[audit] ${m}`);
setTimeout(() => {
  console.error('[audit] timed out');
  process.exit(124);
}, 900000).unref();

// -----------------------------------------------------------------------------
// 1. SYNTHETIC API — realistic shapes, zero production data
// -----------------------------------------------------------------------------

/** The real category taxonomy, parsed out of the seed the app ships. */
function readCategories() {
  try {
    const source = fs.readFileSync(path.join(root, 'src/db/database.ts'), 'utf8');
    const list = source.slice(source.indexOf('const list = ['), source.indexOf('// Derives Recovery Fee Engine inputs'));
    const parsed = [...list.matchAll(/id: "([^"]+)"[\s\S]*?name_en: "([^"]+)"[\s\S]*?total_fee: (\d+)[\s\S]*?is_sensitive_document: (true|false)/g)]
      .map((m) => ({
        id: m[1], name_en: m[2], name_sw: m[2], total_fee: Number(m[3]),
        is_sensitive_document: m[4] === 'true', active: true, description_en: `${m[2]} recovery`,
      }));
    if (parsed.length) return parsed;
  } catch { /* fall through */ }
  return [
    { id: 'national-id', name_en: 'National ID', name_sw: 'Kitambulisho', total_fee: 500, is_sensitive_document: true, active: true },
    { id: 'driving-license', name_en: 'Driving License', name_sw: 'Leseni ya Udereva', total_fee: 800, is_sensitive_document: true, active: true },
  ];
}
const categories = readCategories();

const itemRow = (n, status) => ({
  id: `ITEM-${n}`, category_id: 'national-id', category_name_en: 'National ID',
  photo_url: 'photo-key.jpg', ocr_extracted_number: `1234567${n}`, ocr_extracted_name: 'JOHN DOE',
  verified_category_id: 'national-id', verified_name: 'JOHN KAMAU', verified_document_number: `1234567${n}`,
  verification_status: 'verified', location_description: 'Kimathi Street, Nairobi CBD', found_county: 'Nairobi',
  finder_phone: '+254712345678', assigned_agent_id: 'AGENT-1', status, flaggedForReview: true,
  isDescriptionOnly: false, description: 'Found near the bus stop matatu stage', is_sensitive_document: true,
  agent_assignment_method: 'gps', agent_assignment_distance_km: 1.2, needs_manual_agent_reassignment: false,
  created_at: '2026-01-01T09:15:00.000Z',
  reputation: { total_reports: 3, rejected_reports: 0, autoFlag: false },
  admin_reputation: { total_reports: 3, rejected_reports: 0, autoFlag: false },
});

const agentRow = (n, status) => ({
  id: `AGENT-${n}`, business_name: `Umoja Handover Hub ${n} Ltd`, contact_phone: '+254700000001',
  contact_email: 'hub@example.test', location_address: 'Kimathi Street, Nairobi', location_source: 'gps',
  coordinate_source: 'device', latitude: -1.2833, longitude: 36.8167, mpesa_till_or_paybill: '123456',
  payout_method_type: 'Till Number', status, refundable_deposit: 500, rating: 4.5, rating_count: 12,
  needs_manual_geocoding: false, warning_count: 2, last_warning_reason: 'Late handover',
  last_warning_at: '2026-02-02T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
  total_earned: 3400, completed_payouts_count: 6,
});

const claimListRow = (n, status) => ({
  id: `CLAIM-${n}`, status, is_active: true, created_at: '2026-02-10T10:00:00.000Z',
  updated_at: '2026-02-11T10:00:00.000Z', claimant_phone: '0712***678', verification_tier: 'standard',
  has_paid: status !== 'pending_payment', paid_at: status === 'pending_payment' ? null : '2026-02-10T11:00:00.000Z',
  payment_state: status === 'pending_payment' ? 'unpaid' : 'paid', financial_state: 'escrow_held',
  agent_confirmed_at: '2026-02-11T09:00:00.000Z',
  item: { id: `ITEM-${n}`, category_id: 'national-id', category_name_en: 'National ID', status: 'at_agent', is_sensitive_document: true, flagged_for_review: false },
  agent: { id: 'AGENT-1', business_name: 'Umoja Handover Hub 1 Ltd' },
  dispute: { state: 'none', id: null, role: null, snapshot_incomplete: false },
});

const dashboardPayload = () => ({
  stats: {
    pendingAgentsCount: 2, itemsInReviewCount: 1, itemsAtAgentCount: 3,
    escrowHeldAmount: 2400, escrowHeldCount: 2, disputesOpenCount: 1, totalRevenue: 18600,
  },
  agents: [agentRow(1, 'pending'), agentRow(2, 'active')],
  disputes: [{
    id: 'DISPUTE-1', item_id: 'ITEM-1', created_at: '2026-02-12T08:00:00.000Z',
    resolved_by: null, resolved_claim_id: null, resolved_at: null,
    claimants: [
      { role: 'original', claim_id: 'CLAIM-1', owner_phone: '0712***678', claim_status: 'escrow_held', has_paid_escrow: true },
      { role: 'contesting', claim_id: 'CLAIM-2', owner_phone: '0700***321', claim_status: 'pending_payment', has_paid_escrow: false },
    ],
  }],
  items: [itemRow(1, 'awaiting_dropoff'), itemRow(2, 'at_agent'), itemRow(3, 'verified')],
  ledger: [1, 2, 3].map((n) => ({
    id: `LED-${n}`, claim_id: `CLAIM-${n}`, type: n === 1 ? 'platform_fee' : 'agent_payout',
    amount: 1200 + n, status: 'completed', created_at: '2026-02-11T12:00:00.000Z',
  })),
  pendingSettlements: [{
    claim_id: 'CLAIM-3', item_id: 'ITEM-3', settle_at: '2026-02-16T10:00:00.000Z',
    agent_business_name: 'Umoja Handover Hub 1 Ltd', agent_id: 'AGENT-1', finder_share: 800, amount: 1600,
  }],
  auditLogs: [{ id: 'AUD-1', action: 'AGENT_APPROVED', admin_user: 'audit.admin', created_at: '2026-02-11T13:00:00.000Z', details: 'Approved agent AGENT-1' }],
  currentAdminTopEnabled: true,
  socialPublishingPaused: false,
});

let identityMode = 'anon';

const json = (res, body, status = 200) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/__audit/identity') {
    identityMode = url.searchParams.get('mode') || 'anon';
    return json(res, { mode: identityMode });
  }

  if (url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') req.resume();
    const p = url.pathname;

    if (p === '/api/categories') return json(res, categories);
    if (p === '/api/stats') return json(res, { activeAgentsCount: 12, itemsReturnedCount: 340, totalItemsCount: 512 });
    if (p === '/api/dev/test-mode') return json(res, { testModeEnabled: false, paymentSimulationEnabled: false });

    if (p === '/api/customer/me') {
      if (identityMode !== 'customer') return json(res, { error: 'Not signed in.' }, 401);
      return json(res, { customer: { id: 'AUDIT-CUSTOMER', full_name: 'Audit Customer', phone: '+254712345678', email: 'audit@example.test', status: 'active', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' } });
    }
    if (p === '/api/customer/claims') return json(res, { claims: [claimListRow(1, 'escrow_held'), claimListRow(2, 'pending_settlement')] });
    if (p === '/api/customer/notifications') return json(res, { notifications: [{ id: 'N-1', title: 'Claim update', body: 'Your claim is in escrow.', created_at: '2026-02-11T10:00:00.000Z', read: false }] });
    if (p.startsWith('/api/lost-reports')) return json(res, { reports: [], matches: [] });

    if (p === '/api/agent/queue') return json(res, { items: [itemRow(2, 'at_agent'), itemRow(3, 'verified')], dropoffs: [itemRow(1, 'awaiting_dropoff')] });
    if (p.startsWith('/api/agent/')) return json(res, {});

    if (p === '/api/admin/dashboard') return json(res, dashboardPayload());
    if (p === '/api/admin/categories') return json(res, categories);
    if (p === '/api/admin/notifications') return json(res, { notifications: [{ id: 'N-1', eventType: 'CLAIM_PAID', channel: 'email', provider: 'resend', status: 'delivered', recipientReference: 'a***@example.test', lastError: null, attemptCount: 1, retryAttemptCount: 0 }] });
    if (p === '/api/admin/settings/pause-status') return json(res, { success: true, statuses: { claimsPaused: false, socialPublishingPaused: false } });
    if (p === '/api/admin/payment-strikes') return json(res, { success: true, strikes: [] });
    if (p === '/api/admin/refund-reconciliation') return json(res, { success: true, reclaimable: [], completed: [] });
    if (p.startsWith('/api/admin/claims')) return json(res, { claims: [claimListRow(1, 'escrow_held')], total: 1, page: 1, pageSize: 20, totalPages: 1 });
    if (p.startsWith('/api/admin/agents')) return json(res, { agents: [agentRow(1, 'pending')], success: true, documents: [] });
    if (p.startsWith('/api/admin/lost-reports')) return json(res, { reports: [], total: 0, page: 1, totalPages: 1 });
    if (p === '/api/items/search') return json(res, []);
    if (p === '/api/items/recent') return json(res, []);
    if (p === '/api/claims/lookup') { req.resume(); return json(res, { error: 'Synthetic claim not found' }, 404); }

    return json(res, {});
  }

  let file = path.join(root, 'dist', url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(path.join(root, 'dist'))) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'dist/index.html');
  const type = ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.end(fs.readFileSync(file));
});

log('starting synthetic server');
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
log(`synthetic server listening on 127.0.0.1:${PORT}`);

// -----------------------------------------------------------------------------
// 2. HEADLESS EDGE OVER THE DEVTOOLS PROTOCOL
//    Same transport the repository's existing audit browser uses: no
//    playwright/puppeteer dependency, just the browser already on the machine.
// -----------------------------------------------------------------------------
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'return4me-responsive-'));
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profileDir}`, 'about:blank',
], { stdio: 'ignore' });
edge.on('error', (error) => console.error(`[audit] Edge launch failed: ${error.message}`));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ws;
const results = { generatedAt: new Date().toISOString(), viewports: [], screens: [], findings: [], pageErrors: [] };
let measureExpression = null;

try {
  let pages;
  for (let i = 0; i < 40; i++) {
    try { pages = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json(); break; } catch { await sleep(300); }
  }
  if (!pages) throw new Error('Edge DevTools endpoint never became available');
  ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

  let id = 0;
  const pending = new Map();
  const loadWaiters = new Set();
  let inFlight = 0;
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const p = pending.get(message.id);
      pending.delete(message.id);
      message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result);
    }
    if (message.method === 'Page.frameStoppedLoading' || message.method === 'Page.loadEventFired') {
      for (const resolve of [...loadWaiters]) resolve();
    }
    // Network idle: without this the measurement can catch a panel that is
    // still fetching, which makes a run report one screen's data state and the
    // next run another. Counted per document so a finished load always starts
    // from zero.
    if (message.method === 'Network.requestWillBeSent') inFlight++;
    if (message.method === 'Network.loadingFinished' || message.method === 'Network.loadingFailed') inFlight = Math.max(0, inFlight - 1);
    if (message.method === 'Page.frameNavigated') inFlight = 0;
    if (message.method === 'Runtime.exceptionThrown') {
      results.pageErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    }
  });
  const waitForLoad = () => new Promise((resolve) => {
    const timer = setTimeout(() => { loadWaiters.delete(waiter); resolve(); }, 8000);
    const waiter = () => { clearTimeout(timer); loadWaiters.delete(waiter); resolve(); };
    loadWaiters.add(waiter);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); reject(new Error(`${method} timed out`)); }, 20000);
    pending.set(next, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    ws.send(JSON.stringify({ id: next, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  };

  await call('Runtime.enable');
  await call('Page.enable');
  await call('Network.enable');
  // Deterministic and offline: nothing outside the synthetic server is fetched,
  // so a slow/failed external request can never be mistaken for a layout defect.
  await call('Network.setBlockedURLs', { urls: ['https://*', 'http://*.com/*', 'http://*.co.ke/*'] });
  log('DevTools connected; external network blocked');

  // ---------------------------------------------------------------------------
  // 3. THE MEASUREMENT — runs inside the page, reads the real rendered layout
  // ---------------------------------------------------------------------------
  // Kept as a real function and stringified, so the instrument is readable and
  // needs no escaping. It returns evidence only; it changes nothing.
  const measureInPage = () => {
    const vw = window.innerWidth;
    const MAX = 8;
    const vis = (el) => {
      if (!el.getClientRects().length) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const sel = (el) => {
      const parts = [];
      for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
        let p = e.tagName.toLowerCase();
        if (e.id) p += '#' + e.id;
        else {
          const cls = (typeof e.className === 'string' ? e.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
          if (cls.length) p += '.' + cls.join('.');
        }
        parts.unshift(p);
      }
      return parts.join('>');
    };
    const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const rect = (el) => el.getBoundingClientRect();

    const main = document.querySelector('main') || document.body;
    const nodes = [main, ...main.querySelectorAll('*')];

    const hScroller = (el) => {
      for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.overflowX === 'auto' || s.overflowX === 'scroll') return e;
      }
      return null;
    };
    const hClipper = (el) => {
      for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.overflowX === 'hidden' || s.overflowX === 'clip') return e;
      }
      return null;
    };

    const overflow = [];
    const clipped = [];
    let ellipsisCount = 0;

    for (const el of nodes) {
      if (el === main || !vis(el)) continue;
      const r = rect(el);
      if (r.width <= 0 && r.height <= 0) continue;
      if (r.right - vw > 1.5 || r.left < -1.5) {
        if (!hScroller(el)) {
          overflow.push({ sel: sel(el), text: text(el), by: Math.round(Math.max(r.right - vw, -r.left)), w: Math.round(r.width) });
        }
      }
      const s = getComputedStyle(el);
      if (s.overflowX === 'hidden' && el.scrollWidth - el.clientWidth > 8) {
        if (s.textOverflow === 'ellipsis') ellipsisCount++;
        else {
          const c = hClipper(el);
          // A visually-hidden helper (the sr-only pattern: an absolutely
          // positioned 1px box) is DELIBERATELY clipped and is not a defect.
          const srOnly = s.position === 'absolute' && r.width <= 2 && r.height <= 2;
          if (!srOnly) {
            clipped.push({
              sel: sel(el), text: text(el), cut: el.scrollWidth - el.clientWidth,
              clipper: c ? sel(c) : null, html: el.outerHTML.slice(0, 300),
            });
          }
        }
      }
    }

    // Interactive controls below the 44px touch floor (phones/tablets only).
    const smallTargets = [];
    if (vw < 768) {
      for (const el of main.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="tab"]')) {
        if (!vis(el) || el.disabled) continue;
        const s = getComputedStyle(el);
        if (s.display === 'inline' && el.tagName === 'A') continue; // inline prose link
        const r = rect(el);
        if (r.width < 24 || r.height < 24) continue; // collapsed/hidden: not a target
        if (r.height >= 44 && r.width >= 44) continue;
        smallTargets.push({
          sel: sel(el), tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height),
          label: el.getAttribute('aria-label') || text(el),
        });
      }
    }

    // Text below the documented 12px floor.
    const tinyText = [];
    for (const el of nodes) {
      if (el === main || !vis(el)) continue;
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue;
      if (!own.replace(/\s+/g, '')) continue;
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (px > 0 && px < 12) tinyText.push({ sel: sel(el), px, text: own.replace(/\s+/g, ' ').trim().slice(0, 40) });
    }

    // Tables: the overall shape, and whether a cut-off column is reachable.
    const tables = [];
    for (const t of main.querySelectorAll('table')) {
      const w = t.parentElement;
      const s = w ? getComputedStyle(w) : null;
      tables.push({
        sel: sel(t),
        tableWidth: Math.round(rect(t).width),
        wrapper: w ? sel(w) : null,
        wrapperClient: w ? w.clientWidth : null,
        wrapperScroll: w ? w.scrollWidth : null,
        scrollable: !!s && (s.overflowX === 'auto' || s.overflowX === 'scroll'),
        columns: t.querySelectorAll('thead th').length,
      });
    }

    // Photographs: aspect distortion and page-breaking widths. An `object-fit:
    // cover` crop is an intentional art-direction choice, never a distortion —
    // only a genuinely stretched image (fill/scale) or a page-breaking width is
    // reported.
    const images = [];
    for (const img of main.querySelectorAll('img')) {
      if (!vis(img)) continue;
      const r = rect(img);
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      const fit = getComputedStyle(img).objectFit;
      const renderedRatio = r.height ? r.width / r.height : 0;
      const naturalRatio = nh ? nw / nh : 0;
      const distorted = fit === 'fill'
        && nw > 0 && nh > 0 && naturalRatio > 0
        && Math.abs(renderedRatio / naturalRatio - 1) > 0.12;
      if (distorted || r.right - vw > 1.5) {
        images.push({ src: (img.getAttribute('src') || '').slice(0, 60), w: Math.round(r.width), h: Math.round(r.height), natural: nw + 'x' + nh, fit, distorted, overflow: r.right - vw > 1.5 });
      }
    }

    // Long unbreakable machine strings (emails, phones, ids) that force width.
    const longStrings = [];
    for (const el of nodes) {
      if (el === main || !vis(el)) continue;
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue;
      const token = own.replace(/\s+/g, ' ').trim();
      if (token.length > 24 && !token.includes(' ') && rect(el).width > 180) {
        longStrings.push({ sel: sel(el), sample: token.slice(0, 32) });
      }
    }

    const dedupe = (list) => {
      const seen = new Set();
      return list.filter((f) => (seen.has(f.sel) ? false : seen.add(f.sel)));
    };
    const byWorst = (list) => dedupe([...list].sort((a, b) => (b.by || b.cut || 0) - (a.by || a.cut || 0))).slice(0, MAX);

    const firstHeading = document.querySelector('main h1, main h2');
    return {
      heading: firstHeading ? text(firstHeading) : null,
      innerWidth: vw,
      innerHeight: window.innerHeight,
      docScrollWidth: document.documentElement.scrollWidth,
      pageOverflowPx: Math.max(0, document.documentElement.scrollWidth - vw),
      bodyOverflowPx: Math.max(0, document.body.scrollWidth - vw),
      overflow: byWorst(overflow),
      overflowCount: overflow.length,
      clipped: byWorst(clipped),
      clippedCount: clipped.length,
      ellipsisCount,
      smallTargets: smallTargets.slice(0, MAX),
      smallTargetCount: smallTargets.length,
      tinyText: tinyText.slice(0, MAX),
      tinyTextCount: tinyText.length,
      tables,
      images: images.slice(0, MAX),
      longStrings: longStrings.slice(0, MAX),
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      h1Count: document.querySelectorAll('main h1').length,
    };
  };
  measureExpression = `(${measureInPage.toString()})()`;

  // ---------------------------------------------------------------------------
  // 4. THE SCREENS AND THE VIEWPORTS
  // ---------------------------------------------------------------------------
  // Every user-facing surface the repository actually ships, in the session
  // states that matter, plus each Admin console section by its nav index.
  const ADMIN_TABS = ['stats', 'agents', 'found_items', 'disputes', 'claims', 'lost_reports', 'ledger', 'review', 'categories', 'strikes'];
  // A syntactically valid (unverified, display-only) admin session, so the
  // console's identity chip renders exactly as it does for a real session.
  const ADMIN_JWT = (() => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ username: 'audit.admin', role: 'admin' })}.auditsignature`;
  })();

  const SCREENS = [
    { id: 'home', path: '/', identity: 'anon' },
    { id: 'lost (I Lost Something)', path: '/lost', identity: 'anon' },
    { id: 'found (I Found Something)', path: '/found', identity: 'anon' },
    { id: 'become-an-agent', path: '/become-an-agent', identity: 'anon' },
    { id: 'sign-in', path: '/sign-in', identity: 'anon' },
    { id: 'help', path: '/help', identity: 'anon' },
    { id: 'report-lost', path: '/report-lost', identity: 'anon' },
    { id: 'activate-email', path: '/activate-email', identity: 'anon' },
    { id: 'activate-agent-email', path: '/activate-agent-email', identity: 'anon' },
    { id: 'account (signed out)', path: '/account', identity: 'anon' },
    { id: 'agent_portal (signed out)', path: '/agent_portal', identity: 'anon' },
    { id: 'console (signed out)', path: '/console', identity: 'anon' },
    { id: 'account (signed in)', path: '/account', identity: 'customer' },
    { id: 'agent_portal (signed in)', path: '/agent_portal', identity: 'agent' },
    { id: 'console = Overview', path: '/console', identity: 'admin' },
    ...ADMIN_TABS.slice(1).map((tab, i) => ({ id: `console = ${tab}`, path: '/console', identity: 'admin', tabIndex: i + 1 })),
    { id: 'privacy', path: '/', identity: 'anon', setup: `try{window.setView('privacy')}catch(e){}` },
    { id: 'terms', path: '/', identity: 'anon', setup: `try{window.setView('terms')}catch(e){}` },
  ];

  const VIEWPORTS = [
    { label: '320x568 small phone', width: 320, height: 568 },
    { label: '360x800 small phone', width: 360, height: 800 },
    { label: '390x844 phone', width: 390, height: 844 },
    { label: '430x932 large phone', width: 430, height: 932 },
    { label: '768x1024 tablet', width: 768, height: 1024 },
    { label: '1024x768 small desktop', width: 1024, height: 768 },
    { label: '1280x800 desktop', width: 1280, height: 800 },
    { label: '1440x900 large desktop', width: 1440, height: 900 },
    { label: '1920x1080 wide', width: 1920, height: 1080 },
  ];

  const origin = `http://127.0.0.1:${PORT}`;
  const setIdentity = (mode) => fetch(`${origin}/__audit/identity?mode=${mode}`).then((r) => r.json());

  // The app lazy-loads every view, and a route change is applied in an effect
  // after the first paint. This waits for the NEW document (the pathname must
  // match) and then until its rendered text and node count stop changing, so
  // every measurement is of the settled screen and never of the one before it.
  const waitForStable = async (expectedPath) => {
    let last = '';
    let stable = 0;
    for (let i = 0; i < 40; i++) {
      let snapshot = '';
      try {
        snapshot = await evaluate(`(()=>{const m=document.querySelector('main');return location.pathname+'#'+(m?(m.innerText||'').length+':'+m.querySelectorAll('*').length:0)})()`);
      } catch { /* mid-navigation */ }
      const onPath = snapshot.startsWith(expectedPath + '#');
      // Both conditions must hold: the DOM has stopped changing AND nothing is
      // still in flight. The second is what stops a panel mid-fetch from being
      // measured as if it were the settled screen.
      if (onPath && snapshot === last && inFlight === 0) {
        stable++;
        if (stable >= 4) return true;
      } else {
        stable = 0;
      }
      last = snapshot;
      await sleep(130);
    }
    return false;
  };

  // localStorage persists for the origin, so tokens are applied once per change
  // rather than on every navigation.
  const applyTokens = (mode) => evaluate(
    `localStorage.removeItem('agent_token');localStorage.removeItem('admin_token');`
    + (mode === 'agent' ? `localStorage.setItem('agent_token','audit.token.value');` : '')
    + (mode === 'admin' ? `localStorage.setItem('admin_token',${JSON.stringify(ADMIN_JWT)});` : ''),
  );

  // ---------------------------------------------------------------------------
  // 5. DRIVE THE AUDIT
  // ---------------------------------------------------------------------------
  const openScreen = async (screen) => {
    await setIdentity(screen.identity);
    await call('Page.navigate', { url: origin + screen.path });
    await waitForLoad();
    const mounted = await waitForStable(screen.path);
    if (screen.setup) {
      await evaluate(screen.setup);
      await waitForStable(screen.path);
    }
    let clickedTab = null;
    if (typeof screen.tabIndex === 'number') {
      clickedTab = await evaluate(`(()=>{const b=document.querySelectorAll('.r4m-admin-nav > button')[${screen.tabIndex}]; if(!b) return null; b.click(); return (b.textContent||'').trim()})()`);
      await waitForStable(screen.path);
    }
    const activeTab = await evaluate(`(()=>{const b=document.querySelector('.r4m-admin-nav > button[aria-current="page"]'); return b?(b.textContent||'').trim():null})()`);
    return { mounted, clickedTab, activeTab };
  };

  await call('Page.navigate', { url: origin + '/' });
  await waitForLoad();
  await waitForStable('/');
  let appliedTokens = 'anon';
  await applyTokens('anon');
  log('bootstrap page loaded');

  for (const vp of VIEWPORTS) {
    await call('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.width < 768 });
    for (const screen of SCREENS) {
      if (screen.identity !== appliedTokens) {
        await applyTokens(screen.identity);
        appliedTokens = screen.identity;
      }
      const opened = await openScreen(screen);
      let m;
      try { m = await evaluate(measureExpression); } catch (e) { m = { error: String(e).slice(0, 200) }; }
      results.screens.push({ viewport: vp.label, width: vp.width, height: vp.height, screen: screen.id, ...opened, ...m });
      process.stdout.write(`\r[audit] ${vp.label.padEnd(24)} ${screen.id.padEnd(30)}`);
    }
  }
  process.stdout.write('\n');
  log('render pass complete');

  // ---------------------------------------------------------------------------
  // 6. REPORT — only what a reader can act on
  // ---------------------------------------------------------------------------
  const num = (v) => (typeof v === 'number' ? v : 0);
  const push = (kind, row, detail) => results.findings.push({ kind, viewport: row.viewport, screen: row.screen, detail });

  for (const row of results.screens) {
    if (row.error) { push('page-error', row, row.error); continue; }
    if (!row.mounted) push('did-not-mount', row, 'root never rendered');
    if (num(row.pageOverflowPx) > 0) {
      push('page-horizontal-overflow', row, `${row.pageOverflowPx}px beyond the viewport; worst offender: ${(row.overflow[0] || {}).sel || 'unknown'}`);
    }
    for (const o of row.overflow || []) push('element-beyond-viewport', row, `${o.sel} (${o.by}px past the edge, w=${o.w})`);
    for (const c of row.clipped || []) push('content-clipped-no-scroll', row, `${c.sel} cut by ${c.cut}px inside ${c.clipper} :: ${c.html}`);
    for (const t of row.smallTargets || []) {
      // Two different things. WCAG 2.2 AA "Target Size (Minimum)" is 24x24 CSS
      // px; 44x44 is the stricter recommendation the Return4me button ladder
      // meets on its DEFAULT size (sm is a deliberate 36px compact step for
      // dense consoles). They are reported separately so a documented compact
      // control is never conflated with a genuinely crushed one.
      const kind = (t.w < 24 || t.h < 24) ? 'tap-target-under-24-wcag' : 'tap-target-under-44-recommended';
      push(kind, row, `${t.tag} "${t.label}" ${t.w}x${t.h} - ${t.sel}`);
    }
    for (const t of row.tinyText || []) push('text-under-12px', row, `${t.px}px "${t.text}" - ${t.sel}`);
    for (const t of row.tables || []) {
      if (t.tableWidth > num(t.wrapperClient) + 1 && !t.scrollable) {
        push('table-cut-without-scroll', row, `${t.columns}-column table ${t.tableWidth}px in a ${t.wrapperClient}px box that does not scroll`);
      }
    }
    for (const i of row.images || []) {
      if (i.distorted) push('image-distorted', row, `${i.src} rendered ${i.w}x${i.h} from ${i.natural} (object-fit: ${i.fit})`);
      if (i.overflow) push('image-overflows', row, i.src);
    }
  }

  const byKind = {};
  for (const f of results.findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;

  console.log('\n================ FINDING SUMMARY ================');
  for (const [kind, count] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`${String(count).padStart(5)}  ${kind}`);
  }
  if (results.pageErrors.length) {
    console.log(`\n--- ${results.pageErrors.length} uncaught page exception(s) ---`);
    for (const e of [...new Set(results.pageErrors)].slice(0, 10)) console.log('  ' + String(e).split('\n')[0].slice(0, 160));
  }

  const score = (row) => num(row.pageOverflowPx) * 10 + num(row.overflowCount) * 5 + num(row.clippedCount) * 3 + num(row.smallTargetCount) + num(row.tinyTextCount);
  const worst = [...results.screens].filter((r) => !r.error).sort((a, b) => score(b) - score(a)).slice(0, 30);
  console.log('\n================ 30 WORST SCREEN/VIEWPORT PAIRS ================');
  for (const r of worst) {
    console.log(`${String(score(r)).padStart(5)}  ${r.viewport.padEnd(24)} ${r.screen.padEnd(30)} ovf=${num(r.pageOverflowPx)}px off=${num(r.overflowCount)} clip=${num(r.clippedCount)} tap=${num(r.smallTargetCount)} tiny=${num(r.tinyTextCount)}`);
  }

  fs.writeFileSync(path.join(root, 'docs/responsive-audit-results.json'), JSON.stringify(results, null, 2));
  console.log('\n[audit] wrote docs/responsive-audit-results.json');
} finally {
  ws?.close();
  edge.kill();
  server.close();
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
}






