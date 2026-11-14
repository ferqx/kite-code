/** Explicitly isolated native IPC/Service test build; never a production switch. */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { privateDirectory } from '../../../tests/fixtures/test-filesystem';

const repo = resolve(import.meta.dir, '../../..');
const root = resolve(
  process.argv.find((a) => a.startsWith('--fixture-root='))?.slice(15) ??
    resolve(repo, '../inline-service-5'),
);
const allowedRoots = [
  'inline-service-5',
  'inline-formats-word-1',
  'inline-formats-word-2',
  'inline-formats-excel-1',
  'inline-formats-ppt-1',
  'inline-edit-word-1',
  'inline-edit-word-2',
  'inline-edit-word-3',
  'inline-edit-word-4',
  'inline-edit-word-5',
  'inline-edit-excel-1',
  'inline-edit-excel-2',
  'inline-edit-excel-3',
  'inline-edit-excel-4',
  'inline-edit-ppt-1',
  'inline-edit-ppt-2',
  'inline-edit-ppt-3',
  'inline-edit-ppt-4',
  'inline-range-excel-1',
  'inline-sheet-excel-1',
  'inline-page-ppt-1',
  'inline-page-word-1',
  'inline-edit-ppt-5',
  'inline-style-excel-1',
  'inline-style-excel-2',
  'inline-style-excel-3',
  'inline-style-excel-4',
  'inline-style-excel-5',
  'inline-style-excel-6',
  'inline-style-excel-7',
  'inline-style-excel-8',
  'inline-style-excel-9',
  'inline-style-word-1',
  'inline-style-ppt-1',
].map((name) => resolve(repo, '..', name));
if (!allowedRoots.includes(root)) throw Error('fixture_root_invalid');
const out = join(root, 'app');
privateDirectory(root);
privateDirectory(out);
for (const [entry, name, target] of [
  ['test/windows-office-inline-main.fixture.ts', 'main.cjs', 'node'],
  ['electron/preload.ts', 'preload.cjs', 'node'],
  ['electron/profile-access-helper.ts', 'profile-access.js', 'bun'],
  ['test/windows-office-inline-renderer.fixture.tsx', 'renderer.js', 'browser'],
] as const) {
  const result = await Bun.build({
    entrypoints: [join(repo, 'apps/desktop', entry)],
    outdir: out,
    naming: target === 'browser' ? 'renderer.[ext]' : name,
    target,
    format: target === 'node' ? 'cjs' : 'esm',
    external: target === 'node' ? ['electron'] : [],
    define: { 'process.env.NODE_ENV': '"production"', __KITE_DESKTOP_TEST_DIAGNOSTICS__: 'false' },
  });
  if (!result.success) throw new AggregateError(result.logs, 'fixture_build_failed');
}
if (!existsSync(join(root, 'bootstrap.json'))) {
  console.log('BUILT_REAL_SERVICE_ASSETS_WAITING_FOR_BOOTSTRAP', out);
  process.exit(0);
}
const setup = JSON.parse(await readFile(join(root, 'bootstrap.json'), 'utf8'));
await writeFile(
  join(out, 'fixture-info.js'),
  `globalThis.officeFixtureInfo = Object.freeze(${JSON.stringify({ target: { storeId: setup.target.storeId, sessionId: setup.target.sessionId, fileId: setup.target.fileId, locator: setup.target.locator }, sessionId: setup.sessionId, sourceSha: setup.sourceSha, keyboardOnly: setup.keyboardOnly === true })});`,
);
await writeFile(
  join(out, 'package.json'),
  JSON.stringify({ name: 'kite-office-real-service-fixture', version: '0.0.0', main: 'main.cjs' }),
);
// Load the real client token sources; omit only their unrelated CSS import directives.
const shared = (await readFile(join(repo, 'packages/ui/src/desktop/style.css'), 'utf8')).replace(
  /^@(?:import|reference) [^;]+;\r?\n/gm,
  '',
);
const content = await readFile(join(repo, 'apps/desktop/src/native-content-theme.css'), 'utf8');
await writeFile(join(out, 'client-reference.css'), `${shared}\n${content}`);
await writeFile(
  join(out, 'index.html'),
  `<!doctype html><html data-platform="windows" data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"><link rel="stylesheet" href="client-reference.css"><link rel="stylesheet" href="renderer.css"><style>html,body,.client-content-frame,.client-main-panel,#root{height:100%;min-height:0}body{margin:0}*{box-sizing:border-box}</style></head><body class="kite-client"><main class="client-content-frame"><section class="client-main-panel"><div id="root"></div></section></main><script src="fixture-info.js"></script><script type="module" src="renderer.js"></script></body></html>`,
);
console.log('BUILT_REAL_SERVICE_UI', out);
