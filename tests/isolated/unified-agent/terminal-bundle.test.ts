import { expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { ProfileBackup, ProfileRestoreResult } from '@kite-ai/agent/maintenance';

const repositoryRoot = resolve(import.meta.dir, '../../..');
function verifyLocalLinks(root: string) {
  let links = 0;
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = realpathSync(path);
        expect(relative(root, target)).not.toMatch(/^\.\.(?:\/|$)/);
        expect(target).not.toContain(repositoryRoot);
        links++;
      } else if (stat.isDirectory()) visit(path);
    }
  };
  visit(root);
  return links;
}
async function execute(argv: string[], cwd: string, home: string) {
  const child = Bun.spawn(argv, {
    cwd,
    env: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}

test('sealed terminal bundle remains independent after archive relocation and temporary installation', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-terminal-bundle-')));
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(join(home, '.kite-code'), { mode: 0o700 });
  const legacy = join(home, '.kite-code', 'kite-code.jsonc');
  writeFileSync(legacy, 'LEGACY_PROFILE_MUST_NOT_BE_READ', { mode: 0o600 });
  try {
    // Build/install are production APIs; runtime children below receive neither source imports nor NODE_PATH.
    const {
      buildTerminalBundle,
      installTerminalBundle,
      rollbackTerminalBundle,
      uninstallTerminalBundle,
    } = await import('../../../scripts/release/terminal-bundle');
    const output = join(root, 'output');
    const { verifyTerminalBundle } = await import('../../../apps/cli/host/terminal-artifact');
    const reuse = process.env.KITE_TERMINAL_REUSE_VERIFIED_BUNDLE;
    const built = reuse
      ? verifyTerminalBundle(reuse)
      : await buildTerminalBundle({
          destination: output,
          repositoryRoot,
          bunExecutable: process.execPath,
        });
    expect(built.root).toBe(reuse ? realpathSync(reuse) : output);
    expect(built.candidateId).toBeTruthy();
    const { packTerminalBundle, unpackTerminalBundle } = await import(
      '../../../scripts/release/terminal-archive'
    );
    const archive = await packTerminalBundle({
      bundleRoot: built.root,
      archivePath: join(root, 'terminal.tar.gz'),
    });
    expect(archive.candidateId).toBe(built.candidateId);
    const relocated = join(root, 'relocated');
    const unpacked = await unpackTerminalBundle({
      archivePath: archive.archivePath,
      sha256: archive.sha256,
      destination: relocated,
    });
    expect(unpacked.candidateId).toBe(built.candidateId);
    rmSync(output, { recursive: true, force: true });
    expect(existsSync(output)).toBe(false);
    verifyLocalLinks(relocated);
    const prefix = join(root, 'prefix');
    const installed = await installTerminalBundle({ bundleRoot: relocated, prefix });
    const cli = join(prefix, 'bin', 'kite'),
      tui = join(prefix, 'bin', 'kite-tui');
    for (const executable of [cli, tui]) {
      const help = await execute([executable, '--help'], home, home);
      if (help.code) console.error(executable, help.stdout, help.stderr);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain('--workspace');
      const version = await execute([executable, '--version'], home, home);
      expect(version.code).toBe(0);
      expect(version.stdout).toContain('0.1.0');
    }
    const candidate = installed.releaseRoot;
    verifyLocalLinks(candidate);
    const runtime = join(candidate, built.manifest.entries.runtime);
    expect((await execute([runtime, '--version'], home, home)).stdout.trim()).toBe(
      built.manifest.bunVersion,
    );
    for (const asset of [
      'storage/worker/main.js',
      'storage/migrations/0001-baseline.sql',
      'platform/process/shell-supervisor.js',
      'mcp/stdio-guardian.js',
      'tools/web-fetch/extractor-worker.js',
    ])
      expect(existsSync(join(candidate, 'node_modules/@kite-ai/agent', asset))).toBe(true);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    const dataRoot = join(home, '.kite-code', 'unified-agent');
    const setup = join(home, 'setup.mjs');
    writeFileSync(
      setup,
      `import {selectProfile} from ${JSON.stringify(join(candidate, 'node_modules/@kite-ai/agent/profile.js'))};import {mkdirSync} from 'node:fs';const p=selectProfile({dataRoot:${JSON.stringify(dataRoot)},profile:'default'});mkdirSync(p.profilePath,{recursive:true,mode:0o700});console.log(JSON.stringify(p));`,
    );
    const setupResult = await execute([runtime, setup], workspace, home);
    expect(setupResult.code).toBe(0);
    const profile = JSON.parse(setupResult.stdout) as { profilePath: string; databasePath: string };
    let providerCalls = 0;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { messages: unknown[] };
        expect(JSON.stringify(body.messages)).toContain('sealed terminal task');
        providerCalls++;
        const frame = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'bundle', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(
          frame({ content: 'SEALED BUNDLE MODEL BODY' }, null) +
            frame({}, 'stop') +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const socket = join(root, 'owned.sock');
    let daemonStarted = false;
    try {
      writeFileSync(
        join(profile.profilePath, 'config.jsonc'),
        JSON.stringify({
          modelId: 'fixed',
          models: [
            {
              id: 'fixed',
              provider: 'compatible',
              model: 'fixed',
              baseURL: `${provider.url.href}v1`,
            },
          ],
        }),
        { mode: 0o600 },
      );
      const task = await execute(
        [
          cli,
          'run',
          '--thread',
          'bundle-session',
          '--task',
          'sealed terminal task',
          '--workspace',
          workspace,
          '--trust-workspace',
          '--full',
        ],
        workspace,
        home,
      );
      if (task.code) console.error(task.stdout, task.stderr);
      expect(task.code).toBe(0);
      expect(task.stdout).toContain('SEALED BUNDLE MODEL BODY');
      expect(providerCalls).toBe(1);
      const read = join(home, 'read.mjs');
      writeFileSync(
        read,
        `import {openSqliteStore} from ${JSON.stringify(join(candidate, 'node_modules/@kite-ai/agent/sqlite.js'))};const s=await openSqliteStore({dataRoot:${JSON.stringify(dataRoot)},profile:'default',mode:'readonly'});try{const session=await s.getSession('bundle-session');const messages=await s.listMessages('bundle-session');const executions=await s.listExecutions('bundle-session');console.log(JSON.stringify({session,messages,executions}));}finally{await s.close();}`,
      );
      const history = await execute([runtime, read], workspace, home);
      expect(history.code).toBe(0);
      expect(history.stdout).toContain('SEALED BUNDLE MODEL BODY');
      const saved = JSON.parse(history.stdout) as {
        session: { id: string };
        executions: { kind: string }[];
      };
      expect(saved.session.id).toBe('bundle-session');
      expect(saved.executions).toHaveLength(1);
      expect(saved.executions[0]?.kind).toBe('model');
      expect(providerCalls).toBe(1);
      const started = await execute(
        [cli, 'server', 'start', '--server', socket, '--workspace', workspace],
        workspace,
        home,
      );
      if (started.code) console.error(started.stdout, started.stderr);
      expect(started.code).toBe(0);
      daemonStarted = true;
      const identity = JSON.parse(started.stdout) as { instanceId: string; state: string };
      expect(identity.state).toBe('accepting');
      const status = await execute([cli, 'server', 'status', '--server', socket], workspace, home);
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout).instanceId).toBe(identity.instanceId);
      const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(tui)},'--thread','bundle-session','--workspace',${JSON.stringify(workspace)},'--server',${JSON.stringify(socket)}],env={'PATH':'/usr/bin:/bin','HOME':${JSON.stringify(home)},'LANG':'C.UTF-8','TERM':'xterm-256color'},stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);buffer=b''
try:
 end=time.monotonic()+10
 while 'SEALED BUNDLE MODEL BODY' not in re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace')):
  if time.monotonic()>end:raise RuntimeError('bundle TUI deadline '+buffer[-4000:].decode(errors='replace'))
  if select.select([master],[],[],.05)[0]:buffer+=os.read(master,65536)
 os.write(master,b'\\x11');end=time.monotonic()+5
 while p.poll() is None and time.monotonic()<end:
  if select.select([master],[],[],.05)[0]:
   try:os.read(master,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0;print('BUNDLE_PTY_COMPLETE')
finally:
 if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(master)
`;
      const pty = await execute(['/usr/bin/python3', '-c', program], workspace, home);
      if (pty.code) console.error(pty.stdout, pty.stderr);
      expect(pty.code).toBe(0);
      expect(pty.stdout).toContain('BUNDLE_PTY_COMPLETE');
      const after = await execute([cli, 'server', 'status', '--server', socket], workspace, home);
      expect(JSON.parse(after.stdout).instanceId).toBe(identity.instanceId);
      expect(providerCalls).toBe(1);
      const refusesUninstall = () => {
        let code: string | undefined;
        try {
          uninstallTerminalBundle(prefix);
        } catch (error) {
          code = (error as { code?: string }).code;
        }
        expect(code).toBe('owner_busy');
        expect(existsSync(cli)).toBe(true);
      };
      refusesUninstall();
      const upgrade = join(root, 'upgrade');
      cpSync(relocated, upgrade, { recursive: true, dereference: false, verbatimSymlinks: true });
      const manifestPath = join(upgrade, 'terminal-manifest.json');
      const upgradedManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        productVersion: string;
      };
      upgradedManifest.productVersion = '0.1.1';
      writeFileSync(manifestPath, JSON.stringify(upgradedManifest));
      const qualifiedUpgrade = verifyTerminalBundle(upgrade);
      expect(qualifiedUpgrade.candidateId).not.toBe(built.candidateId);
      const upgraded = await installTerminalBundle({ bundleRoot: upgrade, prefix });
      expect(upgraded.previousCandidateId).toBe(built.candidateId);
      expect(readFileSync(join(prefix, 'active'), 'utf8').split('\n')[0]).toBe(
        qualifiedUpgrade.candidateId,
      );
      const upgradedStatus = await execute(
        [cli, 'server', 'status', '--server', socket],
        workspace,
        home,
      );
      expect(upgradedStatus.code).toBe(0);
      expect(JSON.parse(upgradedStatus.stdout)).toMatchObject({
        instanceId: identity.instanceId,
        runningBuildId: built.buildId,
      });
      expect(existsSync(candidate)).toBe(true);
      refusesUninstall();
      const rolledBack = rollbackTerminalBundle(prefix);
      expect(rolledBack.candidateId).toBe(built.candidateId);
      expect(rolledBack.previousCandidateId).toBe(qualifiedUpgrade.candidateId);
      expect(readFileSync(join(prefix, 'active'), 'utf8').split('\n')[0]).toBe(built.candidateId);
      const rollbackStatus = await execute(
        [cli, 'server', 'status', '--server', socket],
        workspace,
        home,
      );
      expect(JSON.parse(rollbackStatus.stdout).instanceId).toBe(identity.instanceId);
      refusesUninstall();
      expect(
        (
          await execute(
            [
              runtime,
              join(candidate, built.manifest.entries.cli),
              'server',
              'stop',
              '--server',
              socket,
            ],
            workspace,
            home,
          )
        ).code,
      ).toBe(0);
      daemonStarted = false;
      expect(
        JSON.parse(
          (await execute([cli, 'server', 'status', '--server', socket], workspace, home)).stdout,
        ).state,
      ).toBe('absent');
      const worker = join(candidate, 'node_modules/@kite-ai/agent/storage/worker/main.js');
      renameSync(worker, `${worker}.saved`);
      try {
        const denied = await execute(
          [cli, 'run', '--execution-status', '--workspace', workspace],
          workspace,
          home,
        );
        expect(denied.code).not.toBe(0);
        expect(denied.stderr).toContain('terminal_');
        expect(providerCalls).toBe(1);
      } finally {
        renameSync(`${worker}.saved`, worker);
      }
      const dependency = built.manifest.files.find(
        (file) =>
          file.path.startsWith('node_modules/') &&
          !file.path.startsWith('node_modules/@kite-ai/') &&
          file.path.endsWith('.js'),
      );
      expect(dependency).toBeDefined();
      const dependencyPath = join(candidate, dependency!.path),
        bytes = readFileSync(dependencyPath);
      writeFileSync(dependencyPath, Buffer.concat([bytes, Buffer.from('\n/* altered */\n')]));
      try {
        const denied = await execute(
          [cli, 'run', '--execution-status', '--workspace', workspace],
          workspace,
          home,
        );
        expect(denied.code).not.toBe(0);
        expect(denied.stderr).toContain('terminal_');
        expect(providerCalls).toBe(1);
      } finally {
        writeFileSync(dependencyPath, bytes);
      }
      if (process.platform === 'linux') {
        const readerRoot = join(home, 'engine-reader');
        const reader = await Bun.build({
          entrypoints: [
            join(repositoryRoot, 'tests/fixtures/unified-agent/terminal-bundle-store.ts'),
          ],
          target: 'bun',
          packages: 'external',
          outdir: readerRoot,
          naming: 'read.js',
        });
        expect(reader.success).toBe(true);
        symlinkSync(join(candidate, 'node_modules'), join(readerRoot, 'node_modules'), 'dir');
        const inspect = async (mode: 'prepare' | 'cold') => {
          const value = await execute(
            [runtime, join(readerRoot, 'read.js'), mode, dataRoot, workspace],
            workspace,
            home,
          );
          if (value.code) console.error(value.stdout, value.stderr);
          expect(value.code).toBe(0);
          return JSON.parse(value.stdout) as {
            storeId: string;
            engine: { qualification: string; linkage: string; version: string; sourceId: string };
            workspaces: string[];
            session: { id: string; ownerGeneration: string; ownerInstanceId: string | null };
            messages: unknown[];
            executions: unknown[];
          };
        };
        const before = await inspect('prepare');
        expect(before.engine).toMatchObject({
          qualification: 'selected',
          linkage: built.manifest.sqlite.linkage,
          version: built.manifest.sqlite.version,
          sourceId: built.manifest.sqlite.sourceId,
        });
        expect(before.workspaces.filter((id) => id.startsWith('bundle-wal-'))).toHaveLength(24);
        expect(before.session.id).toBe('bundle-session');
        expect(before.executions).toHaveLength(1);
        const database = readFileSync(profile.databasePath);
        const configuration = readFileSync(join(profile.profilePath, 'config.jsonc'));
        const scope = ['--data-root', dataRoot, '--profile', 'default'];
        const backup = await execute(
          [cli, 'maintenance', 'backup', ...scope, '--destination', join(root, 'backups')],
          workspace,
          home,
        );
        if (backup.code) console.error(backup.stdout, backup.stderr);
        expect(backup.code).toBe(0);
        const selected = (JSON.parse(backup.stdout) as { backup: ProfileBackup }).backup;
        expect(selected.manifest.source.storeId).toBe(before.storeId);
        expect(selected.manifest.engine.version).toBe(before.engine.version);
        expect(selected.manifest.engine.sourceId).toBe(before.engine.sourceId);
        expect(readFileSync(profile.databasePath)).toEqual(database);
        const checked = await execute(
          [cli, 'maintenance', 'inspect', selected.directory],
          workspace,
          home,
        );
        expect(checked.code).toBe(0);
        expect(JSON.parse(checked.stdout).backup.manifest).toEqual(selected.manifest);
        expect(readFileSync(profile.databasePath)).toEqual(database);
        const restore = await execute(
          [
            cli,
            'maintenance',
            'restore',
            selected.directory,
            ...scope,
            '--expected-store',
            before.storeId,
            '--confirm-data-loss',
          ],
          workspace,
          home,
        );
        if (restore.code) console.error(restore.stdout, restore.stderr);
        expect(restore.code).toBe(0);
        const receipt = JSON.parse(restore.stdout) as ProfileRestoreResult;
        expect(receipt.outcome).toBe('restored');
        const cold = await inspect('cold');
        expect(cold.storeId).toBe(receipt.storeId);
        expect(cold.storeId).not.toBe(before.storeId);
        expect(cold.engine).toEqual(before.engine);
        expect(cold.workspaces).toEqual(before.workspaces);
        expect(cold.session).toEqual({
          ...before.session,
          ownerGeneration: (BigInt(before.session.ownerGeneration) + 1n).toString(),
          ownerInstanceId: null,
        });
        expect(cold.messages).toEqual(before.messages);
        expect(cold.executions).toEqual(before.executions);
        expect(readFileSync(join(profile.profilePath, 'config.jsonc'))).toEqual(configuration);
        const status = await execute([cli, 'maintenance', 'status', ...scope], workspace, home);
        expect(status.code).toBe(0);
        expect(JSON.parse(status.stdout).restore).toBeNull();
        expect(providerCalls).toBe(1);
        console.log(
          `TERMINAL_LINUX_SELECTED_ENGINE ${JSON.stringify({
            engine: before.engine,
            walWrites: 24,
            beforeStoreId: before.storeId,
            restoredStoreId: cold.storeId,
            originalHistoryRetained: true,
            providerCalls,
            installedMaintenance: true,
          })}`,
        );
      }
      const originalDatabase = readFileSync(profile.databasePath);
      const originalConfiguration = readFileSync(join(profile.profilePath, 'config.jsonc'));
      uninstallTerminalBundle(prefix);
      expect(existsSync(prefix)).toBe(false);
      expect(readFileSync(profile.databasePath)).toEqual(originalDatabase);
      expect(readFileSync(join(profile.profilePath, 'config.jsonc'))).toEqual(
        originalConfiguration,
      );
      expect(existsSync(relocated)).toBe(true);
      expect(providerCalls).toBe(1);
      expect(readFileSync(legacy, 'utf8')).toBe('LEGACY_PROFILE_MUST_NOT_BE_READ');
    } finally {
      if (daemonStarted)
        await execute([cli, 'server', 'stop', '--server', socket], workspace, home);
      provider.stop(true);
    }
  } finally {
    if (process.env.KITE_TERMINAL_TEST_KEEP_BUNDLE === '1')
      console.log(`OWNED_TERMINAL_TEST_ROOT ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
}, 120000);
