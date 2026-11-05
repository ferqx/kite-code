import { expect, test } from 'bun:test';
import { nativeToolRequestTarget } from '../src/tool-request-target';

test.each([
  ['browser.execute', '1', { code: 'PRIVATE CODE', description: '读取北京天气' }, '读取北京天气'],
  ['skills.load', '1', { id: 'computer-use', description: '查看天气' }, 'computer-use'],
  [
    'skills.resource',
    '1',
    { id: 'computer-use', path: 'references/browser-api.md', description: '读取浏览器指南' },
    'computer-use · references/browser-api.md',
  ],
  ['skills.load', '1', { id: 'computer-use' }, 'computer-use'],
  ['skills.load', '1', { description: '查看天气' }, undefined],
  ['skills.resource', '1', { description: '查看天气' }, undefined],
  ['skills.load', '1', { id: 'computer-use', description: '读'.repeat(11) }, 'computer-use'],
  [
    'skills.resource',
    '1',
    { id: 'computer-use', path: 'references/browser-api.md' },
    'computer-use · references/browser-api.md',
  ],
  ['files.read', '5', { path: 'src/中文🙂.ts', offset: 2 }, 'src/中文🙂.ts'],
  ['files.view_images', '1', { paths: ['a.png', 'b.png'] }, 'a.png · b.png'],
  ['files.view_images', '1', { paths: Array.from({ length: 11 }, () => 'a.png') }, undefined],
  ['files.view_images', '1', { path: 'a.png', paths: ['b.png'] }, undefined],
  ['files.read_path', '2', { path: '/Users/example/private.txt' }, '/Users/example/private.txt'],
  ['files.write', '3', { path: 'out/report.md', content: 'PRIVATE BODY' }, 'out/report.md'],
  ['files.edit', '2', { path: 'src/app.ts', find: 'PRIVATE BODY' }, 'src/app.ts'],
  ['files.write_path', '1', { path: '/tmp/output.txt' }, '/tmp/output.txt'],
  ['files.edit_path', '1', { path: '/tmp/output.txt' }, '/tmp/output.txt'],
  ['files.list', '1', {}, '.'],
  ['files.list', '1', { path: '' }, '.'],
  ['files.list', '1', { path: 'src' }, 'src'],
  ['files.glob', '3', { pattern: '**/*.ts' }, '**/*.ts'],
  ['files.glob', '3', { pattern: '*.ts', path: 'src' }, '*.ts · src'],
  ['files.search', '5', { text: 'toolTarget', path: 'src/main.ts' }, 'toolTarget · src/main.ts'],
  [
    'web_fetch',
    '1',
    { url: 'https://example.com/page?q=private' },
    'https://example.com/page?q=private',
  ],
  ['shell.execute', '1', { command: 'pwd' }, 'pwd'],
  [
    'shell.execute',
    '1',
    { command: 'pwd', description: '  核对\n工作目录  ', background: true },
    '核对 工作目录',
  ],
  ['shell.execute', '1', { command: 'pwd', description: '  ' }, 'pwd'],
  ['shell.launch', '1', { command: 'bun run dev' }, 'bun run dev'],
  ['shell.read', '1', { shellId: 'server' }, 'server'],
  ['shell.wait', '1', { shellId: 'server' }, 'server'],
  ['shell.stop', '1', { shellId: 'server' }, 'server'],
  ['mcp.tools.search', '1', { query: 'project issues', provider: 'unused' }, 'project issues'],
  ['mcp.connect', '1', { serverId: 'tracker', key: 'private' }, 'tracker'],
  ['mcp.catalogue.refresh', '1', { serverId: 'tracker' }, 'tracker'],
  ['mcp.reconnection', '1', { serverId: 'tracker' }, 'tracker'],
  ['mcp.resources.list', '1', { serverId: 'tracker' }, 'tracker'],
  ['mcp.resources.read', '1', { serverId: 'tracker', uri: 'issue://42' }, 'tracker · issue://42'],
  ['mcp.prompts.list', '1', { serverId: 'tracker' }, 'tracker'],
  [
    'mcp.prompts.get',
    '1',
    { serverId: 'tracker', name: 'review', arguments: { token: 'PRIVATE BODY' } },
    'tracker · review',
  ],
  [
    'planning.write',
    '1',
    { planId: 'plan', title: '修复读取展示', body: 'PRIVATE BODY' },
    '修复读取展示',
  ],
  ['planning.review', '1', { planId: 'plan' }, 'plan'],
  ['planning.update', '1', { planId: 'plan', stepId: 'fix' }, 'plan · fix'],
  ['activate_skill', '1', { skill_id: 'review', input: { secret: 'PRIVATE BODY' } }, 'review'],
  [
    'read_skill_reference',
    '1',
    { activation_id: 'private', path: 'references/guide.md' },
    'references/guide.md',
  ],
] as const)('%s@%s extracts only its known display target', (id, version, input, expected) => {
  expect(nativeToolRequestTarget(input, id, version)).toBe(expected);
});

test('short purposes are single-line and bounded without exposing code or unknown arguments', () => {
  const code = 'PRIVATE CODE';
  for (const description of ['读'.repeat(10), '🙂'.repeat(10)])
    expect(nativeToolRequestTarget({ code, description }, 'browser.execute', '1')).toBe(
      description,
    );
  expect(nativeToolRequestTarget({ code, description: '读取\n天气' }, 'browser.execute', '1')).toBe(
    '读取 天气',
  );
  for (const description of [undefined, '', '   ', '读'.repeat(11), '🙂'.repeat(11), 1, {}])
    expect(nativeToolRequestTarget({ code, description }, 'browser.execute', '1')).toBeUndefined();
  expect(
    nativeToolRequestTarget({ code, description: '读取天气' }, 'browser.execute', 'future'),
  ).toBeUndefined();
  expect(
    nativeToolRequestTarget({ description: '读取天气' }, 'custom.execute', '1'),
  ).toBeUndefined();
});

test('supported saved file versions retain target display', () => {
  for (const version of ['2', '3', '4', '5'])
    expect(nativeToolRequestTarget({ path: 'README.md' }, 'files.read', version)).toBe('README.md');
  for (const version of ['2', '3', '4', '5'])
    expect(nativeToolRequestTarget({ text: 'needle' }, 'files.search', version)).toBe('needle');
  for (const version of ['2', '3'])
    expect(nativeToolRequestTarget({ pattern: '*.md' }, 'files.glob', version)).toBe('*.md');
});

test('unknown tools, versions and inputs never expose arbitrary arguments', () => {
  for (const id of [
    'external.read',
    '__proto__',
    'constructor',
    'toString',
    'mcp.tracker.0123456789abcdef0123456789abcdef',
    'validation.define',
    'validation.check',
    'validation.rebind',
    'validation.request_waiver',
    'validation.auto_check',
    'planning.read',
    'complete_skill',
    'task.follow_up',
  ])
    expect(
      nativeToolRequestTarget({ path: 'PRIVATE BODY', title: 'PRIVATE BODY' }, id, '1'),
    ).toBeUndefined();
  expect(nativeToolRequestTarget({ path: 'PRIVATE BODY' }, 'files.read', 'future')).toBeUndefined();
  expect(nativeToolRequestTarget({}, 'files.list', 'future')).toBeUndefined();
  for (const input of [
    undefined,
    null,
    [],
    'path',
    42,
    { path: {} },
    { path: ['x'] },
    { path: '' },
  ])
    expect(nativeToolRequestTarget(input, 'files.read', '5')).toBeUndefined();
  expect(nativeToolRequestTarget({ path: 42 }, 'files.list', '1')).toBeUndefined();
  expect(nativeToolRequestTarget({ path: 'src' }, 'files.glob', '3')).toBeUndefined();
});

test('long targets preserve complete Unicode code points and fit the display bound', () => {
  for (const length of [4095, 4096]) {
    const path = '🙂'.repeat(length);
    expect(nativeToolRequestTarget({ path }, 'files.read', '5')).toBe(path);
  }
  const path = `src/${'雪🙂'.repeat(3000)}`;
  const target = nativeToolRequestTarget({ path }, 'files.read', '5')!;
  expect([...target]).toHaveLength(4096);
  expect(target.endsWith('…')).toBe(true);
  expect(target).not.toContain('\ufffd');
  const search = nativeToolRequestTarget({ text: '雪'.repeat(4095), path }, 'files.search', '5')!;
  expect([...search]).toHaveLength(4096);
  expect(search.endsWith('…')).toBe(true);
});
