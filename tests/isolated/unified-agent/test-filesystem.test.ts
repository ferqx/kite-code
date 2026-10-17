import { expect, test } from 'bun:test';
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { defaultWindowsPathSecurity } from '../../../packages/agent/src/platform/windows-path-security';
import {
  directoryLink,
  expectPrivateMode,
  fixturePermissions,
  temporaryDirectory,
} from '../../fixtures/test-filesystem';

test('scratch roots use the actual OS temp directory and preserve private ownership and file URL bytes', () => {
  const first = temporaryDirectory('kite-fixture 雪 #%-'),
    second = temporaryDirectory('kite-fixture 雪 #%-');
  try {
    expect(first).not.toBe(second);
    for (const root of [first, second]) {
      expect(isAbsolute(root)).toBe(true);
      expect(dirname(root)).toBe(realpathSync.native(tmpdir()));
      expect(realpathSync.native(root)).toBe(root);
      if (process.platform === 'win32') defaultWindowsPathSecurity()!.verifyDirectory(root);
      else {
        expect(lstatSync(root).mode & 0o777).toBe(0o700);
        expect(lstatSync(root).uid).toBe(process.getuid!());
      }
      const path = join(root, 'file 雪 #% .txt'),
        text = 'original Unicode bytes 雪🙂\r\n';
      writeFileSync(path, text, { mode: 0o600 });
      expect(fileURLToPath(pathToFileURL(path))).toBe(path);
      expect(readFileSync(pathToFileURL(path), 'utf8')).toBe(text);
    }
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test('directory aliases really traverse to the external regular file without copying it', () => {
  const root = temporaryDirectory('kite-fixture-alias-'),
    outside = temporaryDirectory('kite-fixture-external-'),
    alias = join(root, 'alias');
  try {
    const target = join(outside, 'original.txt');
    writeFileSync(target, 'original');
    directoryLink(outside, alias);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(realpathSync.native(join(alias, 'original.txt'))).toBe(target);
    writeFileSync(target, 'changed externally');
    expect(readFileSync(join(alias, 'original.txt'), 'utf8')).toBe('changed externally');
    rmSync(alias);
    expect(readFileSync(target, 'utf8')).toBe('changed externally');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('public-permission counterexamples change the actual platform policy and restore its private boundary', () => {
  const root = temporaryDirectory('kite-fixture-permissions-');
  try {
    expectPrivateMode(root, 0o700);
    fixturePermissions(root, 0o755);
    expect(() => expectPrivateMode(root, 0o700)).toThrow();
    fixturePermissions(root, 0o700);
    expectPrivateMode(root, 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('current shared test fixtures do not depend on a fixed POSIX temp root or concatenate file URLs', () => {
  const repository = resolve(import.meta.dir, '../../..'),
    failures: string[] = [];
  function scan(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (/\.tsx?$/.test(entry.name)) {
        const source = readFileSync(path, 'utf8'),
          file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
        function visit(node: ts.Node): void {
          if (
            ts.isCallExpression(node) &&
            /(?:^|\.)mkdtemp(?:Sync)?$/.test(node.expression.getText(file))
          ) {
            const argument = node.arguments[0];
            if (
              argument &&
              ts.isStringLiteral(argument) &&
              /^\/(?:private\/)?tmp\//.test(argument.text)
            )
              failures.push(`${relative(repository, path)}:fixed_temp_root`);
          }
          if (ts.isTemplateExpression(node) && node.head.text === 'file://')
            failures.push(`${relative(repository, path)}:concatenated_file_url`);
          ts.forEachChild(node, visit);
        }
        visit(file);
      }
    }
  }
  for (const owner of [
    'apps/cli',
    'apps/desktop',
    'apps/service',
    'apps/web',
    'packages/agent',
    'packages/ai',
    'packages/client',
    'packages/ui',
  ])
    scan(join(repository, owner, 'test'));
  for (const directory of ['tests/fixtures/unified-agent', 'tests/isolated/unified-agent'])
    scan(join(repository, directory));
  expect(failures).toEqual([]);
});
