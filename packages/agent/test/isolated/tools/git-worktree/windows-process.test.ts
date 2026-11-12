import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as filesystem from 'node:fs';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../../tests/fixtures/test-filesystem';
import type { JobEvent } from '../../../../src/extensions';
import { createWindowsShellJob } from '../../../../src/jobs/windows-shell';
import { utf8 } from '../../../../src/tools/git-worktree/paths';
import { limits, shellQuote } from '../../../../src/tools/git-worktree/protocol';
import { runWindowsGitProcess } from '../../../../src/tools/git-worktree/windows-process';
import { windowsShellFixture } from '../../../fixtures/windows-shell-runtime';

const windows = process.platform === 'win32' ? test : test.skip;
const environment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        [
          'SYSTEMROOT',
          'WINDIR',
          'USERPROFILE',
          'HOME',
          'HOMEDRIVE',
          'HOMEPATH',
          'TEMP',
          'TMP',
          'PATH',
        ].includes(entry[0].toUpperCase()),
    ),
  );
const run = (
  cwd: string,
  code: string,
  extra: Parameters<typeof runWindowsGitProcess>[2] = { cwd, env: environment() },
) =>
  runWindowsGitProcess(process.execPath, ['--no-env-file', '-e', code], {
    ...extra,
    cwd,
    env: environment(),
  });

windows(
  'file-backed Git capture preserves binary output, separate diagnostics, stdin and borrowed input descriptors',
  async () => {
    const root = temporaryDirectory('kite-worktree-stdio-');
    let input: number | undefined;
    try {
      const path = join(root, 'input');
      writeFileSync(path, '输入\0with spaces');
      input = openSync(path, 'r');
      const result = await run(
        root,
        "const fs=require('node:fs');fs.writeSync(1,fs.readFileSync(0));fs.writeSync(2,Buffer.from([255,0,65]));",
        { cwd: root, env: environment(), inputFd: input },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toEqual(Buffer.from('输入\0with spaces'));
      expect(result.stderr).toEqual(Buffer.from([255, 0, 65]));
      expect(() => utf8(result.stderr)).toThrow('Git or filesystem data is not lossless UTF-8');
      expect(fstatSync(input).isFile()).toBe(true);
      const text = await run(
        root,
        "require('node:fs').writeSync(1,require('node:fs').readFileSync(0));",
        { cwd: root, env: environment(), input: 'literal\n输入' },
      );
      expect(utf8(text.stdout)).toBe('literal\n输入');
    } finally {
      if (input !== undefined) closeSync(input);
      removeTemporaryDirectory(root);
    }
  },
);

windows(
  'file-backed Git capture hashes only complete exact output and rejects stdout/stderr overflow',
  async () => {
    const root = temporaryDirectory('kite-worktree-budgets-');
    const scratchRoots: string[] = [];
    const original = filesystem.mkdtempSync;
    const creating = spyOn(filesystem, 'mkdtempSync').mockImplementation(((
      ...args: Parameters<typeof original>
    ) => {
      const path = original(...args);
      if (typeof path === 'string' && path.includes('kite-worktree-git-')) scratchRoots.push(path);
      return path;
    }) as typeof original);
    try {
      const payload = 'content雪';
      const prefix = `blob ${Buffer.byteLength(payload)}\0`;
      const outputHash = {
        algorithm: 'sha1' as const,
        prefix,
        bytes: BigInt(Buffer.byteLength(payload)),
      };
      const result = await run(
        root,
        `require('node:fs').writeSync(1,${JSON.stringify(payload)});`,
        { cwd: root, env: environment(), outputHash },
      );
      expect(result.stdout).toEqual(Buffer.alloc(0));
      expect(result.stdoutHash).toBe(
        createHash('sha1').update(prefix).update(payload).digest('hex'),
      );
      const short = await run(root, "require('node:fs').writeSync(1,'x');", {
        cwd: root,
        env: environment(),
        outputHash,
      });
      expect(short.stdoutHash).toBeUndefined();
      await expect(
        run(root, "require('node:fs').writeSync(1,Buffer.alloc(100));", {
          cwd: root,
          env: environment(),
          outputHash,
        }),
      ).rejects.toThrow('inspection_limit');
      for (const [fd, bytes] of [
        [1, limits.gitStdoutBytes + 1],
        [2, limits.gitStderrBytes + 1],
      ])
        await expect(
          run(root, `require('node:fs').writeSync(${fd},Buffer.alloc(${bytes}));`),
        ).rejects.toThrow('inspection_limit');
      await expect(
        runWindowsGitProcess(join(root, 'missing.exe'), [], { cwd: root, env: environment() }),
      ).rejects.toMatchObject({
        code: 'git_process_start_failed',
        facts: { failure: { category: 'process_start', errno: 'ENOENT' } },
      });
      await expect(
        run(
          root,
          "const fs=require('node:fs');fs.writeSync(1,Buffer.alloc(100));setTimeout(()=>fs.ftruncateSync(1,0),50);",
        ),
      ).rejects.toThrow('inspection_limit');
      expect(scratchRoots.length).toBeGreaterThan(0);
      expect(scratchRoots.every((path) => !existsSync(path))).toBe(true);
    } finally {
      creating.mockRestore();
      removeTemporaryDirectory(root);
    }
  },
);

windows(
  'real write-restricted Windows Job captures Git without pipes and cancels its attached subprocess with private temp cleanup',
  async () => {
    const root = temporaryDirectory('kite-worktree-native-stdio-');
    const workspace = join(root, 'workspace'),
      control = join(root, 'control');
    mkdirSync(workspace);
    mkdirSync(control);
    const runtime = await windowsShellFixture();
    const config = join(root, 'empty.toml');
    writeFileSync(config, '# empty\n');
    const gitPath = join(dirname(runtime.fullShell), '../../mingw64/bin/git.exe');
    const sha = createHash('sha256').update(readFileSync(gitPath)).digest('hex');
    const gitModule = pathToFileURL(
      join(import.meta.dir, '../../../../src/tools/git-worktree/git.ts'),
    ).href;
    const processModule = pathToFileURL(
      join(import.meta.dir, '../../../../src/tools/git-worktree/windows-process.ts'),
    ).href;
    const hooks = join(root, 'hooks');
    mkdirSync(hooks);
    const probe = join(root, 'probe.ts');
    try {
      for (const cancel of [false, true]) {
        writeFileSync(
          probe,
          cancel
            ? `import {runWindowsGitProcess} from ${JSON.stringify(processModule)};console.log('attached');await runWindowsGitProcess(process.execPath,['--no-env-file','-e','setInterval(()=>{},1000)'],{cwd:process.cwd(),env:process.env});`
            : `import {Git} from ${JSON.stringify(gitModule)};const git=new Git(${JSON.stringify(gitPath)},${JSON.stringify(sha)},${JSON.stringify(hooks)});const result=await git.run(process.cwd(),['--version']);console.log(JSON.stringify({exitCode:result.exitCode,stdout:result.stdout.toString(),stderr:result.stderr.toString()}));`,
        );
        const command = [process.execPath, '--no-env-file', `--config=${config}`, probe]
          .map(shellQuote)
          .join(' ');
        const env = environment();
        const job = await createWindowsShellJob({
          cwd: workspace,
          env,
          controlBase: control,
          supervisorPath: runtime.runner,
          shellExecutable: runtime.shell,
          fullShellExecutable: runtime.fullShell,
          stateRoot: runtime.stateRoot,
          executionScope: () => ({ filesystem: 'workspace_write', network: 'none' }),
          trustedWorkerLaunch: (candidate) =>
            candidate === command
              ? {
                  version: 1,
                  env,
                  bunFlags: ['--no-env-file', `--config=${config}`],
                  digest: 'a'.repeat(64),
                }
              : undefined,
        });
        const handle = await job.start(
          { command },
          {
            sessionId: 'stdio',
            executionId: cancel ? 'cancel' : 'version',
            signal: new AbortController().signal,
          },
        );
        let output = '',
          terminal: Extract<JobEvent, { type: 'terminal' }> | undefined,
          stopping: Promise<unknown> | undefined;
        try {
          for await (const event of job.observe(handle)) {
            if (event.type === 'output') {
              output += event.content;
              if (cancel && output.includes('attached') && !stopping) stopping = job.cancel(handle);
            }
            if (event.type === 'terminal') terminal = event;
          }
          await stopping;
          expect(terminal?.supervision).toBe('ended');
          expect(terminal?.result.details).toMatchObject({
            cleanupConfirmed: true,
            processTreeStopped: true,
          });
          if (cancel) expect(terminal?.result.outcome).toBe('cancelled');
          else {
            expect(terminal?.result.outcome, output).toBe('succeeded');
            expect(JSON.parse(output)).toMatchObject({
              exitCode: 0,
              stdout: expect.stringContaining('git version'),
              stderr: '',
            });
          }
        } finally {
          await job.dispose(handle);
        }
        expect(readdirSync(control)).toEqual([]);
        expect(existsSync(join(root, 'outside'))).toBe(false);
      }
    } finally {
      removeTemporaryDirectory(root);
    }
  },
  60000,
);
