import { describe, it, expect } from 'vitest';
import { INDEXABLE_PAGE_PATHS } from '../publicRoutes';
import { PAGE_METADATA, metadataForPath } from '../seoMetadata';
import { applySeoHead } from '../seoHead';

const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <title>Return4me | Kenya's Trusted Lost & Found Platform</title>
    <meta name="description" content="Old description with Kenya's apostrophe." />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="https://return4me.co.ke/" />
    <meta property="og:title" content="Old title" />
    <meta property="og:description" content="Old social description." />
    <meta property="og:url" content="https://return4me.co.ke/" />
    <meta property="og:image" content="https://return4me.co.ke/old.jpg" />
    <meta name="twitter:title" content="Old title" />
    <meta name="twitter:description" content="Old social description." />
    <meta name="twitter:image" content="https://return4me.co.ke/old.jpg" />
  </head>
  <body><div id="root"></div></body>
</html>
`;

describe('route metadata', () => {
  it('covers every indexable public route', () => {
    for (const path of INDEXABLE_PAGE_PATHS) {
      expect(PAGE_METADATA[path], path).toBeDefined();
      expect(PAGE_METADATA[path].title.length).toBeGreaterThan(0);
      expect(PAGE_METADATA[path].description.length).toBeGreaterThan(0);
    }
  });

  it('collapses an item detail path onto the item metadata entry', () => {
    expect(metadataForPath('/item/R4M-123ABC')).toBe(PAGE_METADATA['/item']);
  });

  it('returns undefined for an unknown path', () => {
    expect(metadataForPath('/not-a-real-page')).toBeUndefined();
  });
});

describe('applying route metadata', () => {
  it('replaces the title, description, Open Graph and Twitter tags', () => {
    const metadata = metadataForPath('/help')!;
    const result = applySeoHead(TEMPLATE, { canonicalPath: '/help', noindex: false, ...metadata });
    expect(result.headMarkersRecognised).toBe(true);
    expect(result.html).toContain(`<title>${metadata.title}</title>`);
    expect(result.html).toContain(`content="${metadata.description}"`);
    expect(result.html).toContain('content="https://return4me.co.ke/help"');
    expect(result.html).toContain(`property="og:title" content="${metadata.title}"`);
    expect(result.html).toContain(`name="twitter:title" content="${metadata.title}"`);
    expect(result.html).not.toContain('Old description');
    expect(result.html).not.toContain('Old social description');
    expect(result.html).not.toContain('https://return4me.co.ke/old.jpg');
  });

  it('keeps a noindex plan noindex while still writing its own title', () => {
    const metadata = metadataForPath('/account')!;
    const result = applySeoHead(TEMPLATE, { canonicalPath: '/account', noindex: true, ...metadata });
    expect(result.headMarkersRecognised).toBe(true);
    expect(result.html).toContain('content="noindex, nofollow"');
    expect(result.html).toContain(`<title>${metadata.title}</title>`);
    expect(result.html).toContain('href="https://return4me.co.ke/account"');
  });
});
