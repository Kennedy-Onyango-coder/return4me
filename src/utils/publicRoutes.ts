// PUBLIC ROUTING FOUNDATION (Phase 7B)
// ====================================
// Return4me is a single-page app whose screens were historically selected by
// React state alone: the URL never changed, so a found item could not be
// linked, bookmarked, shared or refreshed. This module is the smallest thing
// that fixes that without adopting a routing framework (none is installed, and
// the app's ~7 screens do not justify one).
//
// It is deliberately PURE: parse a location, build a path, validate a return
// destination. All history/DOM interaction lives in App.tsx, so every branch
// here is unit-testable without a DOM.
//
// SUPPORTED PUBLIC PATHS
//   /                 home
//   /item/:id         public found-item detail
//   /account          existing customer account surface (unchanged)
//   /lost             I Lost Something  (owner / claimant journey)
//   /report-lost      Report a Lost Item (Phase 11A) — the dedicated entry to
//                     the EXISTING customer lost-report experience. It is the
//                     one destination the /lost page's "Report a Lost Item"
//                     call to action leads to, and the one safe post-sign-in
//                     return path a lost reporter can be sent back to.
//   /found            I Found Something (finder report journey)
//   /become-an-agent  public Agent journey (leads to /agent_portal)
//   /sign-in          the single Sign In chooser (Owner/Claimant vs Agent)
//   /console          admin console, now genuinely BOOKMARKABLE (see App.tsx —
//                     it used to rewrite the URL to '/' the moment it opened,
//                     which both destroyed the bookmark and, on the second
//                     React StrictMode effect pass, re-read the now-'/'
//                     location and bounced the admin straight back to Home)
//   /agent_portal     existing agent view, now addressable
//   /?claim=<itemId>  LEGACY: the link social.ts has already published. It is
//                     translated to /item/<itemId> — never treated as an
//                     authentication or claim action, so an existing link can
//                     never become a dead end.

export type PublicViewName = 'home' | 'finder' | 'owner' | 'agent' | 'admin' | 'privacy' | 'terms' | 'signin' | 'becomeAgent';

export type PublicRoute =
  | { kind: 'home' }
  | { kind: 'item'; itemId: string }
  | { kind: 'account'; next: string | null }
  | { kind: 'console' }
  | { kind: 'agent' }
  // PHASE 11A — the dedicated "Report a Lost Item" page. It is the public entry
  // point to the EXISTING customer lost-report experience (the same wizard the
  // dashboard hosts), so a visitor who lost something is no longer expected to
  // discover reporting by accident inside their account dashboard. The route
  // carries no data: the page itself resolves whether a customer session exists
  // and either renders the existing reporting experience or hands off to the
  // existing /account authentication boundary.
  | { kind: 'reportLost' }
  // A plain, public, unauthenticated screen identified by its own path. These
  // are the state-driven views that also have a real URL, so they can be
  // linked, bookmarked and refreshed like any other page.
  | { kind: 'view'; view: PublicViewName };

const ITEM_PATH_PREFIX = '/item';
const ITEM_PATH = /^\/item\/([^/]+)$/i;
const ACCOUNT_PATH = '/account';
const CONSOLE_PATH = '/console';
const AGENT_PATH = '/agent_portal';
const LOST_PATH = '/lost';
const FOUND_PATH = '/found';
const REPORT_LOST_PATH = '/report-lost';
const BECOME_AGENT_PATH = '/become-an-agent';
const SIGNIN_PATH = '/sign-in';

// Path -> view for the addressable, unauthenticated public screens. Every entry
// here must also appear in RESTORABLE_VIEWS below: a path that can be entered
// directly but not restored from history would dead-end on Back.
const VIEW_PATHS: ReadonlyArray<{ path: string; view: PublicViewName }> = [
  { path: LOST_PATH, view: 'owner' },
  { path: FOUND_PATH, view: 'finder' },
  { path: BECOME_AGENT_PATH, view: 'becomeAgent' },
  { path: SIGNIN_PATH, view: 'signin' },
];

// The customer account surface is the authentication boundary the public item
// page hands off to. Only these shapes may be used as a post-authentication
// return destination — an attacker-supplied "next" must never be able to turn
// the sign-in card into an open redirect, and must never point at anything that
// is not a plain, public page.
//
// PHASE 11A adds EXACTLY ONE more accepted shape: /report-lost, the lost-report
// entry point. Widening this whitelist is a deliberate, reviewed act, and this
// is deliberately a closed alternation of two literal app-owned path shapes (no
// wildcard, no prefix match) rather than a loosened pattern:
//   /item/<id>     — the public found-item page a visitor came from
//   /report-lost   — the public lost-report entry point
// Neither can be reached before authentication in a state that reveals anything
// private: /report-lost renders only a sign-in prompt until a session exists.
const SAFE_RETURN_PATH = /^\/(?:item\/[^/]+|report-lost)$/i;

// 'signin' and 'becomeAgent' are public, unauthenticated screens (Phase 8.1),
// so restoring them from history state is safe for the same reason 'home' and
// 'finder' are. 'admin' and 'agent' stay excluded: restoring an
// authentication-gated surface from a crafted history entry is exactly the
// "hidden React state as a security control" this helper exists to prevent.
const RESTORABLE_VIEWS: ReadonlyArray<PublicViewName> = ['home', 'finder', 'owner', 'privacy', 'terms', 'signin', 'becomeAgent'];

export function normalizePath(pathname: string): string {
  if (!pathname) return '/';
  let p = pathname.trim();
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

/** Canonical public path for a found item. */
export function itemPath(itemId: string): string {
  return `${ITEM_PATH_PREFIX}/${encodeURIComponent(String(itemId || '').trim())}`;
}

/**
 * Canonical public path for the "Report a Lost Item" entry point (Phase 11A).
 * A function rather than a bare constant so no caller hand-concatenates it,
 * matching itemPath()/accountPath().
 */
export function reportLostPath(): string {
  return REPORT_LOST_PATH;
}

/**
 * The canonical /account URL a lost reporter is sent through, remembering that
 * they should land back on the reporting entry point once authenticated. Built
 * here (not in a component) so the return destination always goes through
 * isSafeReturnPath, exactly like the /item/:id hand-off does.
 */
export function reportLostSignInPath(): string {
  return accountPath(REPORT_LOST_PATH);
}

/** Canonical path for the account surface, preserving a safe return destination. */
export function accountPath(next?: string | null): string {
  return isSafeReturnPath(next)
    ? `${ACCOUNT_PATH}?next=${encodeURIComponent(next)}`
    : ACCOUNT_PATH;
}

/**
 * A post-authentication return destination is accepted ONLY when it is a
 * single-slash, app-owned path: '/item/...' (or '/'). '//evil.example',
 * 'https://evil.example', 'javascript:...' and every other absolute/off-site
 * form are rejected, and so is any path that is not a read-only public page.
 */
export function isSafeReturnPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  const pathname = value.split(/[?#]/)[0];
  if (pathname === '/') return true;
  return SAFE_RETURN_PATH.test(pathname);
}

/**
 * Parses a browser location into the route it represents. Anything that is not
 * a known public path resolves to `home` (the app's existing fallback), so an
 * unknown URL can never leave the visitor on a blank screen.
 */
export function parsePublicRoute(pathname: string, search = ''): PublicRoute {
  const path = normalizePath(pathname);

  const itemMatch = ITEM_PATH.exec(path);
  if (itemMatch) {
    let itemId = itemMatch[1];
    try {
      itemId = decodeURIComponent(itemId);
    } catch {
      // Malformed percent-encoding: keep the raw segment. The public item API
      // answers 404 for anything it cannot resolve, which the page renders as
      // its "not found" state — never as a crash or a blank screen.
    }
    return { kind: 'item', itemId };
  }

  const lower = path.toLowerCase();
  if (lower === ACCOUNT_PATH) {
    let next: string | null = null;
    try {
      const raw = new URLSearchParams(search || '').get('next');
      if (isSafeReturnPath(raw)) next = raw;
    } catch {
      next = null;
    }
    return { kind: 'account', next };
  }
  if (lower === CONSOLE_PATH) return { kind: 'console' };
  if (lower === AGENT_PATH) return { kind: 'agent' };
  if (lower === REPORT_LOST_PATH) return { kind: 'reportLost' };

  const publicView = VIEW_PATHS.find((entry) => entry.path === lower);
  if (publicView) return { kind: 'view', view: publicView.view };

  return { kind: 'home' };
}

/**
 * LEGACY COMPATIBILITY: social.ts publishes `https://return4me.co.ke/?claim=<itemId>`.
 * Those links are already out in the world, so they must keep working. This
 * returns the item id only for the homepage form of that link; the caller
 * translates it to the canonical /item/<id> URL.
 */
export function legacyClaimItemId(pathname: string, search: string): string | null {
  if (normalizePath(pathname) !== '/') return null;
  try {
    const raw = new URLSearchParams(search || '').get('claim');
    const trimmed = (raw || '').trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * The view a route forces, when it forces one. `home`, `item`, `account` and
 * `reportLost` do not force a view: the first is the existing state-driven
 * shell, and the other three render their own surfaces (see App.tsx). Nothing
 * about /report-lost may therefore be summonable by restoring a `currentView`
 * from history state.
 */
export function viewForRoute(route: PublicRoute): PublicViewName | null {
  if (route.kind === 'console') return 'admin';
  if (route.kind === 'agent') return 'agent';
  if (route.kind === 'view') return route.view;
  return null;
}

/**
 * Canonical public path for a state-driven view. Used by App.tsx on every
 * navigation, so clicking "I Lost Something" in the navbar leaves the browser
 * on /lost instead of silently staying on '/' — which is what makes those
 * screens linkable, bookmarkable and refresh-safe.
 *
 * Views with no dedicated path (`home`, `privacy`, `terms`, `admin`) keep '/';
 * the admin console is reached through /console, but that route is entered
 * deliberately (see applyRoute), never by a navbar click that would overwrite a
 * more specific URL the admin was already on.
 */
export function pathForView(view: PublicViewName): string {
  if (view === 'agent') return AGENT_PATH;
  const entry = VIEW_PATHS.find((candidate) => candidate.view === view);
  return entry ? entry.path : '/';
}

/**
 * Whether a history entry's remembered view may be restored on popstate.
 * Restricted to the state-driven public screens: restoring 'admin' or 'agent'
 * from history state would let a crafted history entry summon an
 * authentication-gated surface, which is exactly the kind of "hidden React
 * state as a security control" this phase is removing.
 */
export function isRestorableView(value: unknown): value is PublicViewName {
  return typeof value === 'string' && (RESTORABLE_VIEWS as ReadonlyArray<string>).includes(value);
}
