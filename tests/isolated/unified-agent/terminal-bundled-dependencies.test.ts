import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { terminalBundledNotices } from '../../../scripts/release/terminal-dependencies';
import {
  directoryAlias,
  releaseDirectory,
  releaseScratch,
} from '../../fixtures/unified-agent/release-filesystem';

test('bundled notices preserve the exact installed license bytes and graph identities without executing dependency code', () => {
  const root = releaseScratch(join(tmpdir(), 'kite-bundled-notices-'));
  try {
    const workspace = join(root, 'workspace'),
      library = join(root, 'node_modules/library'),
      child = join(root, 'node_modules/child');
    for (const path of [workspace, library, child]) releaseDirectory(path, { recursive: true });
    writeFileSync(
      join(workspace, 'package.json'),
      JSON.stringify({
        name: '@fixture/workspace',
        version: '1.0.0',
        dependencies: { library: '1' },
      }),
    );
    const marker = join(root, 'package-code-executed');
    const manifest = Buffer.from(
      JSON.stringify({
        name: 'library',
        version: '1.0.0',
        dependencies: { child: '1' },
        peerDependencies: { absent: '*' },
        peerDependenciesMeta: { absent: { optional: true } },
        main: 'index.js',
        scripts: { postinstall: 'must-not-execute' },
      }),
    );
    writeFileSync(join(library, 'package.json'), manifest);
    writeFileSync(
      join(library, 'index.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');throw Error('unexpected_import');`,
    );
    const license = Buffer.from('Original copyright\r\n完整许可 UTF-8\r\n');
    writeFileSync(join(library, 'LICENSE'), license);
    writeFileSync(join(child, 'package.json'), JSON.stringify({ name: 'child', version: '2.0.0' }));
    writeFileSync(join(child, 'NOTICE.txt'), 'original transitive notice');
    const result = terminalBundledNotices({
      repositoryRoot: root,
      workspaceRoot: workspace,
      names: ['library'],
    });
    expect(result.packages.map((pkg) => [pkg.name, pkg.version])).toEqual([
      ['child', '2.0.0'],
      ['library', '1.0.0'],
    ]);
    const original = result.packages.find((pkg) => pkg.name === 'library')!;
    expect(original.manifestSha256).toBe(createHash('sha256').update(manifest).digest('hex'));
    expect(Buffer.from(original.notices[0]!.text)).toEqual(license);
    expect(original.notices[0]!.sha256).toBe(createHash('sha256').update(license).digest('hex'));
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(library, 'package.json'))).toEqual(manifest);
    expect(() =>
      terminalBundledNotices({
        repositoryRoot: root,
        workspaceRoot: workspace,
        names: ['undeclared'],
      }),
    ).toThrow('bundled_dependency_invalid');
    const outside = join(root, 'outside');
    releaseDirectory(outside);
    const alias = join(library, 'NOTICE');
    directoryAlias(outside, alias);
    try {
      expect(() =>
        terminalBundledNotices({
          repositoryRoot: root,
          workspaceRoot: workspace,
          names: ['library'],
        }),
      ).toThrow('notice_invalid');
    } finally {
      rmSync(alias);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bundled provenance preserves license declarations when the installed package has no separate notice file', () => {
  const root = releaseScratch(join(tmpdir(), 'kite-bundled-manifest-license-'));
  try {
    const workspace = join(root, 'workspace'),
      library = join(root, 'node_modules/library');
    for (const path of [workspace, library]) releaseDirectory(path, { recursive: true });
    writeFileSync(
      join(workspace, 'package.json'),
      JSON.stringify({ name: '@fixture/workspace', version: '1', dependencies: { library: '1' } }),
    );
    const manifest = Buffer.from(
      '{\r\n  "name":"library", "version":"1", "license":"(MIT OR Apache-2.0)"\r\n}\r\n',
    );
    writeFileSync(join(library, 'package.json'), manifest);
    const result = terminalBundledNotices({
      repositoryRoot: root,
      workspaceRoot: workspace,
      names: ['library'],
    });
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]!.notices).toEqual([]);
    expect(result.packages[0]!.manifestText).toBe(manifest.toString('utf8'));
    expect(result.packages[0]!.manifestSha256).toBe(
      createHash('sha256').update(manifest).digest('hex'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
