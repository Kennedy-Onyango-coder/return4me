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
