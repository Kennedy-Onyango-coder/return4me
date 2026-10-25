/**
 * SITEMAP SOURCE OF TRUTH
 * =======================
 * The sitemap is generated from the SAME inventory that decides which pages are
 * indexable (`INDEXABLE_PAGE_PATHS`), so a route cannot be added to the planner
 * and silently left out of the sitemap (or vice versa).
 *
 * Only public, unauthenticated pages belong here. Private, authenticated,
 * activation and item-detail pages are deliberately excluded: they are served
 * `noindex, nofollow` and must never be advertised as crawlable URLs.
 *
 * `public/sitemap.xml` is the checked-in artifact consumed by crawlers;
 * `buildSitemapXml()` reproduces it byte-for-byte and the test suite asserts
 * that the two stay in sync.
 */
import { INDEXABLE_PAGE_PATHS } from './publicRoutes';
import { SITE_ORIGIN } from './seoHead';

/** Public paths that belong in the sitemap, in planner order, without duplicates. */
export const SITEMAP_PATHS: ReadonlyArray<string> = Array.from(new Set(INDEXABLE_PAGE_PATHS));

/** Absolute canonical URL for one public path. */
export function sitemapUrlFor(path: string): string {
  return SITE_ORIGIN + (path === '/' ? '/' : path);
}

/** Absolute canonical URLs advertised by the sitemap. */
export const SITEMAP_URLS: ReadonlyArray<string> = SITEMAP_PATHS.map(sitemapUrlFor);

/** Escape a value for XML text content. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build the complete sitemap document. No `lastmod`, `changefreq` or `priority`
 * is emitted: this project has no trustworthy per-page content date, and a
 * fabricated date is worse than none.
 */
export function buildSitemapXml(): string {
  const entries = SITEMAP_URLS.map((url) => `  <url>\n    <loc>${escapeXml(url)}</loc>\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}