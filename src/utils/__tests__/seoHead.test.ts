import { describe, it, expect } from 'vitest';
import {
  SITE_ORIGIN,
  INDEX_ROBOTS_DIRECTIVE,
  NOINDEX_ROBOTS_DIRECTIVE,
  safeCanonicalPath,
  canonicalUrlFor,
  applySeoHead,
  notFoundDocument,
} from '../seoHead';

// ===========================================================================
// BATCH 1 / P2 — THE SEO HEAD TRANSFORMATION, PURE.
//
// applySeoHead() is the only code in the repository that rewrites the document
// the server sends, so every failure mode it must refuse is pinned here: an
// off-site or query-bearing canonical, a template whose markers are missing, and
// a plan whose path is not safe. The runtime half of the batch (the production
// Express path) is covered by src/__tests__/seoPageIntegrationP2.test.ts.
// ===========================================================================

/** A stand-in for the built dist/index.html, with the real head markers. */
const TEMPLATE = `<!doctype html>
<html lang="en" data-theme="light">
  <head>
    <meta charset="UTF-8" />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="https://return4me.co.ke/" />
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

/** Delete a whole line by pattern, whichever line ending this file uses. */
const removeLine = (html: string, pattern: RegExp): string => html.replace(pattern, '');
const NO_CANONICAL = /[\t ]*<link rel="canonical"[^>]*>[\t ]*\r?\n/;
const NO_ROBOTS_META = /[\t ]*<meta name="robots"[^>]*>[\t ]*\r?\n/;

describe('P2 seoHead: the origin and the directives', () => {
  it('publishes exactly the origin index.html, robots.txt and sitemap.xml use', () => {
    expect(SITE_ORIGIN).toBe('https://return4me.co.ke');
    // No trailing slash: a canonical is origin + path, and the homepage is
    // origin + '/'.
    expect(SITE_ORIGIN.endsWith('/')).toBe(false);
  });

  it('uses the two directives the head and the X-Robots-Tag header share', () => {
    expect(INDEX_ROBOTS_DIRECTIVE).toBe('index, follow');
    expect(NOINDEX_ROBOTS_DIRECTIVE).toBe('noindex, nofollow');
  });
});

describe('P2 seoHead: safeCanonicalPath / canonicalUrlFor', () => {
  it('accepts an origin-relative path and builds the absolute canonical', () => {
    expect(safeCanonicalPath('/lost')).toBe('/lost');
    expect(canonicalUrlFor('/')).toBe('https://return4me.co.ke/');
    expect(canonicalUrlFor('/lost')).toBe('https://return4me.co.ke/lost');
    expect(canonicalUrlFor('/item/R4M-123ABC')).toBe('https://return4me.co.ke/item/R4M-123ABC');
    // A percent-encoded item id is a legitimate, printable path.
    expect(canonicalUrlFor('/item/R4M%2D123ABC')).toBe('https://return4me.co.ke/item/R4M%2D123ABC');
  });

  it('refuses a query string, a fragment, an off-site URL and a protocol-relative path', () => {
    // Each of these would put something other than an app-owned page path into a
    // canonical — a credential in the first case, another host in the next two.
    expect(canonicalUrlFor('/activate-email?token=SECRET')).toBeNull();
    expect(canonicalUrlFor('/lost#track')).toBeNull();
    expect(canonicalUrlFor('https://evil.example/lost')).toBeNull();
    expect(canonicalUrlFor('//evil.example/lost')).toBeNull();
    expect(canonicalUrlFor('lost')).toBeNull();
    expect(canonicalUrlFor('/lost\\..\\..\\evil')).toBeNull();
    expect(canonicalUrlFor('/lost page')).toBeNull();
    expect(canonicalUrlFor('')).toBeNull();
    expect(canonicalUrlFor(undefined as unknown as string)).toBeNull();
    expect(canonicalUrlFor(42 as unknown as string)).toBeNull();
  });
});

describe('P2 seoHead: applySeoHead writes the plan into an in-memory document', () => {
  it('sets the canonical path and keeps index,follow for an indexable page', () => {
    const result = applySeoHead(TEMPLATE, { canonicalPath: '/lost', noindex: false });
    expect(result.headMarkersRecognised).toBe(true);
    expect(result.html).toContain('<link rel="canonical" href="https://return4me.co.ke/lost" />');
    expect(result.html).toContain('<meta name="robots" content="index, follow" />');
    // The rest of the document is untouched.
    expect(result.html).toContain('<div id="root"></div>');
    expect(result.html).toContain('<meta charset="UTF-8" />');
  });

  it('sets noindex,nofollow for a private page while keeping its own canonical', () => {
    const result = applySeoHead(TEMPLATE, { canonicalPath: '/account', noindex: true });
    expect(result.headMarkersRecognised).toBe(true);
    expect(result.html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(result.html).toContain('<link rel="canonical" href="https://return4me.co.ke/account" />');
    // The homepage's index,follow must not survive anywhere in the document.
    expect(result.html).not.toContain('index, follow');
  });

  it('never writes a query string into the canonical', () => {
    const result = applySeoHead(TEMPLATE, { canonicalPath: '/lost', noindex: false });
    expect(result.html).toContain('href="https://return4me.co.ke/lost"');
    expect(result.html).not.toContain('?');
  });

  it('is a pure transformation: the input document is not modified', () => {
    applySeoHead(TEMPLATE, { canonicalPath: '/account', noindex: true });
    // The module holds no state, so the same input still yields the same output.
    expect(TEMPLATE).toContain('<meta name="robots" content="index, follow" />');
    const again = applySeoHead(TEMPLATE, { canonicalPath: '/account', noindex: true });
    expect(again.html).toContain('<link rel="canonical" href="https://return4me.co.ke/account" />');
  });

  it('recognises the markers regardless of attribute order', () => {
    const reversed = '<html><head><meta content="index, follow" name="robots"><link href="/" rel="canonical"></head><body></body></html>';
    const result = applySeoHead(reversed, { canonicalPath: '/found', noindex: true });
    expect(result.headMarkersRecognised).toBe(true);
    expect(result.html).toContain('content="noindex, nofollow"');
    expect(result.html).toContain('href="https://return4me.co.ke/found"');
  });
});

describe('P2 seoHead: fail-closed handling', () => {
  it('serves noindex with NO canonical when the canonical marker is absent', () => {
    const result = applySeoHead(removeLine(TEMPLATE, NO_CANONICAL), { canonicalPath: '/lost', noindex: false });
    expect(result.headMarkersRecognised).toBe(false);
    // The point of failing closed: not indexable, and no canonical nobody could
    // verify.
    expect(result.html).toContain('content="noindex, nofollow"');
    expect(result.html).not.toContain('rel="canonical"');
    expect(result.html).not.toContain('index, follow');
  });

  it('inserts a robots noindex tag when the template has no robots meta at all', () => {
    const result = applySeoHead(removeLine(TEMPLATE, NO_ROBOTS_META), { canonicalPath: '/lost', noindex: false });
    expect(result.headMarkersRecognised).toBe(false);
    expect(result.html).toContain('<meta name="robots" content="noindex, nofollow" />');
    // Inserted inside the head, not after the document.
    expect(result.html.indexOf('noindex, nofollow')).toBeLessThan(result.html.indexOf('</head>'));
    // The unverifiable canonical is removed rather than published.
    expect(result.html).not.toContain('rel="canonical"');
  });

  it('fails closed on a bare document with no head markers and no <head>', () => {
    const result = applySeoHead('<html><body>shell</body></html>', { canonicalPath: '/lost', noindex: false });
    expect(result.headMarkersRecognised).toBe(false);
    expect(result.html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(result.html).not.toContain('canonical');
  });

  it('refuses to publish an unsafe plan path and exposes no secret', () => {
    const result = applySeoHead(TEMPLATE, { canonicalPath: '/activate-email?token=SECRET-VALUE', noindex: true });
    expect(result.headMarkersRecognised).toBe(false);
    expect(result.html).not.toContain('SECRET-VALUE');
    expect(result.html).not.toContain('rel="canonical"');
    expect(result.html).toContain('content="noindex, nofollow"');
  });

  it('handles an empty document without inventing a canonical', () => {
    const result = applySeoHead('', { canonicalPath: '/lost', noindex: false });
    expect(result.headMarkersRecognised).toBe(false);
    expect(result.html).toBe('');
  });
});

describe('P2 seoHead: notFoundDocument', () => {
  it('is noindex and carries no canonical at all', () => {
    const html = notFoundDocument();
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(html).not.toContain('rel="canonical"');
    expect(html.toLowerCase()).toContain('<!doctype html>');
  });

  it('is static: it cannot reflect a requested path, query or token', () => {
    // A parameterless function is the strongest available statement that no
    // request value can reach this document.
    expect(notFoundDocument.length).toBe(0);
    expect(notFoundDocument()).toBe(notFoundDocument());
  });

  it('is not the SPA shell', () => {
    expect(notFoundDocument()).not.toContain('id="root"');
    expect(notFoundDocument()).not.toContain('return4me.co.ke');
  });
});
