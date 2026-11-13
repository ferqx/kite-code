import { expect, test } from '#kite-test';
import { parseRobots, robotsAllows } from '../../../src/tools/web-fetch/robots';

test('robots merges matching agent groups and uses the wildcard only as a fallback', () => {
  const rules = parseRobots(`
    Disallow: /orphan
    User-agent: *
    Disallow: /

    User-agent: OtherBot
    User-agent: KiteCode
    Disallow: /one
    Sitemap: https://fixture.test/sitemap.xml
    Disallow: /two

    User-agent: KITECODE
    Allow: /one/public
    Disallow: /three
    Disallow:

    User-agent: Unrelated
    Disallow: /unrelated
  `);
  for (const path of ['/orphan', '/', '/one/public', '/unrelated'])
    expect(robotsAllows(rules, new URL(path, 'https://fixture.test'))).toBe(true);
  for (const path of ['/one', '/two', '/three'])
    expect(robotsAllows(rules, new URL(path, 'https://fixture.test'))).toBe(false);
  const fallback = parseRobots(
    'User-agent: OtherBot\nDisallow: /elsewhere\nUser-agent: *\nDisallow: /',
  );
  expect(robotsAllows(fallback, new URL('https://fixture.test/'))).toBe(false);
});

test('robots matches specificity, query, wildcards, anchors and normalized URL octets', () => {
  const rules = parseRobots(`
    User-agent: *
    Disallow: /files/*/internal$
    Disallow: /search?token=
    Disallow: /same
    Allow: /same
    Disallow: /caf%C3%A9
    Disallow: /中文
    Disallow: /some%2fpath
    Disallow: /ab%63
    Disallow: /a%2Ab
    Disallow: /cost%24$
    Disallow: /price$usd$
    Disallow: /search?literal=%2A%24$
    Disallow: /*.pdf$
    Disallow: /only$
  `);
  for (const path of [
    '/files/a/b/internal',
    '/files//internal#fragment',
    '/search?token=secret',
    '/café',
    '/中文',
    '/some%2Fpath',
    '/abc',
    '/a%2ab',
    '/a*b',
    '/cost$',
    '/cost%24',
    '/price$usd',
    '/price%24usd',
    '/search?literal=*$',
    '/search?literal=%2a%24',
    '/docs/manual.pdf',
    '/only#fragment',
  ])
    expect(robotsAllows(rules, new URL(path, 'https://fixture.test'))).toBe(false);
  for (const path of [
    '/files/a/internal/extra',
    '/files/internal',
    '/files/a/internal?x=1',
    '/search?query=allowed',
    '/same',
    '/some/path',
    '/abC',
    '/axxb',
    '/cost$more',
    '/price$usd-more',
    '/priceXusd',
    '/search?literal=*$&other=1',
    '/docs/manual.pdf?download=1',
    '/only?',
  ])
    expect(robotsAllows(rules, new URL(path, 'https://fixture.test'))).toBe(true);
});
