import { describe, it, expect } from 'vitest';
import {
  parsePublicRoute,
  itemPath,
  accountPath,
  isSafeReturnPath,
  legacyClaimItemId,
  viewForRoute,
  isRestorableView,
  normalizePath,
  pathForView,
  planPageRequest,
  INDEXABLE_PAGE_PATHS,
  NOINDEX_PAGE_PATHS,
  TOKEN_BEARING_PAGE_PATHS,
  ITEM_ID_PATTERN,
} from '../publicRoutes';

// Phase 7B routing foundation. Pure-function coverage for every supported
// public path, the legacy ?claim= translation, and — most importantly — the
// return-destination validator that stands between "sign in, then continue
// where you were" and an open redirect.

describe('parsePublicRoute: the supported public surface', () => {
  it('/ is home', () => {
    expect(parsePublicRoute('/')).toEqual({ kind: 'home' });
    expect(parsePublicRoute('')).toEqual({ kind: 'home' });
  });

  it('/item/:id resolves to the public item route with the real id', () => {
    expect(parsePublicRoute('/item/R4M-123ABC')).toEqual({ kind: 'item', itemId: 'R4M-123ABC' });
    // Trailing slash and percent-encoding are both tolerated.
    expect(parsePublicRoute('/item/R4M-123ABC/')).toEqual({ kind: 'item', itemId: 'R4M-123ABC' });
    expect(parsePublicRoute('/item/R4M%2D123ABC')).toEqual({ kind: 'item', itemId: 'R4M-123ABC' });
  });

  it('an item id is never silently coerced — an unknown id still reaches the item page, which renders its own not-found state', () => {
    expect(parsePublicRoute('/item/does-not-exist')).toEqual({ kind: 'item', itemId: 'does-not-exist' });
    // Malformed percent-encoding must not throw; the raw segment is used.
    expect(parsePublicRoute('/item/%ZZ')).toEqual({ kind: 'item', itemId: '%ZZ' });
  });

  it('/account resolves to the account surface, with no return destination by default', () => {
    expect(parsePublicRoute('/account')).toEqual({ kind: 'account', next: null });
    expect(parsePublicRoute('/account/')).toEqual({ kind: 'account', next: null });
  });

  it('/account?next=/item/<id> preserves the destination the visitor came from', () => {
    expect(parsePublicRoute('/account', '?next=%2Fitem%2FR4M-123ABC')).toEqual({
      kind: 'account',
      next: '/item/R4M-123ABC',
    });
  });

  it('an unsafe or off-site ?next is discarded, not trusted', () => {
    for (const evil of [
      '//evil.example/item/R4M-1',
      'https://evil.example/steal',
      'javascript:alert(1)',
      '/console',
      '/account',
      '/item/../../etc/passwd',
      '/item/x/y',
    ]) {
      const route = parsePublicRoute('/account', `?next=${encodeURIComponent(evil)}`);
      expect(route, `next=${evil}`).toEqual({ kind: 'account', next: null });
    }
  });

  it('/console and /agent_portal are recognised (and preserved)', () => {
    expect(parsePublicRoute('/console')).toEqual({ kind: 'console' });
    expect(parsePublicRoute('/agent_portal')).toEqual({ kind: 'agent' });
  });

  it('an unknown public path falls back to home rather than a blank screen', () => {
    expect(parsePublicRoute('/nope')).toEqual({ kind: 'home' });
    expect(parsePublicRoute('/item')).toEqual({ kind: 'home' });
  });
});

describe('path builders', () => {
  it('itemPath builds a shareable, encoded path', () => {
    expect(itemPath('R4M-123ABC')).toBe('/item/R4M-123ABC');
    expect(itemPath(' a b ')).toBe('/item/a%20b');
  });

  it('accountPath only carries a validated destination', () => {
    expect(accountPath('/item/R4M-123ABC')).toBe('/account?next=%2Fitem%2FR4M-123ABC');
    expect(accountPath('//evil.example')).toBe('/account');
    expect(accountPath(null)).toBe('/account');
    expect(accountPath(undefined)).toBe('/account');
  });
});

describe('isSafeReturnPath (open-redirect guard)', () => {
  it('accepts internal item paths only', () => {
    expect(isSafeReturnPath('/item/R4M-123ABC')).toBe(true);
    expect(isSafeReturnPath('/')).toBe(true);
  });

  it('rejects every off-site / privileged form', () => {
    expect(isSafeReturnPath('//evil.example')).toBe(false);
    expect(isSafeReturnPath('https://evil.example')).toBe(false);
    expect(isSafeReturnPath('javascript:alert(1)')).toBe(false);
    expect(isSafeReturnPath('item/R4M-1')).toBe(false);
    expect(isSafeReturnPath('/console')).toBe(false);
    expect(isSafeReturnPath('/account?next=/item/x')).toBe(false);
    expect(isSafeReturnPath('')).toBe(false);
    expect(isSafeReturnPath(null)).toBe(false);
    expect(isSafeReturnPath(42)).toBe(false);
  });
});



describe('legacy ?claim=<itemId> social links', () => {
  it('translates the published social link form to the item id', () => {
    expect(legacyClaimItemId('/', '?claim=R4M-123ABC')).toBe('R4M-123ABC');
    // The real links look like https://return4me.co.ke/?claim=<id>, so the path
    // is always '/'. Anything else is left alone (see the next test).
    expect(legacyClaimItemId('/', '?claim=%20R4M-123ABC%20')).toBe('R4M-123ABC');
  });

  it('ignores the parameter anywhere else, and when empty', () => {
    expect(legacyClaimItemId('/console', '?claim=R4M-123ABC')).toBeNull();
    expect(legacyClaimItemId('/item/R4M-1', '?claim=R4M-123ABC')).toBeNull();
    expect(legacyClaimItemId('/', '?claim=')).toBeNull();
    expect(legacyClaimItemId('/', '')).toBeNull();
  });
});

describe('view restoration', () => {
  it('only the public state-driven screens are restorable', () => {
    expect(isRestorableView('owner')).toBe(true);
    expect(isRestorableView('home')).toBe(true);
    // Authentication-gated / privileged surfaces must never be summonable from
    // a crafted history entry.
    expect(isRestorableView('admin')).toBe(false);
    expect(isRestorableView('agent')).toBe(false);
    expect(isRestorableView('<script>')).toBe(false);
    expect(isRestorableView(null)).toBe(false);
  });

  it('routes that force a view do so explicitly', () => {
    expect(viewForRoute({ kind: 'console' })).toBe('admin');
    expect(viewForRoute({ kind: 'agent' })).toBe('agent');
    expect(viewForRoute({ kind: 'home' })).toBeNull();
    expect(viewForRoute({ kind: 'item', itemId: 'x' })).toBeNull();
    expect(viewForRoute({ kind: 'account', next: null })).toBeNull();
  });

  it('normalizePath trims trailing slashes and prefixes a leading slash', () => {
    expect(normalizePath('owner')).toBe('/owner');
    expect(normalizePath('/item/x//')).toBe('/item/x');
    expect(normalizePath('/')).toBe('/');
  });
});

// ===========================================================================
// BATCH 1 / P1 — the pure SEO page-request planner
// ===========================================================================
// planPageRequest is what lets the server tell a real page from a typo instead
// of answering every extensionless path with the same 200 document. These are
// pure-function tests: no server, no database, no DOM.

/** Plan a URL written as one string, the way a browser shows it. */
const planFor = (url: string) => {
  const queryAt = url.indexOf('?');
  return queryAt === -1 ? planPageRequest(url) : planPageRequest(url.slice(0, queryAt), url.slice(queryAt));
};

describe('planPageRequest: what is indexable, and what never is', () => {
  it('the indexable bucket is exactly the app\'s public destinations', () => {
    // Pinned deliberately: this list is the crawl contract, so growing it must
    // be a visible edit. It is derived from VIEW_PATHS plus the homepage and the
    // lost-report entry point (none of which are private or token-bearing).
    expect([...INDEXABLE_PAGE_PATHS]).toEqual([
      '/',
      '/report-lost',
      '/lost',
      '/found',
      '/become-an-agent',
      '/sign-in',
      '/help',
    ]);
  });

  it('every indexable page plans as an indexable page with its own canonical path', () => {
    for (const path of INDEXABLE_PAGE_PATHS) {
      expect(planPageRequest(path), path).toEqual({ kind: 'page', canonicalPath: path, noindex: false });
    }
  });

  it('the noindex bucket is exactly the private and credential-bearing surfaces', () => {
    expect([...NOINDEX_PAGE_PATHS]).toEqual([
      '/account',
      '/console',
      '/agent_portal',
      '/activate-email',
      '/activate-agent-email',
    ]);
  });

  it('every noindex page resolves as a page (not a redirect) and is marked noindex', () => {
    for (const path of NOINDEX_PAGE_PATHS) {
      expect(planPageRequest(path), path).toEqual({ kind: 'page', canonicalPath: path, noindex: true });
    }
  });

  it('the two buckets are disjoint, so no URL can be both indexable and not', () => {
    const overlap = INDEXABLE_PAGE_PATHS.filter((path) => NOINDEX_PAGE_PATHS.includes(path));
    expect(overlap).toEqual([]);
  });

  it('every addressable public screen the app can link to is classified in exactly one bucket', () => {
    for (const view of ['owner', 'finder', 'becomeAgent', 'signin', 'help'] as const) {
      const path = pathForView(view);
      const buckets = [
        INDEXABLE_PAGE_PATHS.includes(path),
        NOINDEX_PAGE_PATHS.includes(path),
      ].filter(Boolean).length;
      expect(buckets, `${view} -> ${path}`).toBe(1);
    }
  });
});

describe('planPageRequest: token-bearing pages are never redirected', () => {
  it('the token-bearing bucket is a subset of the noindex bucket', () => {
    expect(TOKEN_BEARING_PAGE_PATHS.length).toBeGreaterThan(0);
    for (const path of TOKEN_BEARING_PAGE_PATHS) {
      expect(NOINDEX_PAGE_PATHS, path).toContain(path);
    }
  });

  it('an activation URL stays a noindex page whatever it carries, slash or case included', () => {
    const token = 'a'.repeat(64);
    for (const path of TOKEN_BEARING_PAGE_PATHS) {
      // A redirect would have to either propagate the credential or drop it, so
      // the planner refuses to redirect these at all.
      expect(planFor(`${path}?token=${token}`), path).toEqual({
        kind: 'page',
        canonicalPath: path,
        noindex: true,
      });
      expect(planPageRequest(`${path}/`, `?token=${token}`), `${path}/`).toEqual({
        kind: 'page',
        canonicalPath: path,
        noindex: true,
      });
      expect(planPageRequest(path.toUpperCase(), `?token=${token}`), path).toEqual({
        kind: 'page',
        canonicalPath: path,
        noindex: true,
      });
    }
  });

  it('no plan ever carries a credential into a canonical path or a redirect destination', () => {
    const token = 'f'.repeat(64);
    const probes = [
      '/', '/lost', '/lost/', '/LOST', '/help/', '/account', '/ACCOUNT', '/console/', '/agent_portal/',
      ...TOKEN_BEARING_PAGE_PATHS,
      ...TOKEN_BEARING_PAGE_PATHS.map((path) => `${path}/`),
      '/item/R4M-123ABC', '/item/R4M-123ABC/', '/nope/',
    ];
    for (const path of probes) {
      const plan = planPageRequest(path, `?token=${token}&claim=${token}&next=${token}`);
      expect(JSON.stringify(plan), path).not.toContain(token);
    }
  });
});

describe('planPageRequest: item ids', () => {
  it('a well-formed item id is a noindex page whose id is preserved byte for byte', () => {
    // Batch policy: /item/<id> is noindex until the item-page indexability batch
    // decides real claimability (which needs a database read this planner must
    // not do).
    expect(planPageRequest('/item/R4M-123ABC')).toEqual({
      kind: 'page',
      canonicalPath: '/item/R4M-123ABC',
      noindex: true,
    });
    // Never re-cased, never slugified, never re-encoded.
    expect(planPageRequest('/item/r4m-abc_123')).toEqual({
      kind: 'page',
      canonicalPath: '/item/r4m-abc_123',
      noindex: true,
    });
    const longestAllowed = 'A' + 'b'.repeat(49);
    expect(ITEM_ID_PATTERN.test(longestAllowed)).toBe(true);
    expect(planPageRequest(`/item/${longestAllowed}`)).toEqual({
      kind: 'page',
      canonicalPath: `/item/${longestAllowed}`,
      noindex: true,
    });
  });

  it('an id the shared shape guard refuses is notFound, never a page', () => {
    const badIds = [
      '', '.', '..', '%2F', '%2Fetc%2Fpasswd', '..%2F..%2Fetc%2Fpasswd', 'R4M-1%2F2',
      '-leading-dash', '_leading-underscore', 'a'.repeat(51), '%ZZ', 'R4M%20123ABC', 'R4M-123ABC%20',
    ];
    for (const id of badIds) {
      expect(planPageRequest(`/item/${id}`), `/item/${id}`).toEqual({ kind: 'notFound' });
    }
    // A nested or missing-id path is not an item page either.
    expect(planPageRequest('/item')).toEqual({ kind: 'notFound' });
    expect(planPageRequest('/item/R4M-123ABC/extra')).toEqual({ kind: 'notFound' });
  });

  it('only the route around a valid item id is normalised, never the id', () => {
    expect(planPageRequest('/item/R4M-123ABC/')).toEqual({
      kind: 'redirect',
      status: 301,
      location: '/item/R4M-123ABC',
    });
    expect(planPageRequest('/ITEM/R4M-123ABC')).toEqual({
      kind: 'redirect',
      status: 301,
      location: '/item/R4M-123ABC',
    });
    // An invalid id is never normalised into a valid one.
    expect(planPageRequest('/ITEM/../etc')).toEqual({ kind: 'notFound' });
  });
});

describe('planPageRequest: the legacy ?claim= social link', () => {
  it('a valid legacy claim id redirects to the canonical item path', () => {
    expect(planFor('/?claim=R4M-123ABC')).toEqual({
      kind: 'redirect',
      status: 301,
      location: '/item/R4M-123ABC',
    });
    // The published links are URL-encoded and may carry whitespace; the existing
    // legacyClaimItemId() trims, and the id is re-validated before it is used.
    expect(planFor('/?claim=%20R4M-123ABC%20')).toEqual({
      kind: 'redirect',
      status: 301,
      location: '/item/R4M-123ABC',
    });
  });

  it('extra query parameters are dropped, and the first claim value wins', () => {
    expect(planFor('/?utm_source=x&claim=R4M-123ABC&claim=R4M-999')).toEqual({
      kind: 'redirect',
      status: 301,
      location: '/item/R4M-123ABC',
    });
  });

  it('a malformed claim value never redirects — the visitor stays on the homepage', () => {
    const badValues = [
      '', '   ', 'not an id', '-nope', 'a'.repeat(51), '../../etc/passwd', '%2Fetc%2Fpasswd',
      'https://evil.example', '//evil.example', 'javascript:alert(1)', 'R4M-123ABC%2F..', '<script>',
    ];
    for (const value of badValues) {
      expect(planFor(`/?claim=${encodeURIComponent(value)}`), value).toEqual({
        kind: 'page',
        canonicalPath: '/',
        noindex: false,
      });
    }
    // No claim parameter at all, and the parameter on any other path, are simply
    // the page they already are.
    expect(planPageRequest('/')).toEqual({ kind: 'page', canonicalPath: '/', noindex: false });
    expect(planFor('/lost?claim=R4M-123ABC')).toEqual({
      kind: 'page',
      canonicalPath: '/lost',
      noindex: false,
    });
  });
});

describe('planPageRequest: notFound, and normalisation that is limited to known routes', () => {
  it('unknown, nested, non-page and malformed paths are notFound — never a redirect', () => {
    const unknown = [
      '/nope', '/nope/', '/lostt', '/lost/report', '/console/items', '/item', '/item/',
      '/api/items/search', '/API/items/search', '/api/ipn', '/src/main.tsx', '/src/',
      '/robots.txt', '/sitemap.xml', '/manifest.json', '/assets/index-abc.js',
      'lost', '', 'https://evil.example/', '//evil.example', 'javascript:alert(1)',
      '/lost?track=1', '/lost#frag', '/item/R4M-123ABC/etc',
    ];
    for (const path of unknown) {
      expect(planPageRequest(path), JSON.stringify(path)).toEqual({ kind: 'notFound' });
      expect(planPageRequest(path, '?claim=R4M-123ABC'), JSON.stringify(path)).toEqual({ kind: 'notFound' });
    }
  });

  it('a trailing slash or different case on a KNOWN path redirects to the canonical path', () => {
    expect(planPageRequest('/lost/')).toEqual({ kind: 'redirect', status: 301, location: '/lost' });
    expect(planPageRequest('/lost//')).toEqual({ kind: 'redirect', status: 301, location: '/lost' });
    expect(planPageRequest('/LOST')).toEqual({ kind: 'redirect', status: 301, location: '/lost' });
    expect(planPageRequest('/Help/')).toEqual({ kind: 'redirect', status: 301, location: '/help' });
    expect(planPageRequest('/console/')).toEqual({ kind: 'redirect', status: 301, location: '/console' });
    // ...but an unknown path is never "normalised" into something that exists.
    expect(planPageRequest('/lostt/')).toEqual({ kind: 'notFound' });
    expect(planPageRequest('/NOPE')).toEqual({ kind: 'notFound' });
  });

  it('a normalisation redirect preserves only the two documented, non-sensitive intents', () => {
    expect(planPageRequest('/lost/', '?track=1')).toEqual({
      kind: 'redirect',
      status: 301,
      location: '/lost?track=1',
    });
    // Anything else — a different value, a tracking parameter — is dropped.
    expect(planPageRequest('/lost/', '?track=0&utm_source=x')).toEqual({
      kind: 'redirect',
      status: 301,
      location: '/lost',
    });
    expect(planPageRequest('/ACCOUNT', '?next=%2Fitem%2FR4M-123ABC')).toEqual({
      kind: 'redirect',
      status: 301,
      location: '/account?next=%2Fitem%2FR4M-123ABC',
    });
    // An off-site return destination is discarded rather than carried along.
    expect(planPageRequest('/ACCOUNT', '?next=https%3A%2F%2Fevil.example')).toEqual({
      kind: 'redirect',
      status: 301,
      location: '/account',
    });
  });

  it('a canonical path never carries a query string', () => {
    expect(planPageRequest('/lost', '?track=1')).toEqual({
      kind: 'page',
      canonicalPath: '/lost',
      noindex: false,
    });
    expect(planPageRequest('/account', '?next=%2Fitem%2Fx')).toEqual({
      kind: 'page',
      canonicalPath: '/account',
      noindex: true,
    });
  });

  it('every redirect destination is an origin-free, path-only location', () => {
    const plans = [
      planPageRequest('/LOST'),
      planPageRequest('/lost/'),
      planPageRequest('/help/'),
      planPageRequest('/ITEM/R4M-1'),
      planPageRequest('/item/R4M-1/'),
      planFor('/?claim=R4M-123ABC'),
      planPageRequest('/ACCOUNT', '?next=%2Fitem%2Fx'),
      planPageRequest('/lost/', '?track=1'),
    ];
    for (const plan of plans) {
      expect(plan.kind).toBe('redirect');
      if (plan.kind !== 'redirect') continue;
      expect(plan.location.startsWith('/'), plan.location).toBe(true);
      expect(plan.location.startsWith('//'), plan.location).toBe(false);
      expect(plan.location, plan.location).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
      expect(plan.location, plan.location).not.toMatch(/[\s\\]/);
      expect(plan.status).toBe(301);
    }
  });

  it('planning is deterministic — same input, same plan, no state', () => {
    const inputs: Array<[string, string]> = [
      ['/lost', ''],
      ['/lost/', '?track=1'],
      ['/', '?claim=R4M-123ABC'],
      ['/', '?claim=nope'],
      ['/item/R4M-1', ''],
      ['/item/R4M-1/', ''],
      ['/nope', ''],
      ['/account', '?next=%2Fitem%2Fx'],
    ];
    for (const [path, search] of inputs) {
      const first = planPageRequest(path, search);
      const second = planPageRequest(path, search);
      expect(second, `${path}${search}`).toEqual(first);
      // A plan is exactly one of the three documented kinds.
      expect(['page', 'redirect', 'notFound'], `${path}${search}`).toContain(first.kind);
    }
  });
});
