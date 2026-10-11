import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertWindowsPredecessorLockedInput,
  materializeWindowsPredecessor,
  WINDOWS_PREDECESSOR_COMMIT,
  windowsPredecessorLockedInputPaths,
} from '../../fixtures/unified-agent/windows-predecessor';

const root = resolve(import.meta.dir, '../../..');
// Read-only audit of actual commit 837a2b8c; these are dependency inputs, not fabricated old source.
const previousInputs = {
  'bun.lock': 'abad6bbc5cad8a0b2ac5e7c53edb15c5ae2e4d1b5167e75be24de028ba1a4d8f',
  'package.json': 'b71511f0e48a943b42d4c7fa9283ca9fadce83d710193cf4c2edbf246bf24b37',
  'packages/ai/package.json': '23b2972e1c42da86b8514f5b69750f29016634299588a872ff67092946150f54',
  'packages/agent/package.json': '04e6ded336ad8c621a95f7260c1f68ec6e81963c3ef950af1bf73a34278c86ee',
  'packages/client/package.json':
    '55671a28908cfca1430fee4e4b3ab3bb97a1a04d472ca125be78b3e929b6a263',
  'packages/ui/package.json': '9ba1e4dbafb542ab2ff9644e90fbd2c2c63b5a5e306cf8b90b41344b07f2b81b',
  'apps/service/package.json': '0c9db66f55edf4a10ae1e8ed8c782ee2b495030882d855fcfa970639a4ae11cf',
  'apps/cli/package.json': '5afbc33868012a16871dbf8230f56c9b47b7bd3a4574026be751a9112293c90f',
  'apps/desktop/package.json': 'bce802d4101d3c98a1d34d646ec18688ab9cac58c366a431d53ef0e9d7fa9e86',
  'apps/web/package.json': '7ac721b72e8e59cb7ad4c769dce43b771d8017f106305ced20cab7368dc55c34',
  'patches/ink-virtual-list@0.2.3.patch':
    '1fe91aea8095e410a360b4ce9e0c0019fc927c879c2044d5ec9711dfbd03bbdf',
};
test('real Windows predecessor retains exactly its original eleven locked input bytes', () => {
  expect(WINDOWS_PREDECESSOR_COMMIT).toBe('837a2b8cde946d70d00920941a1a3e5e7c684f5d');
  const paths = windowsPredecessorLockedInputPaths(
    JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')),
  );
  expect(paths).toEqual(Object.keys(previousInputs));
  expect(paths).toHaveLength(11);
  for (const [path, expected] of Object.entries(previousInputs)) {
    const original = Bun.spawnSync(['git', 'show', `${WINDOWS_PREDECESSOR_COMMIT}:${path}`], {
      cwd: root,
    });
    expect(original.exitCode).toBe(0);
    const bytes = original.stdout;
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
    expect(assertWindowsPredecessorLockedInput(path, bytes, bytes)).toEqual({
      path,
      sha256: expected,
      currentSha256: expected,
      match: 'identical',
    });
  }
});

test('current Windows inputs retain all original bytes except the exact CI stdio and locked parser increments', () => {
  for (const [path, expected] of Object.entries(previousInputs)) {
    const original = Bun.spawnSync(['git', 'show', `${WINDOWS_PREDECESSOR_COMMIT}:${path}`], {
      cwd: root,
    });
    expect(original.exitCode).toBe(0);
    const current = readFileSync(resolve(root, path));
    expect(assertWindowsPredecessorLockedInput(path, original.stdout, current)).toEqual({
      path,
      sha256: expected,
      currentSha256:
        path === 'package.json'
          ? '3743d37499030ce97f727b5a72e9c84d59d6a6a6ad41f8708530d661f899ba2a'
          : path === 'bun.lock'
            ? '748e6ff66e8d3ca2ab4f27b83c9105aae05dc45cdca14edf6560200d5dcb1f91'
            : path === 'packages/agent/package.json'
              ? 'fdb805e391c6772a2b8e8217a31f17ec14949e084e343287634a0976ff783cc2'
              : expected,
      match:
        path === 'package.json'
          ? 'runtime_stdio_validation_script_increment'
          : path === 'bun.lock' || path === 'packages/agent/package.json'
            ? 'shell_parser_locked_dependency_increment'
            : 'identical',
    });
    if (path === 'packages/agent/package.json') {
      const text = current.toString('utf8');
      for (const changed of [
        text.replace('"tree-sitter-bash": "0.25.1"', '"tree-sitter-bash": "0.25.2"'),
        text.replace('"web-tree-sitter": "0.25.10"', '"web-tree-sitter": "0.25.11"'),
        text.replace('"@napi-rs/keyring": "1.3.0"', '"@napi-rs/keyring": "1.3.1"'),
        text.replace('    "./permissions": "./src/permissions/index.ts",\n', ''),
        text.replace('    "./permissions/shell": "./src/permissions/shell.ts",\n', ''),
        text.replace(' ./src/permissions/index.ts ', ' '),
        text.replace(' ./src/permissions/shell.ts ', ' '),
        text.replace('"exports": {', '"exports": {\n    "./unknown": "./src/unknown.ts",'),
        text.replace('--target=bun', '--target=node'),
      ]) {
        expect(changed).not.toBe(text);
        expect(() =>
          assertWindowsPredecessorLockedInput(path, original.stdout, Buffer.from(changed)),
        ).toThrow(`windows_predecessor_dependency_input_changed:${path}`);
      }
    }
    if (path === 'package.json') {
      expect(() =>
        assertWindowsPredecessorLockedInput('bun.lock', original.stdout, current),
      ).toThrow('windows_predecessor_dependency_input_changed:bun.lock');
      expect(() =>
        assertWindowsPredecessorLockedInput(
          path,
          original.stdout,
          Buffer.concat([current, Buffer.from('x')]),
        ),
      ).toThrow(`windows_predecessor_dependency_input_changed:${path}`);
    }
  }
});
test('locked inputs reject every changed byte and patch traversal without source exceptions', () => {
  for (const path of Object.keys(previousInputs)) {
    const original = readFileSync(resolve(root, path));
    expect(() =>
      assertWindowsPredecessorLockedInput(
        path,
        original,
        Buffer.concat([original, Buffer.from('x')]),
      ),
    ).toThrow(`windows_predecessor_dependency_input_changed:${path}`);
  }
  expect(() =>
    windowsPredecessorLockedInputPaths({ patchedDependencies: { bad: '../other.patch' } }),
  ).toThrow('windows_predecessor_patch_path_invalid');
});
test.skipIf(process.platform === 'win32' && process.arch === 'x64')(
  'cold import refuses non-Windows before path, process or build effects',
  async () => {
    await expect(
      materializeWindowsPredecessor({
        root: '/definitely-not-owned',
        repositoryRoot: '/missing',
        nativeElectronDist: '/missing',
        deadline: Date.now() + 1000,
      }),
    ).rejects.toThrow('windows_predecessor_platform_required');
  },
);
