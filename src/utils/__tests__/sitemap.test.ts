import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SITE_ORIGIN } from '../seoHead';
import { INDEXABLE_PAGE_PATHS } from '../publicRoutes';
import { buildSitemapXml, SITEMAP_PATHS, SITEMAP_URLS } from '../sitemap';

describe('sitemap.xml', () => {
  const file = fs.readFileSync(path.join(process.cwd(), 'public', 'sitemap.xml'), 'utf8');
  const locs = [...file.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

  it('starts as XML with the sitemap namespace', () => {
    expect(file.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(file).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
  });

  it('contains only unique absolute HTTPS URLs on the canonical origin', () => {
    expect(locs.length).toBeGreaterThan(0);
    expect(new Set(locs).size).toBe(locs.length);
    for (const loc of locs) {
      expect(loc.startsWith('https://')).toBe(true);
      expect(loc.startsWith(SITE_ORIGIN)).toBe(true);
      expect(loc).not.toMatch(/[?#]/);
    }
  });

  it('matches the verified public indexable route inventory', () => {
    const expected = INDEXABLE_PAGE_PATHS.map((p) => SITE_ORIGIN + (p === '/' ? '/' : p));
    expect(locs.slice().sort()).toEqual(expected.slice().sort());
    expect(SITEMAP_PATHS).toEqual(Array.from(new Set(INDEXABLE_PAGE_PATHS)));
    expect(SITEMAP_URLS).toEqual(SITEMAP_PATHS.map((p) => SITE_ORIGIN + (p === '/' ? '/' : p)));
  });

  it('excludes private, authenticated, activation and admin routes', () => {
    for (const forbidden of ['/console', '/agent_portal', '/account', '/activate-email', '/activate-agent-email', '/api']) {
      expect(file).not.toContain(forbidden);
    }
  });

  it('is reproduced exactly by buildSitemapXml()', () => {
    expect(buildSitemapXml()).toBe(file);
  });
});

describe('robots.txt', () => {
  const file = fs.readFileSync(path.join(process.cwd(), 'public', 'robots.txt'), 'utf8');
  it('references the canonical sitemap URL exactly once', () => {
    const matches = file.match(/Sitemap: https:\/\/return4me\.co\.ke\/sitemap\.xml/g) || [];
    expect(matches.length).toBe(1);
  });
  it('allows crawling and has valid basic syntax', () => {
    expect(file).toContain('User-agent: *');
    expect(file).toContain('Allow: /');
  });
});