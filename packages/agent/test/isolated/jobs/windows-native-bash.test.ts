import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { JobContext, JobEvent } from '../../../src/extensions';
import {
  captureInstalledWindowsGitBashRuntime,
  discoverInstalledWindowsGitBash,
} from '../../../src/jobs/windows-git-bash';
import { createWindowsShellJob } from '../../../src/jobs/windows-shell';
import { createShellConfiguration } from '../../../src/permissions/shell';

test.skipIf(process.platform !== 'win32' || process.arch !== 'x64')(
  'original Git Bash uses the accepted user scope, reports its real install, and reaps the owned Job on stop',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-original-bash-'));
    const cwd = join(root, 'workspace'),
      control = join(root, 'control'),
      stateRoot = join(root, 'state');
    for (const dir of [cwd, control, stateRoot]) mkdirSync(dir);
    const { shell } = discoverInstalledWindowsGitBash();
    const installed = await captureInstalledWindowsGitBashRuntime(shell);
    const supervisorPath = resolve(
      import.meta.dir,
      '../../../../../native/windows-sandbox-runner/target/release/kite-windows-runner.exe',
    );
    const opts = {
      kind: 'native-git-bash' as const,
      shellExecutable: shell,
      fullShellExecutable: shell,
      expectedNativeRuntimeIdentity: installed.identity,
      supervisorPath,
      cwd,
      controlBase: control,
      stateRoot,
      env: {
        SystemRoot: process.env.SystemRoot!,
        HOME: root,
        USERPROFILE: root,
        PATH: process.env.PATH!,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: 'NUL',
        GIT_TERMINAL_PROMPT: '0',
      },
    };
    const authority = await createShellConfiguration({
      workspaceRoot: cwd,
      toolIds: ['shell.launch', 'shell.execute'],
      options: {
        platform: 'win32',
        configurationId: 'original-git-bash-detached',
        env: opts.env,
        supervisorPath,
        bunExecutable: process.execPath,
        shellExecutable: shell,
        windows: { kind: 'native-git-bash', stateRoot, fullShellExecutable: shell },
        host: {
          controlBase: control,
          protectedRoots: [],
          readonlyAssets: [],
          runtimeReadOnlyRoots: [],
        },
      },
    });
    const ordinary = authority.extensions
      .flatMap((extension) => extension.tools ?? [])
      .find((tool) => tool.id === 'shell.execute')!;
    expect(ordinary.description).toContain('ordinary Windows user’s file and network access');
    expect(ordinary.description).not.toContain('Default local named pipes can deny');
    expect(ordinary.description).toContain('Kite stops remaining child processes');
    for (const mode of ['accept_edits', 'auto', 'full'] as const) {
      const decision = await authority.describeRequest(
        {
          kind: 'tool',
          definitionId: 'shell.launch',
          definitionVersion: '1',
          sessionId: 'owned',
          runId: 'detached-run',
          executionId: 'detached-input',
          signal: new AbortController().signal,
          input: {
            key: 'owned-detached',
            command: 'printf owned > detached.txt',
            cancellation: 'detached',
          },
        },
        { mode, revision: 'fixture', workspaceTrust: true, allowed: [] },
      );
      expect(decision).toMatchObject(
        mode === 'full'
          ? { hardAllowed: true, windowsNativeUserProcess: true }
          : {
              hardAllowed: false,
              denialReason: 'windows_native_detached_authorization_unavailable',
            },
      );
    }
    expect(existsSync(join(cwd, 'detached.txt'))).toBe(false);
    const context = (id: string): JobContext => ({
      executionId: id,
      sessionId: 'owned',
      signal: new AbortController().signal,
    });
    const narrow = await createWindowsShellJob({
      ...opts,
      executionScope: () => ({ filesystem: 'workspace_write', network: 'none' }),
    });
    await expect(
      narrow.start({ command: 'printf forbidden > denied.txt' }, context('narrow')),
    ).rejects.toThrow('windows_native_shell_authority_missing');
    expect(existsSync(join(cwd, 'denied.txt'))).toBe(false);
    expect(readdirSync(control)).toEqual([]);
    const native = await createWindowsShellJob({
      ...opts,
      executionScope: () => ({ filesystem: 'full_access', network: 'internet' }),
    });
    const first = await native.start(
      {
        command:
          "printf 'owned' > ../approved.txt; /usr/bin/cygpath -w /usr/bin/bash.exe; git --version",
      },
      context('approved'),
    );
    const stream: JobEvent[] = [];
    for await (const event of native.observe(first)) stream.push(event);
    await native.dispose(first);
    const stdout = stream
      .filter((x) => x.type === 'output' && x.stream === 'stdout')
      .map((x) => ('content' in x ? x.content : ''))
      .join('');
    expect(stdout.toLowerCase()).toContain(shell.toLowerCase());
    expect(stdout).toContain('git version ');
    expect(readFileSync(join(root, 'approved.txt'), 'utf8')).toBe('owned');
    expect(first.reference).toMatchObject({
      confinement: {
        backend: 'windows-native-git-bash-job',
        filesystem: 'full_access',
        network: 'internet',
      },
    });
    expect(stream.at(-1)).toMatchObject({
      type: 'terminal',
      supervision: 'ended',
      result: {
        outcome: 'succeeded',
        details: {
          cleanupConfirmed: true,
          processTreeStopped: true,
          ownedProcesses: { closed: true, job: { activeProcesses: 0 } },
        },
      },
    });
    const live = await native.start(
      { command: "printf 'started\\n'; sleep 20; printf 'late' > late.txt" },
      context('cancel'),
    );
    let stopping: ReturnType<typeof native.cancel> | undefined;
    const end: JobEvent[] = [];
    for await (const event of native.observe(live)) {
      end.push(event);
      if (
        event.type === 'output' &&
        event.stream === 'stdout' &&
        event.content.includes('started') &&
        !stopping
      )
        stopping = native.cancel(live);
    }
    expect(await stopping).toEqual({ status: 'stopped' });
    await native.dispose(live);
    expect(end.at(-1)).toMatchObject({
      type: 'terminal',
      result: {
        outcome: 'cancelled',
        details: {
          cleanupConfirmed: true,
          processTreeStopped: true,
          ownedProcesses: { closed: true, job: { activeProcesses: 0 } },
        },
      },
    });
    expect(existsSync(join(cwd, 'late.txt'))).toBe(false);
    expect(readdirSync(control)).toEqual([]);
    expect(existsSync(join(stateRoot, 'runtime'))).toBe(false);
  },
  45000,
);
