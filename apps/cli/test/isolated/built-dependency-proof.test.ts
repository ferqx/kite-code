import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedDependency, verifyBuiltDependency } from '../fixtures/built-dependency-proof';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kite-built-dependency-proof-'));
  const source = join(root, 'source');
  const built = join(root, 'candidate');
  mkdirSync(join(source, 'node_modules/hono'), { recursive: true });
  mkdirSync(built);
  const manifestText = '{"name":"hono","version":"4.13.12","license":"MIT"}\n';
  const manifestSha256 = createHash('sha256').update(manifestText).digest('hex');
  writeFileSync(join(source, 'package.json'), '{"name":"source"}');
  writeFileSync(join(source, 'node_modules/hono/package.json'), manifestText);
  const row = { name: 'hono', version: '4.13.12', manifestText, manifestSha256 };
  const metadata = {
    version: 1,
    coverage: 'installed-declared-graph',
    roots: ['hono'],
    packages: [
      { name: 'hono', version: '4.12.27', manifestText: '{}', manifestSha256: 'other' },
      row,
    ],
  };
  return {
    source,
    built,
    row,
    metadata,
    save: () => writeFileSync(join(built, 'BUNDLED-DEPENDENCIES.json'), JSON.stringify(metadata)),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
test('bundled proof selects the exact source-installed manifest despite another transitive version', () => {
  const f = fixture();
  try {
    f.save();
    const expected = installedDependency('hono', f.source);
    expect(expected).toEqual({
      name: 'hono',
      version: '4.13.12',
      manifestSha256: createHash('sha256').update(f.row.manifestText).digest('hex'),
    });
    expect(verifyBuiltDependency('hono', f.built, expected, true)).toEqual(expected);
  } finally {
    f.close();
  }
});
test.each([
  'missing root',
  'wrong version',
  'wrong hash',
  'duplicate identity',
  'corrupt text',
])('bundled proof refuses %s without falling back to a standalone copy', (fault) => {
  const f = fixture();
  try {
    const expected = installedDependency('hono', f.source);
    mkdirSync(join(f.built, 'node_modules/hono'), { recursive: true });
    writeFileSync(join(f.built, 'node_modules/hono/package.json'), f.row.manifestText);
    if (fault === 'missing root') f.metadata.roots = [];
    if (fault === 'wrong version') f.row.version = '4.12.27';
    if (fault === 'wrong hash') f.row.manifestSha256 = '0'.repeat(64);
    if (fault === 'duplicate identity') f.metadata.packages.push({ ...f.row });
    if (fault === 'corrupt text') f.row.manifestText += ' ';
    f.save();
    expect(() => verifyBuiltDependency('hono', f.built, expected, true)).toThrow();
  } finally {
    f.close();
  }
});
test('external proof still requires the exact independently installed manifest', () => {
  const f = fixture();
  try {
    f.save();
    const expected = installedDependency('hono', f.source);
    expect(() => verifyBuiltDependency('hono', f.built, expected, false)).toThrow();
    mkdirSync(join(f.built, 'node_modules/hono'), { recursive: true });
    writeFileSync(join(f.built, 'node_modules/hono/package.json'), f.row.manifestText);
    expect(verifyBuiltDependency('hono', f.built, expected, false)).toEqual(expected);
    writeFileSync(join(f.built, 'node_modules/hono/package.json'), `${f.row.manifestText} `);
    expect(() => verifyBuiltDependency('hono', f.built, expected, false)).toThrow();
  } finally {
    f.close();
  }
});
