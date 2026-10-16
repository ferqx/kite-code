import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertCompatiblePredecessorInputPaths,
  assertCompatiblePredecessorLockedInput,
  COMPATIBLE_PREDECESSOR_INPUT_PATHS,
  COMPATIBLE_PREDECESSOR_MIGRATIONS,
} from '../../fixtures/unified-agent/compatible-predecessor-input';
import { refinePredecessorWorkspaceDeclarations } from '../../fixtures/unified-agent/predecessor-workspace-declarations';
import {
  COMPATIBLE_TERMINAL_PREDECESSOR_COMMIT,
  matchTerminalPredecessorInput,
  TERMINAL_PREDECESSOR_COMMIT,
  withoutReviewedTuiLockDeclarations,
} from '../../fixtures/unified-agent/terminal-predecessor';

const repository = resolve(import.meta.dir, '../../..'),
  path = 'packages/agent/package.json',
  original = Bun.spawnSync(['git', 'show', `${TERMINAL_PREDECESSOR_COMMIT}:${path}`], {
    cwd: repository,
  });
if (original.exitCode !== 0) throw Error('terminal_predecessor_original_manifest_missing');
const previous = original.stdout,
  current = readFileSync(resolve(repository, path)),
  bytes = (text: string) => Buffer.from(text);

test('predecessor accepts identical inputs and the exact owned-process and permissions increments', () => {
  expect(matchTerminalPredecessorInput(path, previous, previous)).toBe('identical');
  expect(matchTerminalPredecessorInput(path, previous, current)).toBe(
    'process_observation_and_shell_parser_increment',
  );
  expect(matchTerminalPredecessorInput('bun.lock', previous, current)).toBeUndefined();
});

test('the source increment never permits dependency, extra export, or other build changes', () => {
  const text = current.toString('utf8');
  for (const changed of [
    text.replace('"@napi-rs/keyring": "1.3.0"', '"@napi-rs/keyring": "1.3.1"'),
    text.replace('"exports": {', '"exports": {\n    "./unknown": "./src/unknown.ts",'),
    text.replace('--target=bun', '--target=node'),
    text.replace('    "./permissions": "./src/permissions/index.ts",\n', ''),
    text.replace('    "./permissions/shell": "./src/permissions/shell.ts",\n', ''),
    text.replace(' ./src/permissions/index.ts ', ' '),
    text.replace(' ./src/permissions/shell.ts ', ' '),
    text.replace('"./process-observation": "./src/process-observation.ts",\n', ''),
    text.replace(' ./src/process-observation.ts ', ' '),
  ]) {
    expect(changed).not.toBe(text);
    expect(matchTerminalPredecessorInput(path, previous, bytes(changed))).toBeUndefined();
  }
});

test('predecessor accepts only the exact Windows Native bootstrap source entry increment', () => {
  const servicePath = 'apps/service/package.json',
    originalService = Bun.spawnSync(
      ['git', 'show', `${TERMINAL_PREDECESSOR_COMMIT}:${servicePath}`],
      { cwd: repository },
    );
  expect(originalService.exitCode).toBe(0);
  const previousService = originalService.stdout,
    currentService = readFileSync(resolve(repository, servicePath)),
    text = currentService.toString('utf8');
  expect(matchTerminalPredecessorInput(servicePath, previousService, previousService)).toBe(
    'identical',
  );
  expect(matchTerminalPredecessorInput(servicePath, previousService, currentService)).toBe(
    'windows_native_bootstrap_source_entry',
  );
  expect(
    matchTerminalPredecessorInput('bun.lock', previousService, currentService),
  ).toBeUndefined();
  for (const changed of [
    text.replace('"hono": "4.13.12"', '"hono": "4.13.13"'),
    text.replace('"exports": {', '"exports": {\n    "./unknown": "./src/unknown.ts",'),
    text.replace('    "./windows-native-bootstrap": "./src/windows-native-bootstrap.ts",\n', ''),
    text.replace(' ./src/windows-native-bootstrap.ts ', ' '),
    text.replace('--target=bun', '--target=node'),
    text.replace('"version": "0.1.0"', '"version": "0.1.1"'),
  ]) {
    expect(changed).not.toBe(text);
    expect(
      matchTerminalPredecessorInput(servicePath, previousService, bytes(changed)),
    ).toBeUndefined();
  }
});

test('the root input permits only the exact reviewed stdio and Desktop development scripts', () => {
  const path = 'package.json',
    original = Bun.spawnSync(['git', 'show', `${TERMINAL_PREDECESSOR_COMMIT}:${path}`], {
      cwd: repository,
    });
  expect(original.exitCode).toBe(0);
  const previous = original.stdout,
    current = readFileSync(resolve(repository, path)),
    text = current.toString('utf8');
  expect(matchTerminalPredecessorInput(path, previous, previous)).toBe('identical');
  expect(matchTerminalPredecessorInput(path, previous, current)).toBe(
    'runtime_stdio_and_desktop_development_script_increment',
  );
  expect(matchTerminalPredecessorInput('bun.lock', previous, current)).toBeUndefined();
  for (const changed of [
    text.replace(' packages/agent/test/isolated/mcp/linux-stdio-port.test.ts', ''),
    text.replace(' packages/agent/test/isolated/mcp/linux-owned-program.test.ts', ''),
    text.replace(' packages/agent/test/isolated/mcp/windows-stdio-port.test.ts', ''),
    text.replace(' && bun test --parallel=1 --max-concurrency=1', ''),
    text.replace(
      'scripts/development/unified-desktop.ts',
      'scripts/development/unified-desktop.ts && echo injected',
    ),
    text.replace('"typecheck": "tsc --noEmit', '"typecheck": "echo tsc --noEmit'),
    text.replace('"version": "0.1.0"', '"version": "0.1.1"'),
    text.replace('"@napi-rs/keyring": "1.3.0"', '"@napi-rs/keyring": "1.3.1"'),
    text.replace('    "packages/ai",\n', ''),
    text.replace('"patches/ink-virtual-list@0.2.3.patch"', '"patches/unknown.patch"'),
  ]) {
    expect(changed).not.toBe(text);
    expect(matchTerminalPredecessorInput(path, previous, bytes(changed))).toBeUndefined();
  }
});

test('predecessor permits only the exact parser declarations and pinned complete lock closure', () => {
  for (const path of ['bun.lock', 'packages/agent/package.json']) {
    const prior = Bun.spawnSync(['git', 'show', `${TERMINAL_PREDECESSOR_COMMIT}:${path}`], {
      cwd: repository,
    });
    expect(prior.exitCode).toBe(0);
    const current = readFileSync(resolve(repository, path));
    expect(
      createHash('sha256')
        .update(
          path === 'bun.lock'
            ? withoutReviewedTuiLockDeclarations(current)!
            : refinePredecessorWorkspaceDeclarations(path, current)!.bytes,
        )
        .digest('hex'),
    ).toBe(
      path === 'bun.lock'
        ? '748e6ff66e8d3ca2ab4f27b83c9105aae05dc45cdca14edf6560200d5dcb1f91'
        : 'fdb805e391c6772a2b8e8217a31f17ec14949e084e343287634a0976ff783cc2',
    );
    expect(matchTerminalPredecessorInput(path, prior.stdout, current)).toBe(
      path === 'bun.lock'
        ? 'shell_parser_and_tui_workspace_dependency_increment'
        : 'process_observation_and_shell_parser_increment',
    );
    const text = current.toString();
    const changes = [
      text.replace('"tree-sitter-bash": "0.25.1"', '"tree-sitter-bash": "0.25.2"'),
      text.replace('"web-tree-sitter": "0.25.10"', '"web-tree-sitter": "0.25.11"'),
      text.replace('"@napi-rs/keyring": "1.3.0"', '"@napi-rs/keyring": "1.3.1"'),
      text + '\n',
    ];
    if (path === 'bun.lock') {
      const start = text.indexOf('    "packages/ui": {');
      changes.push(
        text.slice(0, start) +
          text.slice(start).replace('"ink-text-input": "^6.0.0"', '"ink-text-input": "^6.0.1"'),
      );
      changes.push(
        text.replace('"ink-syntax-highlight": "^2.0.2"', '"ink-syntax-highlight": "^2.0.3"'),
        text.replace('"ink-text-input": "^6.0.0"', '"ink-text-input": "^6.0.1"'),
        text.replace('sha512-aiBrZ/', 'sha512-xiBrZ/'),
        text.replace(
          '        "react-markdown": "10.1.0",',
          '        "unexpected": "1.0.0",\n        "react-markdown": "10.1.0",',
        ),
        text.replace('node-addon-api@8.9.2', 'node-addon-api@8.9.3'),
        text.replace('node-gyp-build@4.8.4', 'node-gyp-build@4.8.5'),
        text.replace('"optionalPeers": ["tree-sitter"]', '"optionalPeers": []'),
        text.replace('sha512-Y09sF44/', 'sha512-X09sF44/'),
        text.replace(
          '    "webidl-conversions": [',
          '    "unrecognized": ["unrecognized@1.0.0", "", {}, "sha512-x"],\n\n    "webidl-conversions": [',
        ),
      );
    }
    for (const changed of changes) {
      expect(changed).not.toBe(text);
      expect(matchTerminalPredecessorInput(path, prior.stdout, bytes(changed))).toBeUndefined();
    }
  }
});

test('UI declarations refine only the exact reviewed workspace manifest; arbitrary dependency or metadata changes fail', () => {
  const path = 'packages/ui/package.json';
  const prior = Bun.spawnSync(['git', 'show', `${TERMINAL_PREDECESSOR_COMMIT}:${path}`], {
    cwd: repository,
  });
  expect(prior.exitCode).toBe(0);
  const current = readFileSync(resolve(repository, path)),
    text = current.toString();
  expect(matchTerminalPredecessorInput(path, prior.stdout, current)).toBe(
    'tui_workspace_dependency_increment',
  );
  for (const changed of [
    text.replace('"ink-text-input": "^6.0.0"', '"ink-text-input": "^6.0.1"'),
    text.replace('"ink-syntax-highlight": "^2.0.2"', '"ink-syntax-highlight": "^2.0.3"'),
    text.replace('"dependencies": {', '"dependencies": {\n    "unknown": "1.0.0",'),
    text.replace('"react-markdown": "10.1.0"', '"react-markdown": "10.1.1"'),
    text + '\n',
  ]) {
    expect(changed).not.toBe(text);
    expect(matchTerminalPredecessorInput(path, prior.stdout, bytes(changed))).toBeUndefined();
  }
});

test('current workspace refinements preserve pinned bytes and reject incomplete or misplaced declarations', () => {
  const hashes: Record<string, string> = {
    'bun.lock': 'cc1b2b43f874bca59043e4c2090675c2b0c4c4033d9d1cd19da95b5ffc67d6d1',
    'packages/agent/package.json':
      'eeb75457d1fa24a49a6d806710c0de6eef76f8af4743e8086b20e2dfeea7a8be',
    'packages/ui/package.json': 'f2ef2bdb1eca663e29c5f05b1fd595bab911287136a2a698956e3d2aa90b2411',
  };
  for (const [path, sha256] of Object.entries(hashes)) {
    const current = readFileSync(resolve(repository, path)),
      text = current.toString('utf8'),
      original = Bun.spawnSync(['git', 'show', `${TERMINAL_PREDECESSOR_COMMIT}:${path}`], {
        cwd: repository,
      });
    expect(original.exitCode).toBe(0);
    expect(createHash('sha256').update(current).digest('hex')).toBe(sha256);
    const refinement = refinePredecessorWorkspaceDeclarations(path, current)!;
    expect(refinement).toBeDefined();
    expect(refinement.commits).toContain('cf6b4946e');
    expect(matchTerminalPredecessorInput(path, original.stdout, current)).toBeDefined();
    const changes = [text.replace('"name":', '"unexpected": true,\n  "name":'), `${text}\n`];
    if (path === 'packages/agent/package.json')
      changes.push(
        text.replace('    "./context-estimate": "./src/context-estimate.ts"\n', ''),
        text.replace(' ./src/context-estimate.ts ', ' '),
        text.replace('"gpt-tokenizer": "^3.4.0"', '"gpt-tokenizer": "^3.4.1"'),
        text.replace('./src/context-estimate.ts"', './src/other.ts"'),
        text.replace(
          '    "./context-estimate": "./src/context-estimate.ts"',
          '    "./context-estimate": "./src/context-estimate.ts",\n    "./context-estimate": "./src/context-estimate.ts"',
        ),
      );
    else if (path === 'packages/ui/package.json')
      changes.push(
        text.replace('    "./desktop/markdown": "./src/desktop/markdown-parser.ts",\n', ''),
        text.replace('    "ink-scroll-list": "^0.4.1",\n', ''),
        text.replace('"ink-scroll-list": "^0.4.1"', '"ink-scroll-list": "^0.4.2"'),
        text.replace('./src/desktop/markdown-parser.ts"', './src/desktop/other.ts"'),
        text
          .replace('    "./desktop/markdown": "./src/desktop/markdown-parser.ts",\n', '')
          .replace(
            '  "dependencies": {\n',
            '  "dependencies": {\n    "./desktop/markdown": "./src/desktop/markdown-parser.ts",\n',
          ),
        text
          .replace('    "ink-scroll-list": "^0.4.1",\n', '')
          .replace('  "exports": {\n', '  "exports": {\n    "ink-scroll-list": "^0.4.1",\n'),
        text.replace(
          '    "ink-scroll-list": "^0.4.1",\n',
          '    "ink-scroll-list": "^0.4.1",\n    "ink-scroll-list": "^0.4.1",\n',
        ),
      );
    else {
      // Change only the selected workspace, leaving the root declarations untouched.
      for (const [workspace, declaration] of [
        ['packages/agent', '        "gpt-tokenizer": "^3.4.0",\n'],
        ['packages/ui', '        "ink-scroll-list": "^0.4.1",\n'],
      ] as const) {
        const start = text.indexOf(`    "${workspace}": {`);
        expect(start).toBeGreaterThan(0);
        for (const replacement of ['', declaration + declaration, declaration.replace('^', '~')])
          changes.push(text.slice(0, start) + text.slice(start).replace(declaration, replacement));
      }
      changes.splice(0, 1, text.replace('"gpt-tokenizer": "^3.4.0"', '"gpt-tokenizer": "^3.4.1"'));
      changes.push(text.replace('gpt-tokenizer@3.4.0', 'gpt-tokenizer@3.4.1'));
      const start = text.indexOf('    "packages/agent": {'),
        end = text.indexOf('\n    },\n', start),
        declaration = '        "gpt-tokenizer": "^3.4.0",\n';
      const moved = text
        .slice(start, end)
        .replace(declaration, '')
        .replace('      "devDependencies": {\n', `      "devDependencies": {\n${declaration}`);
      changes.push(text.slice(0, start) + moved + text.slice(end));
    }
    for (const changed of changes) {
      expect(changed).not.toBe(text);
      expect(matchTerminalPredecessorInput(path, original.stdout, bytes(changed))).toBeUndefined();
    }
  }
});

test('compatible real predecessor pins all eleven raw inputs and both exact migration assets without refinements', () => {
  expect(COMPATIBLE_TERMINAL_PREDECESSOR_COMMIT).toBe('4a4c0e440b2098e5b4ec58c5831452773b39228f');
  expect(COMPATIBLE_PREDECESSOR_INPUT_PATHS).toHaveLength(11);
  expect(() =>
    assertCompatiblePredecessorInputPaths(COMPATIBLE_PREDECESSOR_INPUT_PATHS),
  ).not.toThrow();
  expect(() =>
    assertCompatiblePredecessorInputPaths(COMPATIBLE_PREDECESSOR_INPUT_PATHS.slice(1)),
  ).toThrow('compatible_predecessor_input_inventory_changed');
  expect(() =>
    assertCompatiblePredecessorInputPaths([...COMPATIBLE_PREDECESSOR_INPUT_PATHS, 'unreviewed']),
  ).toThrow('compatible_predecessor_input_inventory_changed');
  expect(() =>
    assertCompatiblePredecessorInputPaths([...COMPATIBLE_PREDECESSOR_INPUT_PATHS].reverse()),
  ).toThrow('compatible_predecessor_input_inventory_changed');
  for (const path of [
    ...COMPATIBLE_PREDECESSOR_INPUT_PATHS,
    ...COMPATIBLE_PREDECESSOR_MIGRATIONS.map((item) => item.path),
  ]) {
    const original = Bun.spawnSync(
      ['git', 'show', `${COMPATIBLE_TERMINAL_PREDECESSOR_COMMIT}:${path}`],
      { cwd: repository },
    );
    expect(original.exitCode).toBe(0);
    const current = readFileSync(resolve(repository, path));
    const sha256 = createHash('sha256').update(current).digest('hex');
    expect(assertCompatiblePredecessorLockedInput(path, original.stdout, current)).toEqual({
      path,
      sha256,
      currentSha256: sha256,
      match: 'identical',
    });
    const migration = COMPATIBLE_PREDECESSOR_MIGRATIONS.find((item) => item.path === path);
    if (migration) expect(sha256).toBe(migration.sha256);
    for (const changed of [Buffer.concat([current, Buffer.from('\n')]), current.subarray(1)])
      expect(() => assertCompatiblePredecessorLockedInput(path, original.stdout, changed)).toThrow(
        `compatible_predecessor_input_changed:${path}`,
      );
  }
  expect(() => assertCompatiblePredecessorLockedInput('unreviewed', previous, previous)).toThrow(
    'compatible_predecessor_input_changed:unreviewed',
  );
});

test('unmerged recovery and UI commits cannot replace the complete compatible predecessor', () => {
  const path = 'packages/ui/package.json';
  const recoveryOnly = Bun.spawnSync(
    ['git', 'show', `30e7ec16a63de354f61677093566b77ff7fe4796:${path}`],
    { cwd: repository },
  );
  expect(recoveryOnly.exitCode).toBe(0);
  expect(() =>
    assertCompatiblePredecessorLockedInput(
      path,
      recoveryOnly.stdout,
      readFileSync(resolve(repository, path)),
    ),
  ).toThrow(`compatible_predecessor_input_changed:${path}`);
  const migration = COMPATIBLE_PREDECESSOR_MIGRATIONS[1];
  const uiOnly = Bun.spawnSync(['git', 'show', `21fd426d7:${migration.path}`], { cwd: repository });
  expect(uiOnly.exitCode).not.toBe(0);
  expect(() =>
    assertCompatiblePredecessorLockedInput(
      migration.path,
      uiOnly.stdout,
      readFileSync(resolve(repository, migration.path)),
    ),
  ).toThrow(`compatible_predecessor_input_changed:${migration.path}`);
  for (const migration of COMPATIBLE_PREDECESSOR_MIGRATIONS) {
    const malformed = Buffer.from('identical but not a supported migration');
    expect(() =>
      assertCompatiblePredecessorLockedInput(migration.path, malformed, malformed),
    ).toThrow(`compatible_predecessor_input_changed:${migration.path}`);
  }
});
