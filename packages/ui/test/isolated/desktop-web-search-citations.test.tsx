import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageContent } from '../../src/desktop/MessageContent';
import { WebSearchSources } from '../../src/desktop/WebSearchSources';
import {
  verifyWebSearchAnchors,
  type WebSearchDisplay,
  webSearchHref,
  webSearchLinks,
} from '../../src/desktop/web-search-citations';

const parts = ['中国🐱。', '查阅**中文**与资料。'];
const text = parts.join(''),
  url = 'https://example.org/source';
const blocks = parts.map((v, i) => ({
  index: i,
  offset: i === 0 ? 0 : parts[0]!.length,
  length: v.length,
  sha256: createHash('sha256').update(v).digest('hex'),
}));
const citation = { url, title: '资料', blockIndex: 1, start: 4, end: 6 };
const evidence: WebSearchDisplay = {
  executionId: 'm1',
  status: 'completed',
  revision: 1,
  blocks,
  sources: [],
  citations: [citation],
};
test('exact UTF-16 citations span the second saved block without changing markdown or text', async () => {
  const anchors = await verifyWebSearchAnchors(text, 'm1', {
    ...evidence,
    citations: [citation, citation, { ...citation, blockIndex: 0, start: 3, end: 4 }],
  });
  expect(anchors).toEqual([{ url, start: parts[0]!.length + 4, end: parts[0]!.length + 6 }]);
  expect(
    await verifyWebSearchAnchors(text, 'm1', { ...evidence, blocks: blocks.slice(1) }),
  ).toEqual(anchors);
  const html = renderToStaticMarkup(<MessageContent text={text} webSearchAnchors={anchors} />);
  expect(html).toContain('web-search-citation');
  expect(html).toContain('中文');
  for (const [body, id] of [
    [text.slice(0, -1), 'm1'],
    [text.replace('中文', '正文'), 'm1'],
    [text.replace('中国', '此处'), 'm1'],
    [text, 'other'],
  ] as const)
    expect(await verifyWebSearchAnchors(body, id, evidence)).toEqual([]);
});
test('incomplete/unproven answers, out-of-range anchors and unsafe links do not decorate', async () => {
  for (const e of [
    { ...evidence, status: 'incomplete' as const },
    { ...evidence, blocks: [] },
    {
      ...evidence,
      citations: [
        { ...citation, end: 400 },
        { ...citation, url: 'file:///tmp/f' },
        { ...citation, start: -1 },
        { ...citation, blockIndex: 2 },
      ],
    },
  ])
    expect(await verifyWebSearchAnchors(text, 'm1', e)).toEqual([]);
  const anchors = await verifyWebSearchAnchors(text, 'm1', {
    ...evidence,
    citations: [{ ...citation, start: 0, end: 7 }],
  });
  expect(
    renderToStaticMarkup(<MessageContent text={text} webSearchAnchors={anchors} />),
  ).not.toContain('web-search-citation');
});
test('deduplicates within separate bounded cited/retrieved lists, escapes titles, strips dangerous URLs', () => {
  for (const bad of [
    'javascript:alert(1)',
    'https://user:pass@foo.bar',
    'file:///x',
    '//foo.org',
    'https://foo.org/\\x',
    'https://example.org/x\ny',
    'data:text/plain,hi',
  ])
    expect(webSearchHref(bad)).toBeUndefined();
  const list = Array.from({ length: 100 }, (_, i) => ({ url: `https://example.org/${i}` }));
  expect(webSearchLinks(list)).toHaveLength(64);
  const html = renderToStaticMarkup(
    <WebSearchSources
      evidence={{
        ...evidence,
        truncated: true,
        citations: [],
        sources: [{ url, title: '<img onerror=fetch()>' }, { url }],
      }}
    />,
  );
  expect(html).toContain('检索来源（1）');
  expect(html).not.toContain('仅显示部分搜索材料');
  expect(html).not.toContain('正文引用');
  expect(html).toContain('&lt;img');
  expect(html).not.toContain('<img');
  expect(
    renderToStaticMarkup(<WebSearchSources evidence={{ ...evidence, status: 'failed' }} />),
  ).toContain('搜索失败');
});

test('tool receipts show no placeholder for unavailable sources in running or completed evidence', () => {
  const receipt = {
    ...evidence,
    query: 'fixture',
    citations: [],
    sources: [{ url: 'file:///tmp/source' }],
    truncated: true,
  };
  for (const status of ['running', 'completed'] as const)
    expect(
      renderToStaticMarkup(<WebSearchSources evidence={{ ...receipt, status }} toolReceipt />),
    ).toBe('');
  expect(
    renderToStaticMarkup(
      <WebSearchSources evidence={{ ...receipt, status: 'unknown' }} toolReceipt />,
    ),
  ).toContain('搜索结果未知');
});
