import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createShellCommandPolicy } from '../../src/shell-command-policy';

test('loads the real packaged Bash WASM and accepts only literal argv sequences', async () => {
  const policy = await createShellCommandPolicy({
    cwd: '/tmp/kite-workspace',
    shellExecutable: '/bin/zsh',
  });
  expect(policy.assets).toHaveLength(2);
  for (const asset of policy.assets) {
    expect(asset.path.endsWith('.wasm')).toBe(true);
    expect(createHash('sha256').update(readFileSync(asset.path)).digest('hex')).toBe(asset.digest);
  }
  expect(await policy.classify("printf '%s' hello && cat file.txt | head -1; git status")).toEqual({
    plainCommands: [
      ['printf', '%s', 'hello'],
      ['cat', 'file.txt'],
      ['head', '-1'],
      ['git', 'status'],
    ],
    hardDenied: null,
  });
  expect((await policy.classify('printf "a b" x\'y\'')).plainCommands).toEqual([
    ['printf', 'a b', 'xy'],
  ]);
  for (const command of [
    'printf x > output.txt',
    'cat "$FILE"',
    'cat $(printf file)',
    'cat `printf file`',
    'for x in files; do cat "$x"; done',
    'VAR=x cat file',
    'cat *.txt',
    'cat ~/file',
    'cat =cat',
    'cat file\\ name',
    'cat <(printf file)',
    'cat file &',
    'cat "\\$FILE"',
    'cat {a,b}',
    'cat "unterminated',
  ])
    expect((await policy.classify(command)).plainCommands).toBeNull();
});

test('retains fixed critical-system denial through literal wrappers and complex AST', async () => {
  const policy = await createShellCommandPolicy({
    cwd: '/tmp/kite-workspace',
    shellExecutable: '/bin/bash',
  });
  for (const command of [
    'sudo rm -rf /',
    'FOO=bar rm -rf /',
    'env FOO=bar rm -rf /',
    'env -i FOO=bar rm -rf /',
    'env --unset HOME rm -rf /',
    'env --unset "$NAME" rm -rf /',
    'env -C "$DIR" rm -rf /',
    'env -- command rm -rf /',
    'command -p rm -rf /',
    'nohup rm -rf /',
    'env --chdir=/etc rm -rf ./nginx',
    'env -C /etc command rm -rf ./nginx',
    'cd /etc; rm -rf ./hosts',
    'cd / && rm -rf ./etc',
    'if true; then cd /etc; fi; rm -rf ./hosts',
    "sh -c 'cd /etc; rm -rf ./hosts'",
    'printf x | cd /etc; rm -rf ./hosts',
    "env -i sh -c 'if true; then rm -rf /; fi'",
    '/bin/rm --force /etc/hosts',
    "rm -rf '/etc/../etc/nginx'",
    'rm -rf ../../etc/hosts',
    'if true; then rm -rf /etc/nginx; fi',
    'printf "%s" "$(rm -rf /etc/nginx)"',
  ])
    expect((await policy.classify(command)).hardDenied).toBe('shell_critical_system_removal');
  for (const command of [
    'git -C /etc clean -fdx',
    'git -C/etc reset --hard',
    'git --git-dir=/etc/repo/.git checkout .',
    'git --work-tree /etc/repo restore .',
    'env -i git -C /etc rm file',
    'cd /etc && git clean -fdx',
  ])
    expect((await policy.classify(command)).hardDenied).toBe(
      'shell_critical_system_git_destruction',
    );
  for (const command of [
    "echo 'rm -rf /'",
    'printf "%s" "git -C /etc clean -fdx"',
    'rm -rf ./build',
    'rm -rf /tmp/build',
    'git -C /tmp/repo clean -fdx',
    'format C:',
    'diskpart /s wipe.txt',
    'rm -rf "$TARGET"',
    'env -C "$DIR" rm -rf ../../etc',
    '(cd /etc); rm -rf ./build',
    'cd /etc | cat; rm -rf ./build',
    'echo "$(cd /etc)"; rm -rf ./build',
    'f() { cd /etc; }; rm -rf ./build',
    'env -C /etc sh -c "printf harmless"; rm -rf ./build',
  ])
    expect((await policy.classify(command)).hardDenied).toBeNull();
  expect((await policy.classify('if true; then rm -rf /; fi')).plainCommands).toBeNull();
  for (const command of ['rm -rf /\n(', "sh -c 'rm -rf /\n('"])
    expect(await policy.classify(command)).toMatchObject({
      hardDenied: 'shell_critical_system_removal',
    });
  expect((await policy.classify('rm -rf /\n(')).plainCommands).toBeNull();
  expect(await policy.classify('printf harmless\n(')).toEqual({
    plainCommands: null,
    hardDenied: null,
  });
});

test('does not reinterpret a non-POSIX shell with Bash grammar', async () => {
  const policy = await createShellCommandPolicy({
    cwd: '/tmp/kite-workspace',
    shellExecutable: 'powershell.exe',
  });
  expect(await policy.classify('Get-Content file')).toEqual({
    plainCommands: null,
    hardDenied: null,
  });
});

test('rejects changed original parser assets without touching installed dependencies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-shell-parser-'));
  try {
    const modules = join(root, 'node_modules');
    mkdirSync(join(modules, '@kite-ai'), { recursive: true });
    const packageRoot = (name: string) =>
      dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`)));
    cpSync(
      dirname(fileURLToPath(import.meta.resolve('web-tree-sitter/tree-sitter.wasm'))),
      join(modules, 'web-tree-sitter'),
      { recursive: true },
    );
    cpSync(packageRoot('tree-sitter-bash'), join(modules, 'tree-sitter-bash'), { recursive: true });
    symlinkSync(
      realpathSync(fileURLToPath(new URL('../../../../packages/agent', import.meta.url))),
      join(modules, '@kite-ai/agent'),
      'dir',
    );
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL('../../src/shell-command-policy.ts', import.meta.url))],
      target: 'bun',
      packages: 'external',
      outdir: root,
    });
    expect(result.success).toBe(true);
    const isolated = (await import(pathToFileURL(join(root, 'shell-command-policy.js')).href)) as {
      createShellCommandPolicy: typeof createShellCommandPolicy;
    };
    const policy = await isolated.createShellCommandPolicy({
      cwd: root,
      shellExecutable: '/bin/sh',
    });
    expect((await policy.classify('printf hello')).plainCommands).toEqual([['printf', 'hello']]);
    const grammar = policy.assets.find((asset) => asset.path.endsWith('tree-sitter-bash.wasm'))!;
    writeFileSync(grammar.path, Buffer.concat([readFileSync(grammar.path), Buffer.from([0])]));
    await expect(policy.classify('printf hello')).rejects.toMatchObject({
      code: 'shell_parser_asset_changed',
    });
    rmSync(grammar.path);
    await expect(
      isolated.createShellCommandPolicy({ cwd: root, shellExecutable: '/bin/sh' }),
    ).rejects.toMatchObject({ code: 'shell_parser_asset_unavailable' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
