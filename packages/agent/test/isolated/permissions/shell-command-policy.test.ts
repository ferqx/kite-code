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
import { withBundledRipgrep } from '@kite-ai/agent/jobs/shell';
import { createShellCommandPolicy, readOnlySearchCommand } from '@kite-ai/agent/permissions/shell';

test('literal search uses bundled rg through Bash with quoted arguments and no ambient rg configuration', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-shell-search-')));
  const shell =
    process.platform === 'win32'
      ? realpathSync.native(join(dirname(dirname(Bun.which('git')!)), 'usr/bin/bash.exe'))
      : '/bin/bash';
  try {
    const directory = join(root, '目录 space');
    mkdirSync(directory);
    const needle = "needle'; printf unexpected > marker; #";
    writeFileSync(join(directory, '条目.txt'), `${needle}\n`);
    const configuration = join(root, 'rg-config');
    writeFileSync(configuration, '--glob=*.unmatchable\n');
    const policy = await createShellCommandPolicy({ cwd: root, shellExecutable: shell });
    const classified = await policy.classify(`rg -n -F "${needle}" "目录 space/条目.txt"`);
    const command = readOnlySearchCommand(classified, shell);
    expect(classified.hardDenied).toBeNull();
    expect(command).toBeDefined();
    const { env } = withBundledRipgrep({
      SystemRoot: process.env.SystemRoot ?? '',
      PATH: '',
      RIPGREP_CONFIG_PATH: configuration,
    });
    const child = Bun.spawn([shell, '--noprofile', '--norc', '-c', command!], {
      cwd: root,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exit, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, error).toBe(0);
    expect(output).toBe(`1:${needle}\n`);
    expect(() => readFileSync(join(root, 'marker'))).toThrow();
    for (const candidate of [
      'rg --pre=helper pattern .',
      'rg --pr helper pattern .',
      'rg --hostname-b helper pattern .',
      'rg --hostna helper pattern .',
      'rg pattern . > output',
      'rg pattern . | cat',
      'env rg pattern .',
      'rg "$(printf pattern)" .',
    ]) {
      const parsed = await policy.classify(candidate);
      expect(readOnlySearchCommand(parsed, shell), candidate).toBeUndefined();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rg consumes option values before recognizing an option terminator', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-shell-rg-argv-')));
  const shell =
    process.platform === 'win32'
      ? realpathSync.native(join(dirname(dirname(Bun.which('git')!)), 'usr/bin/bash.exe'))
      : '/bin/bash';
  try {
    const policy = await createShellCommandPolicy({ cwd: root, shellExecutable: shell });
    writeFileSync(join(root, 'input.txt'), '--\n');
    writeFileSync(join(root, '--'), '--\n');
    for (const name of ['--pre', '--hostname-bin', '--search-zip'])
      writeFileSync(join(root, name), '--\n');
    for (const candidate of [
      'rg -n -F -e -- input.txt',
      'rg -nF --regexp -- input.txt',
      'rg -nFe -- input.txt',
      'rg -nFe-- input.txt',
      'rg -nF --regexp=-- input.txt',
      'rg -nF -f -- input.txt',
      'rg -nF -r -- -e -- input.txt',
      'rg -nF -e -- -- --pre',
      'rg -nF -e -- -- --hostname-bin',
      'rg -nF -e -- -- --search-zip',
      'rg -nF -- --pre',
      "rg -nF '--pre-glob=*.txt' -e -- input.txt",
      'rg --pretty --no-heading --no-column --color never -nF -e -- input.txt',
      'rg -nF --no-search-zip -e -- input.txt',
      'rg -nF --no-pre -e -- input.txt',
      'rg -nF --no-heading --color never -e -- input.txt',
    ]) {
      const parsed = await policy.classify(candidate);
      const command = readOnlySearchCommand(parsed, shell);
      expect(parsed.hardDenied, candidate).toBeNull();
      expect(command, candidate).toBeDefined();
      const child = Bun.spawn([shell, '--noprofile', '--norc', '-c', command!], {
        cwd: root,
        env: { SystemRoot: process.env.SystemRoot ?? '', PATH: '' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exit, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      // The bare terminator leaves --pre as a literal pattern, not an execution hook.
      expect(exit, `${candidate}: ${error}`).toBe(candidate === 'rg -nF -- --pre' ? 1 : 0);
      expect(output, candidate).toBe(candidate === 'rg -nF -- --pre' ? '' : '1:--\n');
    }
    for (const candidate of [
      'rg -e -- --pre helper input.txt',
      'rg --regexp -- --pre=helper input.txt',
      'rg -ne -- --pre helper input.txt',
      'rg -ne-- --pre helper input.txt',
      'rg --regexp=-- --pre helper input.txt',
      'rg -f -- --pre helper input.txt',
      'rg -g -- --pre helper input.txt',
      'rg --glob -- --pre helper input.txt',
      'rg --pre-glob -- --pre helper input.txt',
      'rg -r -- --pre helper input.txt',
      'rg --replace -- --hostname-bin helper input.txt',
      'rg -e -- --hostname-bin=helper input.txt',
      'rg -e -- --pr helper input.txt',
      'rg -e -- --hostna helper input.txt',
      'rg --reg -- --pre helper input.txt',
      'rg --unknown -- --pre helper input.txt',
      'rg -e -- --search-zip input.txt',
      'rg -e -- -nz input.txt',
      'rg -z -e -- input.txt',
      'rg --search-zip -e -- input.txt',
      'rg -e',
      'rg --regexp',
    ]) {
      const parsed = await policy.classify(candidate);
      expect(parsed.plainCommands, candidate).not.toBeNull();
      expect(parsed.hardDenied, candidate).toBeNull();
      expect(readOnlySearchCommand(parsed, shell), candidate).toBeUndefined();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('literal read-only && chains rewrite every leaf and preserve failure short-circuiting', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-shell-search-chain-')));
  const shell =
    process.platform === 'win32'
      ? realpathSync.native(join(dirname(dirname(Bun.which('git')!)), 'usr/bin/bash.exe'))
      : '/bin/bash';
  try {
    const policy = await createShellCommandPolicy({ cwd: root, shellExecutable: shell });
    writeFileSync(join(root, 'input.txt'), 'needle\n');
    const configuration = join(root, 'rg-config');
    writeFileSync(configuration, '--glob=*.unmatchable\n');
    const run = async (source: string) => {
      const classification = await policy.classify(source);
      const command = readOnlySearchCommand(classification, shell);
      expect(command, source).toBeDefined();
      const child = Bun.spawn([shell, '--noprofile', '--norc', '-c', command!], {
        cwd: root,
        env: {
          SystemRoot: process.env.SystemRoot ?? '',
          PATH: '',
          RIPGREP_CONFIG_PATH: configuration,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exit, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { command: command!, exit, output, error };
    };
    const success = await run('pwd && ls input.txt && rg -n needle input.txt');
    expect(success.exit, success.error).toBe(0);
    expect(success.output).toBe(`${root.replaceAll('\\', '/')}\ninput.txt\n1:needle\n`);
    expect(success.command).toContain('--no-config');
    const failure = await run('rg absent input.txt && pwd && rg needle input.txt');
    expect(failure.exit).toBe(1);
    expect(failure.output).toBe('');
    expect(failure.command.match(/--no-config/g)).toHaveLength(2);
    for (const source of [
      'pwd || ls',
      'pwd; ls',
      'pwd\nls',
      'pwd | ls',
      'pwd && ls;',
      'pwd && (ls)',
      'pwd && VAR=x ls',
      'pwd && ls > output',
      'pwd && ls "$DIRECTORY"',
      'pwd && rg "$(pwd)" .',
      'pwd && rg --pre=helper needle .',
      'pwd && rg --search-zip needle .',
      'pwd && printf tail',
      'pwd && sh script.sh',
      'pwd && ls && unknown',
    ]) {
      expect(readOnlySearchCommand(await policy.classify(source), shell), source).toBeUndefined();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'bundled rg executes hooks and decompressors after a consumed -- value without receiving read-only qualification',
  async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-shell-rg-hooks-')));
    try {
      const policy = await createShellCommandPolicy({ cwd: root, shellExecutable: '/bin/bash' });
      const helper = join(root, 'helper');
      const script = '#!/bin/sh\nprintf called >> marker\nprintf "%s\\n" "--"\n';
      writeFileSync(helper, script, { mode: 0o700 });
      writeFileSync(join(root, 'gzip'), script, { mode: 0o700 });
      writeFileSync(join(root, 'input.txt'), '--\n');
      writeFileSync(join(root, 'input.gz'), new Uint8Array([0x1f, 0x8b, 0x08, 0]));
      const { executable, env } = withBundledRipgrep({ PATH: root });
      let calls = 0;
      for (const args of [
        ['-e', '--', '--pre', helper, 'input.txt'],
        ['--regexp', '--', `--pre=${helper}`, 'input.txt'],
        [
          '-ne',
          '--',
          '--hostname-bin',
          helper,
          '--hyperlink-format=file://{host}{path}',
          '--color=always',
          '-H',
          'input.txt',
        ],
        ['-e', '--', '-z', 'input.gz'],
        ['-e', '--', '--search-zip', 'input.gz'],
      ]) {
        const command = ['rg', ...args].map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
        const parsed = await policy.classify(command);
        expect(parsed.plainCommands, command).toEqual([['rg', ...args]]);
        expect(parsed.hardDenied, command).toBeNull();
        expect(readOnlySearchCommand(parsed, '/bin/bash'), command).toBeUndefined();
        // Execute only our own temporary fixture to verify the hidden option really can spawn.
        const child = Bun.spawn([executable, '--no-config', ...args], {
          cwd: root,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [exit, output, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exit, `${command}: ${error}`).toBe(0);
        expect(output, command).toContain('--');
        expect(readFileSync(join(root, 'marker'), 'utf8'), command).toBe('called'.repeat(++calls));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

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
    readOnlyCommands: null,
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
    readOnlyCommands: null,
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
    readOnlyCommands: null,
    hardDenied: null,
  });
});

test('retains Windows drive and UNC path semantics independently of the test host', async () => {
  for (const cwd of ['C:/workspace/deep', 'C:\\workspace\\deep']) {
    const policy = await createShellCommandPolicy({ cwd, shellExecutable: '/bin/bash' });
    expect((await policy.classify('rm -rf ../../Windows/System32')).hardDenied).toBe(
      'shell_critical_system_removal',
    );
    expect((await policy.classify('git -C ../../Windows clean -fdx')).hardDenied).toBe(
      'shell_critical_system_git_destruction',
    );
    expect((await policy.classify('rm -rf ./build')).hardDenied).toBeNull();
  }
  const policy = await createShellCommandPolicy({
    cwd: '\\\\server\\share\\workspace',
    shellExecutable: '/bin/bash',
  });
  expect((await policy.classify('rm -rf ./build')).hardDenied).toBeNull();
  expect((await policy.classify("rm -rf 'C:/Windows/System32'")).hardDenied).toBe(
    'shell_critical_system_removal',
  );
});

test('retains POSIX critical-system denial for ambiguous double-slash paths', async () => {
  for (const cwd of ['/tmp/kite-workspace', '//tmp/kite-workspace']) {
    const policy = await createShellCommandPolicy({ cwd, shellExecutable: '/bin/bash' });
    for (const command of ['rm -f //etc/hosts', 'cd //etc; rm -f ./hosts'])
      expect((await policy.classify(command)).hardDenied).toBe('shell_critical_system_removal');
    expect((await policy.classify('git -C //etc clean -fdx')).hardDenied).toBe(
      'shell_critical_system_git_destruction',
    );
  }
  const policy = await createShellCommandPolicy({ cwd: '//etc', shellExecutable: '/bin/bash' });
  expect((await policy.classify('rm -f ./hosts')).hardDenied).toBe('shell_critical_system_removal');
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
      realpathSync(fileURLToPath(new URL('../../../', import.meta.url))),
      join(modules, '@kite-ai/agent'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const result = await Bun.build({
      entrypoints: [
        fileURLToPath(new URL('../../../src/permissions/shell-command-policy.ts', import.meta.url)),
      ],
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
