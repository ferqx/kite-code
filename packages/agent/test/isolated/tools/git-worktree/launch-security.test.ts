import { expect, spyOn, test } from 'bun:test';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AuthorizationRequest, JobEvent, JobHandle } from '../../../../src/extensions';
import { isReadOnlyTaskTool } from '../../../../src/extensions/task/roles';
import * as launchIdentity from '../../../../src/jobs/launch-identity';
import { createMacosHostShellJob, createShellJob } from '../../../../src/jobs/shell';
import { hostReadOnlyTool, shellToolCapability } from '../../../../src/permissions/capabilities';
import { createShellConfiguration } from '../../../../src/permissions/shell';
import { buildWorkerCommand } from '../../../../src/tools/git-worktree/protocol';

// No worktree or unknown linkage is removed by test cleanup.
async function removeFixture(root: string) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if ((await lstat(path)).isSymbolicLink()) throw Error('unexpected_fixture_link');
    if (entry.isDirectory()) await removeFixture(path);
    else if (entry.isFile()) await unlink(path);
    else throw Error('unexpected_fixture_entry');
  }
  await rmdir(root);
}
const posix = process.platform === 'darwin' || process.platform === 'linux' ? test : test.skip;
const macos = process.platform === 'darwin' ? test : test.skip;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

for (const backend of ['legacy', 'host'] as const)
  (backend === 'host' ? macos : posix)(
    `trusted ${backend} worker output rejects malformed UTF8 and preserves a literal replacement character`,
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'kite-worktree-utf8-')));
      const workspace = join(root, 'workspace'),
        assets = join(root, 'assets'),
        control = join(root, 'control');
      const home = join(root, 'home'),
        temporaryRoot = join(root, 'temp');
      for (const path of [workspace, assets, control, home, temporaryRoot]) await mkdir(path);
      const config = join(assets, 'empty.toml'),
        worker = join(assets, 'bytes.js');
      await writeFile(config, '# Trusted empty configuration\n');
      await writeFile(
        worker,
        "process[process.argv[3]].write(Buffer.from(process.argv[2], 'hex'));\n",
      );
      const built = await Bun.build({
        entrypoints: [
          join(import.meta.dir, '../../../../src/platform/process/shell-supervisor.ts'),
        ],
        target: 'bun',
        outdir: assets,
        naming: 'shell-supervisor.js',
      });
      expect(built.success).toBe(true);
      try {
        for (const stream of ['stdout', 'stderr'] as const) {
          for (const hex of ['ff', 'e282', 'efbfbd']) {
            const command = [
              process.execPath,
              '--no-env-file',
              `--config=${config}`,
              worker,
              hex,
              stream,
            ]
              .map(quote)
              .join(' ');
            const options = {
              cwd: workspace,
              supervisorPath: join(assets, 'shell-supervisor.js'),
              bunExecutable: process.execPath,
              env: { PATH: '/usr/bin:/bin', HOME: home },
              trustedWorkerLaunch: (candidate: string) =>
                candidate === command
                  ? {
                      version: 1 as const,
                      env: { PATH: '/usr/bin:/bin', HOME: home },
                      bunFlags: ['--no-env-file', `--config=${config}`],
                      digest: 'a'.repeat(64),
                    }
                  : undefined,
            };
            const job =
              backend === 'host'
                ? createMacosHostShellJob({
                    ...options,
                    controlBase: control,
                    protectedRoots: [],
                    readonlyAssets: [assets],
                    runtimeReadOnlyRoots: [dirname(await realpath(process.execPath))],
                    temporaryRoot,
                    filesystemScope: 'workspace_write',
                  })
                : createShellJob(options);
            const handle = await job.start(
              { command },
              {
                sessionId: 'utf8',
                executionId: `${stream}-${hex}`,
                signal: new AbortController().signal,
              },
            );
            try {
              let output = '';
              let terminal: Extract<JobEvent, { type: 'terminal' }> | undefined;
              for await (const event of job.observe(handle)) {
                if (event.type === 'output') output += event.content;
                if (event.type === 'terminal') terminal = event;
              }
              expect(terminal?.supervision).toBe('ended');
              if (hex === 'efbfbd') {
                expect(terminal?.result.outcome).toBe('succeeded');
                expect(output).toBe('\uFFFD');
              } else {
                expect(terminal?.result.outcome).toBe('failed');
                expect(output).not.toContain('\uFFFD');
                expect(terminal?.result.details).toMatchObject({ groupStopped: true });
              }
            } finally {
              await job.dispose(handle);
            }
          }
        }
        const ordinaryCommand = [
          process.execPath,
          '--no-env-file',
          `--config=${config}`,
          worker,
          'ff',
          'stdout',
        ]
          .map(quote)
          .join(' ');
        const ordinaryOptions = {
          cwd: workspace,
          supervisorPath: join(assets, 'shell-supervisor.js'),
          bunExecutable: process.execPath,
          env: { PATH: '/usr/bin:/bin', HOME: home },
        };
        const ordinary =
          backend === 'host'
            ? createMacosHostShellJob({
                ...ordinaryOptions,
                controlBase: control,
                protectedRoots: [],
                readonlyAssets: [assets],
                runtimeReadOnlyRoots: [dirname(await realpath(process.execPath))],
                temporaryRoot,
                filesystemScope: 'workspace_write',
              })
            : createShellJob(ordinaryOptions);
        const ordinaryHandle = await ordinary.start(
          { command: ordinaryCommand },
          { sessionId: 'utf8', executionId: 'ordinary', signal: new AbortController().signal },
        );
        try {
          let output = '';
          let terminal: JobEvent | undefined;
          for await (const event of ordinary.observe(ordinaryHandle)) {
            if (event.type === 'output') output += event.content;
            if (event.type === 'terminal') terminal = event;
          }
          expect(terminal).toMatchObject({
            result: { outcome: 'succeeded' },
            supervision: 'ended',
          });
          expect(output).toBe('\uFFFD');
        } finally {
          await ordinary.dispose(ordinaryHandle);
        }
        expect(await readdir(control)).toEqual([]);
      } finally {
        await removeFixture(root);
      }
    },
    30000,
  );

test('multi-action worktree static capability stays conservative and roles bind exact owner/version', () => {
  expect(hostReadOnlyTool('builtin.shell', 'git.worktree')).toBe(false);
  expect(shellToolCapability('git.worktree')).toMatchObject({ safeRead: false });
  expect(
    isReadOnlyTaskTool({ extensionId: 'builtin.shell', id: 'git.worktree', version: '1' }),
  ).toBe(true);
  for (const binding of [
    { extensionId: 'custom.shell', id: 'git.worktree', version: '1' },
    { extensionId: 'builtin.shell', id: 'git.worktree', version: '2' },
  ])
    expect(isReadOnlyTaskTool(binding)).toBe(false);
});

posix(
  'trusted launch isolates the first Bun guardian and worker from preload and project configuration',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'kite-worktree-launch-'));
    let handle: Awaited<ReturnType<ReturnType<typeof createShellJob>['start']>> | undefined;
    const config = join(root, 'empty.toml');
    const worker = join(root, 'worker.js');
    const poison = join(root, 'poison.js');
    const marker = join(root, 'poison-marker');
    const supervisor = join(root, 'shell-supervisor.js');
    await writeFile(config, '# Trusted empty configuration\n');
    await writeFile(
      worker,
      'console.log(JSON.stringify({injected:process.env.KITE_ENV_POISON??null,options:process.env.BUN_OPTIONS??null}));\n',
    );
    await writeFile(poison, `await Bun.write(${JSON.stringify(marker)}, 'executed');\n`);
    await writeFile(join(root, '.env'), 'KITE_ENV_POISON=project-env\n');
    await writeFile(join(root, 'bunfig.toml'), `preload = [${JSON.stringify(poison)}]\n`);
    await writeFile(join(root, '.bunfig.toml'), `preload = [${JSON.stringify(poison)}]\n`);
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, '../../../../src/platform/process/shell-supervisor.ts')],
      target: 'bun',
      outdir: root,
      naming: 'shell-supervisor.js',
    });
    expect(built.success).toBe(true);
    const command = [process.execPath, '--no-env-file', `--config=${config}`, worker]
      .map(quote)
      .join(' ');
    const job = createShellJob({
      cwd: root,
      supervisorPath: supervisor,
      bunExecutable: process.execPath,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: root,
        BUN_OPTIONS: `--preload ${poison}`,
        NODE_OPTIONS: `--import ${poison}`,
        BASH_ENV: poison,
        ENV: poison,
      },
      trustedWorkerLaunch: (candidate) =>
        candidate === command
          ? {
              version: 1,
              env: { PATH: '/usr/bin:/bin', HOME: root },
              bunFlags: ['--no-env-file', `--config=${config}`],
              digest: 'a'.repeat(64),
            }
          : undefined,
    });
    try {
      handle = await job.start(
        { command },
        { sessionId: 'session', executionId: 'execution', signal: new AbortController().signal },
      );
      let output = '';
      let terminal: JobEvent | undefined;
      for await (const event of job.observe(handle)) {
        if (event.type === 'output' && event.stream === 'stdout') output += event.content;
        if (event.type === 'terminal') terminal = event;
      }
      expect(terminal).toMatchObject({ result: { outcome: 'succeeded' }, supervision: 'ended' });
      expect(JSON.parse(output)).toEqual({ injected: null, options: null });
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (handle) await job.dispose(handle);
      await removeFixture(root);
    }
  },
);

macos(
  'trusted profile survives the real macOS launchd guardian hop with poison excluded',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kite-worktree-launchd-')));
    const workspace = join(root, 'workspace'),
      assets = join(root, 'assets'),
      control = join(root, 'control');
    const home = join(root, 'home'),
      temporaryRoot = join(root, 'temp');
    for (const path of [workspace, assets, control, home, temporaryRoot]) await mkdir(path);
    const config = join(assets, 'empty.toml'),
      worker = join(assets, 'worker.js');
    const poison = join(workspace, 'poison.js'),
      marker = join(workspace, 'poison-marker');
    await writeFile(config, '# Trusted empty configuration\n');
    await writeFile(
      worker,
      'console.log(JSON.stringify({injected:process.env.KITE_ENV_POISON??null,options:process.env.BUN_OPTIONS??null}));\n',
    );
    await writeFile(poison, `await Bun.write(${JSON.stringify(marker)}, 'executed');\n`);
    await writeFile(join(workspace, '.env'), 'KITE_ENV_POISON=project-env\n');
    await writeFile(join(workspace, 'bunfig.toml'), `preload = [${JSON.stringify(poison)}]\n`);
    await writeFile(join(home, '.bunfig.toml'), `preload = [${JSON.stringify(poison)}]\n`);
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, '../../../../src/platform/process/shell-supervisor.ts')],
      target: 'bun',
      outdir: assets,
      naming: 'shell-supervisor.js',
    });
    expect(built.success).toBe(true);
    const command = [process.execPath, '--no-env-file', `--config=${config}`, worker]
      .map(quote)
      .join(' ');
    const job = createMacosHostShellJob({
      cwd: workspace,
      supervisorPath: join(assets, 'shell-supervisor.js'),
      bunExecutable: process.execPath,
      controlBase: control,
      protectedRoots: [],
      readonlyAssets: [assets],
      runtimeReadOnlyRoots: [dirname(await realpath(process.execPath))],
      temporaryRoot,
      filesystemScope: 'workspace_write',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        BUN_OPTIONS: `--preload ${poison}`,
        BASH_ENV: poison,
      },
      trustedWorkerLaunch: (candidate) =>
        candidate === command
          ? {
              version: 1,
              env: { PATH: '/usr/bin:/bin', HOME: home },
              bunFlags: ['--no-env-file', `--config=${config}`],
              digest: 'a'.repeat(64),
            }
          : undefined,
    });
    let handle: JobHandle | undefined;
    try {
      handle = await job.start(
        { command },
        { sessionId: 'session', executionId: 'execution', signal: new AbortController().signal },
      );
      let output = '';
      let terminal: JobEvent | undefined;
      for await (const event of job.observe(handle)) {
        if (event.type === 'output' && event.stream === 'stdout') output += event.content;
        if (event.type === 'terminal') terminal = event;
      }
      expect(terminal).toMatchObject({ result: { outcome: 'succeeded' }, supervision: 'ended' });
      expect(JSON.parse(output)).toEqual({ injected: null, options: null });
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(control)).toEqual([]);
    } finally {
      if (handle) await job.dispose(handle);
      await removeFixture(root);
    }
  },
);

macos(
  'only selected worktree registers its dependency and exact canonical list gets read-only proof',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'kite-worktree-permission-'));
    try {
      const initialized = Bun.spawnSync(['/usr/bin/git', 'init', '-q'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(initialized.exitCode).toBe(0);
      const configuration = await createShellConfiguration({
        workspaceRoot: root,
        toolIds: ['git.worktree'],
        options: {
          platform: 'darwin',
          configurationId: 'worktree-test',
          env: { PATH: '/usr/bin:/bin', HOME: root, BUN_OPTIONS: '--preload untrusted' },
          supervisorPath: join(
            import.meta.dir,
            '../../../../dist/platform/process/shell-supervisor.js',
          ),
          bunExecutable: process.execPath,
          shellExecutable: '/bin/sh',
        },
      });
      expect(configuration.snapshot.tools).toEqual([
        { id: 'git.worktree', definitionVersion: '1' },
      ]);
      if (!('assets' in configuration.snapshot)) throw Error('shell_configuration_unavailable');
      expect(configuration.snapshot.job).toEqual({ id: 'shell.command', definitionVersion: '1' });
      const request: AuthorizationRequest = {
        kind: 'tool',
        definitionId: 'git.worktree',
        definitionVersion: '1',
        sessionId: 's',
        runId: 'r',
        executionId: 'e',
        input: { action: 'list' },
        signal: new AbortController().signal,
      };
      expect(await configuration.describeRequest(request)).toMatchObject({
        safeRead: true,
        effects: ['read'],
      });
      expect(
        await configuration.describeRequest({ ...request, input: { action: 'list', path: root } }),
      ).toMatchObject({ hardAllowed: false });
      expect(
        await configuration.describeRequest({ ...request, definitionVersion: '2' }),
      ).toBeUndefined();
      const assets = configuration.snapshot.assets!.gitWorktree!;
      const fixed = assets.configuration;
      expect(fixed.git.path).not.toBe('/usr/bin/git');
      expect(fixed.git.path).not.toBe('/bin/git');
      expect((await lstat(fixed.git.path)).uid).toBe(0);
      const command = buildWorkerCommand(fixed, {
        schemaVersion: 1,
        configurationId: fixed.configurationId,
        operationToken: 'a'.repeat(64),
        phase: 'list',
        sourceCwd: fixed.sourceCwd,
        git: fixed.git,
        hooksPath: fixed.hooksPath,
        input: { action: 'list' },
      });
      const inner = {
        ...request,
        kind: 'job' as const,
        definitionId: 'shell.command',
        input: { command },
      };
      expect(await configuration.describeRequest(inner)).toMatchObject({
        safeRead: true,
        effects: ['read'],
      });
      expect(configuration.worktreeRequest(inner)).toEqual({ action: 'list', phase: 'list' });
      expect(
        (
          await configuration.describeRequest({
            ...inner,
            input: { command: `${command}; printf forged` },
          })
        )?.safeRead,
      ).not.toBe(true);
      expect(
        (
          await configuration.describeRequest({
            ...inner,
            input: { command: `BUN_OPTIONS=--preload=evil ${command}` },
          })
        )?.safeRead,
      ).not.toBe(true);
      expect(assets.profile!.envKeys).not.toContain('BUN_OPTIONS');
      expect(await configuration.commandDigest(inner)).toMatch(/^[a-f0-9]{64}$/);
      const reorderedEnvironment = await createShellConfiguration({
        workspaceRoot: root,
        toolIds: ['git.worktree'],
        options: {
          platform: 'darwin',
          configurationId: 'worktree-test',
          env: { BUN_OPTIONS: '--preload untrusted', HOME: root, PATH: '/usr/bin:/bin' },
          supervisorPath: join(
            import.meta.dir,
            '../../../../dist/platform/process/shell-supervisor.js',
          ),
          bunExecutable: process.execPath,
          shellExecutable: '/bin/sh',
        },
      });
      expect(await reorderedEnvironment.commandDigest(inner)).toBe(
        await configuration.commandDigest(inner),
      );
      const job = configuration.extensions[0]!.jobs![0]!;
      const handle = await job.start(
        { command, permissions: { filesystem: 'workspace_write', network: 'none' } },
        {
          sessionId: 's',
          executionId: 'real-list',
          signal: new AbortController().signal,
        },
      );
      try {
        let output = '';
        let terminal: JobEvent | undefined;
        for await (const event of job.observe(handle)) {
          if (event.type === 'output' && event.stream === 'stdout') output += event.content;
          if (event.type === 'terminal') terminal = event;
        }
        expect(terminal).toMatchObject({ result: { outcome: 'succeeded' }, supervision: 'ended' });
        expect(JSON.parse(output)).toMatchObject({
          phase: 'list',
          businessOutcome: 'succeeded',
          details: { cwdChanged: false },
        });
      } finally {
        await job.dispose(handle);
      }
      expect(
        await configuration.describeRequest({
          ...request,
          input: { action: 'create', key: 'no-boundary', path: join(root, 'target') },
        }),
      ).toMatchObject({ hardAllowed: false, denialReason: 'worktree_permission_denied' });
      await expect(
        job.start(
          {
            command: 'printf ordinary',
            permissions: { filesystem: 'workspace_write', network: 'none' },
          },
          {
            sessionId: 's',
            executionId: 'ordinary-invalid',
            signal: new AbortController().signal,
          },
        ),
      ).rejects.toThrow('invalid_shell_arguments');
      // Fault injection models an asset changed after the earlier approval;
      // no shared installed fixture is mutated while other tests can use it.
      const original = launchIdentity.launchIdentityAsync;
      const changed = spyOn(launchIdentity, 'launchIdentityAsync').mockImplementation(
        async (...args) => {
          const identity = await original(...args);
          return args[0] === fixed.workerPath ? { ...identity, digest: '0'.repeat(64) } : identity;
        },
      );
      try {
        expect(await configuration.describeRequest(inner)).toMatchObject({
          hardAllowed: false,
          denialReason: 'worktree_asset_changed',
        });
        await expect(
          job.start(
            { command, permissions: { filesystem: 'workspace_write', network: 'none' } },
            {
              sessionId: 's',
              executionId: 'changed-after-approval',
              signal: new AbortController().signal,
            },
          ),
        ).rejects.toThrow('worktree_asset_changed');
      } finally {
        changed.mockRestore();
      }
      const unsupported = await createShellConfiguration({
        workspaceRoot: root,
        toolIds: ['git.worktree', 'shell.execute'],
        options: {
          platform: 'darwin',
          configurationId: 'custom-zsh',
          env: { PATH: '/usr/bin:/bin', HOME: root },
          supervisorPath: join(
            import.meta.dir,
            '../../../../dist/platform/process/shell-supervisor.js',
          ),
          bunExecutable: process.execPath,
          shellExecutable: '/bin/zsh',
        },
      });
      expect(unsupported.snapshot.available).toBe(true);
      expect(await unsupported.describeRequest(request)).toMatchObject({
        hardAllowed: false,
        denialReason: 'unsupported_shell_configuration',
      });
      expect(unsupported.snapshot.tools).toContainEqual({
        id: 'shell.execute',
        definitionVersion: '1',
      });
    } finally {
      await removeFixture(root);
    }
  },
);
