/**
 * SEO HEAD INJECTION (Batch 1 / P2)
 * =================================
 * The ONE place that turns a page plan into the HTML the server actually sends.
 *
 * WHY THIS EXISTS
 * ---------------
 * `public/sitemap.xml` advertises one URL and `index.html` declares one
 * canonical (`https://return4me.co.ke/`) plus `<meta name="robots"
 * content="index, follow">` — and until now the server sent that same document
 * for EVERY extensionless path, including `/console`, `/agent_portal` and
 * `/activate-email?token=...`. A crawler reading those responses is told the
 * private page is indexable and that its canonical is the homepage, which is the
 * exact opposite of what the app means.
 *
 * P1 (`utils/publicRoutes.ts`) already decides what a request path IS. This
 * module is the other half of that decision: it writes the plan into the
 * document's head. It is deliberately PURE, synchronous and dependency-free —
 * it takes an HTML string and returns an HTML string — so it is fully unit
 * testable in this repository's node-only vitest environment, like
 * utils/publicRoutes.ts and utils/safeStaticPath.ts.
 *
 * NOTHING IS WRITTEN TO DISK
 * --------------------------
 * The transformation is applied to an IN-MEMORY string. `index.html` and
 * `dist/index.html` are never written, replaced, or temporarily overwritten, and
 * no build artifact is ever produced by the running server.
 *
 * THE ORIGIN IS A CONSTANT, NEVER THE HOST HEADER
 * ----------------------------------------------
 * The canonical origin is hard-coded below. Deriving it from `req.headers.host`
 * would let any caller choose what the crawler is told the canonical URL is
 * (host-header poisoning), so the request is never consulted: the plan supplies
 * an origin-FREE path and this module supplies the origin.
 *
 * FAIL CLOSED
 * -----------
 * If the built document does not contain the expected robots/canonical markers,
 * no correct canonical can be written. In that case `applySeoHead` removes any
 * canonical it cannot verify, forces `noindex, nofollow` into the head, and
 * reports `headMarkersRecognised: false` so the caller can add the matching
 * `X-Robots-Tag` header. Serving a page that is silently indexed under a
 * canonical nobody verified is the one outcome this module refuses to produce.
 */

/** Matches a `<meta name="robots" ...>` tag, whatever the attribute order. */
const ROBOTS_META_TAG = /<meta\b[^>]*\bname\s*=\s*["']robots["'][^>]*>/i;

/** Matches a `<link rel="canonical" ...>` tag, whatever the attribute order. */
const CANONICAL_LINK_TAG = /<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*>/i;

/** Matches ANY canonical link at all — used only by the fail-closed path. */
const ANY_CANONICAL_LINK_TAG = /<link\b[^>]*\brel\s*=\s*["']?canonical["']?[^>]*>/gi;

/** Matches the content/href attribute inside a tag already matched above. */
const CONTENT_ATTRIBUTE = /\bcontent\s*=\s*(["'])(?:(?!\1)[\s\S])*\1/i;
const HREF_ATTRIBUTE = /\bhref\s*=\s*(["'])(?:(?!\1)[\s\S])*\1/i;

/** Matches the opening `<head>` tag, used to insert a directive when absent. */
const HEAD_OPEN_TAG = /<head\b[^>]*>/i;

/** Matches the document title element. */
const TITLE_TAG = /<title\b[^>]*>[\s\S]*?<\/title>/i;
/** Matches the meta description tag (any attribute order). */
const META_DESCRIPTION_TAG = /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*>/i;
const OG_TITLE_TAG = /<meta\b[^>]*\bproperty\s*=\s*["']og:title["'][^>]*>/i;
const OG_DESCRIPTION_TAG = /<meta\b[^>]*\bproperty\s*=\s*["']og:description["'][^>]*>/i;
const OG_URL_TAG = /<meta\b[^>]*\bproperty\s*=\s*["']og:url["'][^>]*>/i;
const OG_IMAGE_TAG = /<meta\b[^>]*\bproperty\s*=\s*["']og:image["'][^>]*>/i;
const TWITTER_TITLE_TAG = /<meta\b[^>]*\bname\s*=\s*["']twitter:title["'][^>]*>/i;
const TWITTER_DESCRIPTION_TAG = /<meta\b[^>]*\bname\s*=\s*["']twitter:description["'][^>]*>/i;
const TWITTER_IMAGE_TAG = /<meta\b[^>]*\bname\s*=\s*["']twitter:image["'][^>]*>/i;

/**
 * A canonical path the server is willing to publish, or `null`.
 *
 * The P1 planner already guarantees an origin-free, query-free path; this is the
 * second, independent gate in front of the HTML, so a future caller cannot turn
 * a canonical into an absolute URL, an off-site path, a query string (which is
 * where a credential would ride) or anything that would need HTML escaping.
 * Only printable ASCII is accepted — percent-encoded item ids included.
 */
export function safeCanonicalPath(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || candidate === '') return null;
  if (!candidate.startsWith('/')) return null;
  // '//host/path' is protocol-relative: an off-site canonical in disguise.
  if (candidate.startsWith('//')) return null;
  if (candidate.includes('?') || candidate.includes('#')) return null;
  if (candidate.includes('\\')) return null;
  if (!/^\/[\x21-\x7e]*$/.test(candidate)) return null;
  return candidate;
}

/**
 * The absolute canonical URL for a path, or `null` when the path is not safe.
 * The origin is always SITE_ORIGIN — never the request's Host header.
 */
export function canonicalUrlFor(canonicalPath: string): string | null {
  const safePath = safeCanonicalPath(canonicalPath);
  return safePath === null ? null : SITE_ORIGIN + safePath;
}

/**
 * The ONE production origin, as published by index.html, robots.txt and
 * sitemap.xml. Hard-coded on purpose: see "THE ORIGIN IS A CONSTANT" above.
 * There is deliberately no trailing slash, so a canonical is
 * `SITE_ORIGIN + canonicalPath` and the homepage is exactly `SITE_ORIGIN + '/'`.
 */
export const SITE_ORIGIN = 'https://return4me.co.ke';

/** The directive the built index.html already carries for public pages. */
export const INDEX_ROBOTS_DIRECTIVE = 'index, follow';

/** The directive every private, token-bearing or unknown page must carry. */
export const NOINDEX_ROBOTS_DIRECTIVE = 'noindex, nofollow';

/** What the caller must write into the document's head for a page. */
export interface SeoHeadPlan {
  /** Origin-free canonical path, exactly as the P1 planner produced it. */
  canonicalPath: string;
  /** True when the page must be served noindex. */
  noindex: boolean;
  /** Optional route-specific document title. */
  title?: string;
  /** Optional route-specific meta description. */
  description?: string;
  /** Optional route-specific Open Graph / Twitter image URL. */
  ogImage?: string;
}

/** The document to serve, plus whether the markers it needed were found. */
export interface SeoHeadResult {
  html: string;
  /**
   * False when the expected head markers were missing and the document was
   * FAIL-CLOSED (noindex, no canonical). The caller must then answer with
   * `X-Robots-Tag: noindex, nofollow` so the header and the body agree.
   */
  headMarkersRecognised: boolean;
}

/** Replace the content attribute of the document's robots meta tag, or null. */
function replaceRobotsDirective(html: string, directive: string): string | null {
  const found = ROBOTS_META_TAG.exec(html);
  if (!found || !CONTENT_ATTRIBUTE.test(found[0])) return null;
  const tag = found[0].replace(CONTENT_ATTRIBUTE, `content="${directive}"`);
  return html.slice(0, found.index) + tag + html.slice(found.index + found[0].length);
}

/** Replace the href attribute of the document's canonical link, or null. */
function replaceCanonicalHref(html: string, canonicalUrl: string): string | null {
  const found = CANONICAL_LINK_TAG.exec(html);
  if (!found || !HREF_ATTRIBUTE.test(found[0])) return null;
  const tag = found[0].replace(HREF_ATTRIBUTE, `href="${canonicalUrl}"`);
  return html.slice(0, found.index) + tag + html.slice(found.index + found[0].length);
}

/** Escape a value for use inside an HTML attribute or text node. */
function escapeHtml(value: string): string {
  return value
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Replace a matched meta tag's content attribute, or return html unchanged. */
function replaceMetaContent(html: string, tagPattern: RegExp, value: string): string {
  const found = tagPattern.exec(html);
  if (!found || !CONTENT_ATTRIBUTE.test(found[0])) return html;
  const tag = found[0].replace(CONTENT_ATTRIBUTE, `content="${escapeHtml(value)}"`);
  return html.slice(0, found.index) + tag + html.slice(found.index + found[0].length);
}

/** Replace the document title, or return html unchanged when it has none. */
function replaceTitle(html: string, title: string): string {
  const found = TITLE_TAG.exec(html);
  if (!found) return html;
  const tag = `<title>${escapeHtml(title)}</title>`;
  return html.slice(0, found.index) + tag + html.slice(found.index + found[0].length);
}

/**
 * The document to send when the plan could not be written faithfully: every
 * unverifiable canonical link is REMOVED and `noindex, nofollow` is guaranteed
 * to be present, inserting a meta tag if the document has none to replace.
 */
function failClosedDocument(html: string): string {
  const withoutCanonical = html.replace(ANY_CANONICAL_LINK_TAG, '');
  const withRobots = replaceRobotsDirective(withoutCanonical, NOINDEX_ROBOTS_DIRECTIVE);
  if (withRobots !== null) return withRobots;

  const metaTag = `<meta name="robots" content="${NOINDEX_ROBOTS_DIRECTIVE}" />`;
  const headOpen = HEAD_OPEN_TAG.exec(withoutCanonical);
  if (!headOpen) return `${metaTag}\n${withoutCanonical}`;
  const insertAt = headOpen.index + headOpen[0].length;
  return `${withoutCanonical.slice(0, insertAt)}\n    ${metaTag}${withoutCanonical.slice(insertAt)}`;
}

/**
 * Write the plan into an in-memory HTML document and return the result.
 *
 * `headMarkersRecognised: false` means the document did not contain the markers
 * this transformation needs, so the returned HTML is fail-closed (noindex, and
 * no canonical at all) and the caller must send `X-Robots-Tag: noindex, nofollow`
 * to match. The input string is never mutated and nothing is written to disk.
 */
export function applySeoHead(html: string, plan: SeoHeadPlan): SeoHeadResult {
  if (typeof html !== 'string' || html === '') {
    return { html: '', headMarkersRecognised: false };
  }

  const directive = plan && plan.noindex ? NOINDEX_ROBOTS_DIRECTIVE : INDEX_ROBOTS_DIRECTIVE;
  const canonicalUrl = plan ? canonicalUrlFor(plan.canonicalPath) : null;
  if (canonicalUrl === null) {
    return { html: failClosedDocument(html), headMarkersRecognised: false };
  }

  const withRobots = replaceRobotsDirective(html, directive);
  const withCanonical = withRobots === null ? null : replaceCanonicalHref(withRobots, canonicalUrl);
  if (withRobots === null || withCanonical === null) {
    return { html: failClosedDocument(html), headMarkersRecognised: false };
  }

  let result = withCanonical;
  if (plan.title) {
    result = replaceTitle(result, plan.title);
    result = replaceMetaContent(result, OG_TITLE_TAG, plan.title);
    result = replaceMetaContent(result, TWITTER_TITLE_TAG, plan.title);
  }
  if (plan.description) {
    result = replaceMetaContent(result, META_DESCRIPTION_TAG, plan.description);
    result = replaceMetaContent(result, OG_DESCRIPTION_TAG, plan.description);
    result = replaceMetaContent(result, TWITTER_DESCRIPTION_TAG, plan.description);
  }
  if (plan.ogImage) {
    result = replaceMetaContent(result, OG_IMAGE_TAG, plan.ogImage);
    result = replaceMetaContent(result, TWITTER_IMAGE_TAG, plan.ogImage);
  }
  // og:url always mirrors the canonical that this module just verified/wrote.
  result = replaceMetaContent(result, OG_URL_TAG, canonicalUrl);

  return { html: result, headMarkersRecognised: true };
}

/**
 * The minimal 404 document for a path that is not ours to serve.
 *
 * A static string on purpose: the requested path, the query string and any
 * header value are NOT reflected into it, so no request can influence this body
 * (and an activation token in a query string cannot end up in an error page that
 * might be cached, logged or indexed). It carries `noindex, nofollow` so that a
 * crawler that reaches an unknown URL drops it instead of keeping it.
 *
 * A 404 does not need the SPA shell: the shell is a 200 document that declares
 * the homepage's canonical, so serving it for an unknown path is exactly the
 * mistake this batch removes.
 */
export function notFoundDocument(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="${NOINDEX_ROBOTS_DIRECTIVE}" />
    <title>Page not found | Return4me</title>
  </head>
  <body>
    <main>
      <h1>Page not found</h1>
      <p>This page does not exist on Return4me.</p>
      <p><a href="/">Return to the Return4me homepage</a></p>
    </main>
  </body>
</html>
`;
}
