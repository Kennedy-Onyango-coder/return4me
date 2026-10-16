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
//   /activate-email   N3 customer email-activation landing page. PUBLIC and
//                     unauthenticated: the emailed link must work for someone
//                     who by definition has no session yet. The route records
//                     only whether a token is present, never its value.
//   /found            I Found Something (finder report journey)
//   /become-an-agent  public Agent journey (leads to /agent_portal)
//   /sign-in          the single Sign In chooser (Owner/Claimant vs Agent)
//   /help             public Help & FAQ (Batch 13). It answers the questions the
//                     public copy now depends on — the one-time code arrives by
//                     EMAIL, the phone number only identifies an account, what a
//                     retrieval fee covers, and how to escalate a handover — so
//                     support can hand out a single addressable link.
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

export type PublicViewName = 'home' | 'finder' | 'owner' | 'agent' | 'admin' | 'privacy' | 'terms' | 'help' | 'signin' | 'becomeAgent';

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
  // N3 — the emailed customer activation landing page (/activate-email?token=…).
  //
  // The route carries NO token. It records only whether one was present, and the
  // page reads the token itself from window.location at the moment it needs it.
  // That is deliberate: the credential then never enters the route object, the
  // history state or any component state tree, so it cannot be re-rendered from,
  // restored from history, or serialised anywhere it should not be.
  | { kind: 'activateEmail'; hasToken: boolean }
  // N4 — the emailed AGENT activation landing page (/activate-agent-email?token=…).
  //
  // A SEPARATE route kind from 'activateEmail', not a flag on it. The two pages
  // redeem different credentials against different endpoints and say genuinely
  // different things afterwards (a customer is signed in; an agent is only
  // verified, and may still be awaiting approval), so sharing one kind would
  // mean a boolean threaded through both pages to keep them from lying to the
  // user. Splitting them keeps each page honest by construction.
  //
  // As with the customer route, the token is NEVER carried here — only whether
  // one was present.
  | { kind: 'activateAgentEmail'; hasToken: boolean }
  // A plain, public, unauthenticated screen identified by its own path. These
  // are the state-driven views that also have a real URL, so they can be
  // linked, bookmarked and refreshed like any other page.
  | { kind: 'view'; view: PublicViewName };

const ITEM_PATH_PREFIX = '/item';
const ITEM_PATH = /^\/item\/([^/]+)$/i;

// ITEM IDS — ONE shared shape guard (Batch 1 / P1).
// Moved here verbatim from routes/publicItems.ts, which held the only copy, so
// the server route and the pure SEO planner below can never disagree about what
// a well-formed item id is. Item IDs are drop-off codes ('R4M-' + 3 digits + 3
// alphanumerics — see the report route in server.ts). This is a shape/abuse
// guard, NOT an authorization control: the lookup itself is done by primary key,
// and anything that doesn't resolve is reported as "not publicly available"
// rather than as a distinct error the caller could use to probe for internal
// records.
export const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/;
const ACCOUNT_PATH = '/account';
const CONSOLE_PATH = '/console';
const AGENT_PATH = '/agent_portal';
const LOST_PATH = '/lost';
const FOUND_PATH = '/found';
const REPORT_LOST_PATH = '/report-lost';
// N3 — the path buildCustomerActivationUrl() (services/customerAuth.ts) puts in
// the activation email. Read from source rather than re-invented, so the link
// the backend generates and the page the frontend serves can never drift.
const ACTIVATE_EMAIL_PATH = '/activate-email';
// N4 — the path buildAgentActivationUrl() (services/customerAuth.ts) puts in the
// AGENT activation email. Declared next to the customer path, and asserted
// against that builder's output in the N4 tests, so the link the backend
// generates and the page the frontend serves can never drift apart.
const ACTIVATE_AGENT_EMAIL_PATH = '/activate-agent-email';
const BECOME_AGENT_PATH = '/become-an-agent';
const SIGNIN_PATH = '/sign-in';
// Batch 13 — the public Help & FAQ page. It has its own path for the same
// reason /sign-in does: the answers are worth linking to directly, and a
// visitor who refreshes or follows a shared link must land on them instead of
// being silently bounced to Home.
const HELP_PATH = '/help';

// Path -> view for the addressable, unauthenticated public screens. Every entry
// here must also appear in RESTORABLE_VIEWS below: a path that can be entered
// directly but not restored from history would dead-end on Back.
const VIEW_PATHS: ReadonlyArray<{ path: string; view: PublicViewName }> = [
  { path: LOST_PATH, view: 'owner' },
  { path: FOUND_PATH, view: 'finder' },
  { path: BECOME_AGENT_PATH, view: 'becomeAgent' },
  { path: SIGNIN_PATH, view: 'signin' },
  { path: HELP_PATH, view: 'help' },
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
//
// PHASE 16 adds ONE more literal shape for the same, already-reviewed reason:
//   /lost          — the public "I Lost Something" search/claim journey, which
//                    now hosts the Track My Claim entry point. Tracking is a
//                    customer-authenticated action (see OwnerView + the
//                    /api/claims/lookup route), so a signed-out visitor is sent
//                    through the EXISTING /account boundary and returned here
//                    with an explicit `?track=1` intent. /lost is a fully
//                    public, read-only screen: it renders no claim data at all
//                    until the visitor deliberately submits the lookup form, so
//                    returning to it cannot reveal anything private. The
//                    query is stripped before matching (the pathname is what is
//                    validated), which is why `?track=1` is not part of the
//                    pattern: the intent rides on the validated path, exactly
//                    like the existing /report-lost hand-off.
const SAFE_RETURN_PATH = /^\/(?:item\/[^/]+|report-lost|lost)$/i;

// 'signin' and 'becomeAgent' are public, unauthenticated screens (Phase 8.1),
// so restoring them from history state is safe for the same reason 'home' and
// 'finder' are. 'admin' and 'agent' stay excluded: restoring an
// authentication-gated surface from a crafted history entry is exactly the
// "hidden React state as a security control" this helper exists to prevent.
const RESTORABLE_VIEWS: ReadonlyArray<PublicViewName> = ['home', 'finder', 'owner', 'privacy', 'terms', 'help', 'signin', 'becomeAgent'];

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
 * N3 — the bare /activate-email path. Exported as a builder (not a bare constant
 * the caller concatenates onto) purely so the page and the tests reference one
 * definition, matching itemPath()/accountPath(). The token is appended by the
 * email template in the backend, never here: a builder that took a token would
 * invite a caller to hold the credential in application state.
 */
export function activateEmailPath(): string {
  return ACTIVATE_EMAIL_PATH;
}

/**
 * N4 — the bare /activate-agent-email path, for the same reason as
 * activateEmailPath(): one definition shared by the page and the tests, never
 * hand-concatenated by a caller, and never given a token parameter.
 */
export function activateAgentEmailPath(): string {
  return ACTIVATE_AGENT_EMAIL_PATH;
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

/**
 * PHASE 16 — the public /lost URL that asks the page to open Track My Claim
 * once the visitor is authenticated.
 *
 * WHY AN INTENT PARAMETER AND NOT A NEW ROUTE: §23 of the phase brief forbids a
 * second route system, and /lost already IS the owner/claim journey. The intent
 * is a plain, non-sensitive query flag on the EXISTING public page — it carries
 * no claim id, no phone number and no credential — so it stays safe to put in a
 * URL, safe to bookmark, and safe to survive a refresh. OwnerView reads it
 * through App and simply opens the modal it already owns.
 */
export function lostTrackPath(): string {
  return `${LOST_PATH}?track=1`;
}

/**
 * The canonical /account URL a signed-out visitor is sent through to reach
 * authenticated Track My Claim, remembering the intent to return.
 *
 * Built here (not in a component) so the return destination always goes through
 * isSafeReturnPath — exactly like the /item/:id and /report-lost hand-offs.
 */
export function lostTrackSignInPath(): string {
  return accountPath(lostTrackPath());
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
  if (lower === ACTIVATE_EMAIL_PATH) {
    // Only the PRESENCE of a token is recorded. The value stays in the URL,
    // where the activation page reads it once and discards it — it is never
    // copied into the route object, so it cannot be pushed into history state,
    // re-rendered from, or serialised. A missing/blank token is reported as
    // `hasToken: false` so the page can explain the link is incomplete instead
    // of firing a pointless request.
    let hasToken = false;
    try {
      hasToken = (new URLSearchParams(search || '').get('token') || '').trim().length > 0;
    } catch {
      hasToken = false;
    }
    return { kind: 'activateEmail', hasToken };
  }
  if (lower === ACTIVATE_AGENT_EMAIL_PATH) {
    // Presence only, exactly as above. The value stays in the URL, where the
    // agent activation page reads it once inside the request effect and drops
    // it. Note there is deliberately NO `next`/return-destination support here:
    // this page has no authenticated surface to return to, so there is nothing
    // a redirect parameter could legitimately point at.
    let hasToken = false;
    try {
      hasToken = (new URLSearchParams(search || '').get('token') || '').trim().length > 0;
    } catch {
      hasToken = false;
    }
    return { kind: 'activateAgentEmail', hasToken };
  }

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

// ===========================================================================
// BATCH 1 / P1 — SEO PAGE-REQUEST PLANNER (pure, additive)
// ===========================================================================
// WHY THIS EXISTS
// The SPA catch-all in server.ts answers EVERY extensionless path with the same
// 200 document, so a crawler cannot tell a real public page (/lost) from a typo
// (/lostt): both look like a successfully served page. planPageRequest below is
// the single, pure place that decides what a request path actually IS — a known
// page (indexable or not), a normalisation redirect, a legacy social link, or
// nothing at all — so the server integration can answer with a real status code
// and the head injector can emit one canonical URL plus the right robots
// directive for the page it is serving.
//
// It is deliberately PURE and synchronous: no I/O, no environment reads, no
// database, no server-only or browser-only import. Every branch below is
// executable by a unit test, which is exactly why the crawl rules live here
// instead of being spelled out inside the server's fallback handler.
//
// THE CRAWL RULE THIS ENCODES
//   * reachable, wanted         -> indexable page
//   * reachable, unwanted       -> noindex page (the URL still resolves and the
//                                  page itself tells the crawler to drop it)
//   * not ours to serve at all  -> notFound (the server integration decides
//                                  whether that becomes a 404)
// The indexable and noindex buckets are disjoint by construction, so one URL
// can never be both.
//
// NOT A METHOD DECISION (deliberate)
// There is no HTTP-method parameter: this function answers "what is this URL?",
// never "may this request be redirected?". The server integration MUST apply the
// method rule itself — only GET/HEAD may follow a redirect plan, and /api/*,
// /src/* and static file paths must never reach this planner at all.

/**
 * Public pages the app publishes as destinations and wants crawled: the
 * homepage, the lost-report entry point, and every path in the app's own public
 * destination list (VIEW_PATHS — the unauthenticated screens that have a real,
 * linkable URL).
 *
 * Derived rather than re-listed on purpose: a new public screen added to
 * VIEW_PATHS joins the indexable set automatically, so this bucket cannot drift
 * from the paths the app actually serves.
 *
 * '/sign-in' is in that list and is therefore indexable here: it is a public,
 * unauthenticated destination a visitor legitimately searches for by name. If
 * the owner would rather the sign-in chooser stayed out of search results,
 * moving '/sign-in' into NOINDEX_PAGE_PATHS is a one-line change — the decision
 * is deliberately visible here instead of buried in a <meta> tag.
 */
export const INDEXABLE_PAGE_PATHS: ReadonlyArray<string> = [
  '/',
  REPORT_LOST_PATH,
  ...VIEW_PATHS.map((entry) => entry.path),
];

/**
 * Addressable pages that must never be indexed, because reaching one means the
 * visitor is inside (or entering) a private, privileged or credential-bearing
 * surface:
 *   /account               the authentication boundary and customer surface
 *   /console               the admin console
 *   /agent_portal          the agent workspace
 *   /activate-email        the emailed one-time customer activation link
 *   /activate-agent-email  the emailed one-time agent activation link
 *
 * These are listed explicitly rather than derived because they are NOT in
 * VIEW_PATHS and must not be: the two activation links arrive by email and are
 * never linked from the app.
 *
 * WHY noindex AND NOT A ROBOTS RULE: every one of them is publicly reachable and
 * unauthenticated by design (the activation link has to work for someone who has
 * no session yet), so a robots.txt rule would stop a crawler from ever READING
 * the noindex — and from following a link a real person was sent — while noindex
 * is obeyed on the page itself. Crawl-forbidden is robots.txt's job; this list
 * is for pages that may be crawled but must not be kept.
 */
export const NOINDEX_PAGE_PATHS: ReadonlyArray<string> = [
  ACCOUNT_PATH,
  CONSOLE_PATH,
  AGENT_PATH,
  ACTIVATE_EMAIL_PATH,
  ACTIVATE_AGENT_EMAIL_PATH,
];

/**
 * The subset of NOINDEX_PAGE_PATHS whose URL carries a one-time credential. Its
 * own list because these paths get the strictest treatment in the planner: they
 * are NEVER redirected (a redirect would have to either propagate the credential
 * or drop it) and their canonical path never contains a query string.
 */
export const TOKEN_BEARING_PAGE_PATHS: ReadonlyArray<string> = [
  ACTIVATE_EMAIL_PATH,
  ACTIVATE_AGENT_EMAIL_PATH,
];

/**
 * BATCH POLICY (temporary): found-item detail pages are rendered noindex.
 *
 * /item/<id> is a real, linkable page and will very likely deserve indexing —
 * but whether a given item is publicly claimable is a DATABASE question (status,
 * disputes, flags), and this planner is pure: it must not read the database to
 * answer it. Until a separate item-page indexability batch gives that question
 * its own answer, every well-formed item URL is treated as noindex, which is the
 * fail-closed choice: declining to index a page costs nothing, whereas indexing
 * an item that is no longer claimable advertises a dead end. Flip this ONE
 * constant when that batch lands.
 */
export const ITEM_PAGES_NOINDEX = true;

const NOINDEX_PAGE_PATH_SET: ReadonlySet<string> = new Set(NOINDEX_PAGE_PATHS);
const TOKEN_BEARING_PAGE_PATH_SET: ReadonlySet<string> = new Set(TOKEN_BEARING_PAGE_PATHS);
const KNOWN_PAGE_PATH_SET: ReadonlySet<string> = new Set([...INDEXABLE_PAGE_PATHS, ...NOINDEX_PAGE_PATHS]);

/**
 * What the server should do with a page request. Three outcomes and nothing
 * else — a plan can never be half a page and half a redirect.
 */
export type PageRequestPlan =
  | {
      kind: 'page';
      /**
       * The one canonical, origin-free path for this page, e.g. '/lost'. Never
       * an absolute URL and never a query string: the caller owns the
       * production origin.
       */
      canonicalPath: string;
      /** True when the page must be served with a noindex directive. */
      noindex: boolean;
    }
  | {
      kind: 'redirect';
      /** 301: every destination here is a permanent, single canonical identity. */
      status: 301;
      /**
       * Origin-free, path-only destination. Never absolute, never
       * protocol-relative, and never a raw value lifted straight out of the
       * query string.
       */
      location: string;
    }
  | { kind: 'notFound' };

/** The plan for a known page path, which is always already lowercase. */
function pagePlanFor(path: string): PageRequestPlan {
  return {
    kind: 'page',
    canonicalPath: path,
    // The two buckets are disjoint (asserted by the unit tests), so this is
    // exactly "is this path in the noindex bucket".
    noindex: NOINDEX_PAGE_PATH_SET.has(path),
  };
}

/**
 * The ONLY query parameters allowed to survive a normalisation redirect.
 *
 * Everything else is dropped — tracking parameters included, which is rather the
 * point of a canonical redirect — and these two are REBUILT from validated
 * values instead of being echoed back:
 *   /lost?track=1      the "open Track My Claim" intent read by OwnerView
 *   /account?next=...  the post-sign-in return destination, accepted only when
 *                      isSafeReturnPath() accepts it
 *
 * Both are documented app behaviour (see lostTrackPath() and accountPath()
 * above): a normalisation redirect that dropped them would break a flow the app
 * deliberately built into its URLs, and that is the one case where preserving a
 * parameter is justified. A credential can never ride through here, because the
 * only paths that carry one are token-bearing and are never redirected at all.
 */
function preservedIntentQuery(path: string, search: string): string {
  if (!search) return '';
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return '';
  }
  if (path === ACCOUNT_PATH) {
    const next = params.get('next');
    return isSafeReturnPath(next) ? `?next=${encodeURIComponent(next)}` : '';
  }
  if (path === LOST_PATH) {
    return params.get('track') === '1' ? '?track=1' : '';
  }
  return '';
}

/**
 * The item-detail branch.
 *
 * The id is validated in the form the runtime resolves it to (parsePublicRoute
 * percent-decodes the segment) and against the form the public item API enforces
 * (the shared ITEM_ID_PATTERN), so a URL the app renders as an item page can
 * never be planned as unknown, and an id the API would refuse can never be
 * planned as a page.
 *
 * The id itself is carried out BYTE FOR BYTE: never re-cased, trimmed,
 * slugified or re-encoded. Only the route AROUND it may be normalised — the
 * '/item' prefix and a trailing slash — and a query string is never part of it.
 */
function planItemPage(path: string, rawId: string, hadTrailingSlash: boolean): PageRequestPlan {
  let decodedId = rawId;
  try {
    decodedId = decodeURIComponent(rawId);
  } catch {
    // Malformed percent-encoding: the raw segment is what the page would use,
    // exactly as parsePublicRoute decides. The shape guard below is what rejects
    // it if it is not an item id.
  }

  if (!ITEM_ID_PATTERN.test(decodedId)) return { kind: 'notFound' };

  const canonicalPath = `${ITEM_PATH_PREFIX}/${rawId}`;
  if (hadTrailingSlash || !path.startsWith(`${ITEM_PATH_PREFIX}/`)) {
    return { kind: 'redirect', status: 301, location: canonicalPath };
  }
  return { kind: 'page', canonicalPath, noindex: ITEM_PAGES_NOINDEX };
}

/**
 * Plan the response for a page request: the whole point of Batch 1.
 *
 * `pathname` is a PATH and `search` is the query string (in Express terms,
 * `req.path` plus the query part of `req.url`). A full URL, a value containing
 * '?' or '#', or anything that is not origin-relative is refused rather than
 * guessed at: a planner that silently reinterprets a URL is a redirect risk, not
 * a convenience.
 *
 * Deterministic by construction — same input, same plan, no state, no I/O.
 */
export function planPageRequest(pathname: string, search = ''): PageRequestPlan {
  if (typeof pathname !== 'string' || pathname.length === 0) return { kind: 'notFound' };
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return { kind: 'notFound' };
  if (pathname.includes('?') || pathname.includes('#')) return { kind: 'notFound' };

  // A trailing slash is the one shape the runtime already tolerates
  // (normalizePath strips it), so the planner records that one arrived and
  // answers with a redirect to the same page without it.
  const hadTrailingSlash = pathname.length > 1 && pathname.endsWith('/');
  const stripped = hadTrailingSlash ? pathname.replace(/\/+$/, '') : pathname;
  const path = stripped === '' ? '/' : stripped;

  const itemMatch = ITEM_PATH.exec(path);
  if (itemMatch) return planItemPage(path, itemMatch[1], hadTrailingSlash);

  const lowered = path.toLowerCase();

  if (lowered === '/') {
    // LEGACY SOCIAL LINK — https://return4me.co.ke/?claim=<itemId>. social.ts
    // publishes exactly this form, so those links are already out in the world.
    // Only an id that passes the SAME shape guard the public item API uses is
    // translated, and the destination is built by itemPath() — never a raw query
    // value. Every other value leaves the visitor on the homepage, which is what
    // the app does today, so no malformed or hostile query string can ever turn
    // into a redirect.
    const legacyId = legacyClaimItemId('/', search);
    if (legacyId && ITEM_ID_PATTERN.test(legacyId)) {
      return { kind: 'redirect', status: 301, location: itemPath(legacyId) };
    }
    return pagePlanFor(lowered);
  }

  if (!KNOWN_PAGE_PATH_SET.has(lowered)) return { kind: 'notFound' };

  // A token-bearing page is NEVER redirected. Its URL carries a one-time
  // credential, so a redirect would have to either propagate that credential
  // (this planner never puts one in a Location header) or silently drop it
  // (which breaks the activation the visitor just clicked). It stays the page it
  // already is, always noindex.
  if (TOKEN_BEARING_PAGE_PATH_SET.has(lowered)) return pagePlanFor(lowered);

  if (hadTrailingSlash || path !== lowered) {
    return {
      kind: 'redirect',
      status: 301,
      location: lowered + preservedIntentQuery(lowered, search),
    };
  }

  return pagePlanFor(lowered);
}
