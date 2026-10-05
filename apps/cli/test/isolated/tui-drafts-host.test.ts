import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProfileBackup, restoreProfileBackup } from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { launchPairedService } from '@kite-ai/service/paired';
import { openTuiDraftFile } from '../../host/tui-drafts';

const repository = resolve(import.meta.dir, '../../../..');
test('source-tree-external built PTY cold draft, Service SIGKILL holds host lease, final input flush and restored original remain read-only', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-tui-draft-pty-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'draft' });
  const cleanups: (() => Promise<void>)[] = [];
  let calls = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      calls++;
      return new Response('', { status: 500 });
    },
  });
  const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const entrypoint = join(repository, 'apps/service/dist/main.js');
  const artifact = {
    entrypoint,
    entrypointSha256: sha(entrypoint),
    executable: realpathSync(process.execPath),
    executableSha256: sha(process.execPath),
    buildId: `development-${sha(entrypoint)}`,
    apiMajor: 1,
  };
  try {
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    // This fixture asserts English labels independently of the host device locale.
    mkdirSync(join(profile.profilePath, 'ui'), { recursive: true, mode: 0o700 });
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'local',
        models: [
          {
            id: 'local',
            provider: 'compatible',
            model: 'fixture',
            baseURL: `${provider.url.href}v1`,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const seed = await launchPairedService({
      profile,
      ...artifact,
      instanceId: crypto.randomUUID(),
      requiredCapabilities: ['sessions', 'commands'],
    });
    let storeId: string;
    try {
      if (seed.bootstrap.dataAvailability !== 'available') throw Error('seed');
      storeId = seed.bootstrap.storeId;
      await seed.client.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        rootUri: pathToFileURL(workspace).href,
        name: 'owned',
      });
      await seed.client.createSession({
        expectedStoreId: storeId,
        commandId: 'create',
        sessionId: 'a',
        workspaceId: 'w',
        title: 'owned',
      });
    } finally {
      await seed.close();
    }
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, 'tui-drafts.fixture.ts')],
      target: 'bun',
      packages: 'bundle',
      external: ['react-devtools-core'],
      outdir: root,
      naming: 'host.js',
    });
    if (!build.success) throw new AggregateError(build.logs, 'owned host build');
    const pidPath = join(root, 'service.pid'),
      input = join(root, 'input.json');
    writeFileSync(
      input,
      JSON.stringify({ artifact, workspace, dataRoot: profile.dataRoot, pidPath }),
      { mode: 0o600 },
    );
    const path = join(profile.profilePath, 'ui', 'tui.json');
    let newStoreId: string | undefined;
    const run = async (mode: string) => {
      const program = `import os,pty,subprocess,select,time,signal,re,json,sys\nmaster,slave=pty.openpty()\np=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(join(root, 'host.js'))},${JSON.stringify(input)}],cwd=${JSON.stringify(root)},stdin=slave,stdout=slave,stderr=slave,start_new_session=True)\nos.close(slave);buffer=b''\ndef wait(text):\n global buffer\n deadline=time.monotonic()+12\n while text not in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace'))):\n  if time.monotonic()>deadline: raise RuntimeError('expected '+text+' tail='+buffer[-2500:].decode(errors='replace'))\n  if select.select([master],[],[],.05)[0]:\n   try: buffer+=os.read(master,65536)\n   except OSError: raise RuntimeError('host ended')\ndef command(expected):\n if not select.select([sys.stdin],[],[],12)[0]: raise RuntimeError('protocol timeout')\n assert input()==expected\ntry:\n wait('New Run')\n ${mode === 'first' ? `os.write(master,b'cold original');wait('cold original');os.write(master,b'\\x11')` : mode === 'crash' ? `wait('cold original');os.kill(int(open(${JSON.stringify(pidPath)}).read()),signal.SIGKILL);assert p.poll() is None;os.write(master,b' last edit');wait('cold original last edit');print('HELD',flush=True);command('quit');os.write(master,b'\\x11')` : mode === 'conflict' ? `wait('/drafts');os.write(master,b' local conflict');wait('/drafts local conflict');print('EDITED',flush=True);command('quit');os.write(master,b'\\x11');wait('exit_blocked');assert p.poll() is None;print('BLOCKED',flush=True);command('force');os.kill(p.pid,signal.SIGTERM)` : `assert 'cold original last edit' not in buffer.decode(errors='replace');os.write(master,b'/drafts');wait('/drafts');os.write(master,b'\\r');wait('Store ${storeId}');os.write(master,b'\\x11')`}\n deadline=time.monotonic()+8\n while p.poll() is None and time.monotonic()<deadline:\n  if select.select([master],[],[],.05)[0]:\n   try:buffer+=os.read(master,65536)\n   except OSError:break\n p.wait(timeout=5);assert p.returncode==${mode === 'conflict' ? 1 : 0};print('HOST_EXIT_${mode === 'conflict' ? 1 : 0}',flush=True)\nfinally:\n if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()\n os.close(master)\n`;
      const child = Bun.spawn(['python3', '-c', program], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      cleanups.push(async () => {
        try {
          child.stdin.end();
        } catch {}
        await child.exited;
      });
      const reader = child.stdout.getReader();
      let prefix = '';
      if (mode === 'conflict') {
        prefix = new TextDecoder().decode((await reader.read()).value);
        expect(prefix).toContain('EDITED');
        const access = acquireProfileAccess(profile);
        try {
          const file = openTuiDraftFile({
            access,
            acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
          });
          const scope = { storeId: newStoreId!, workspaceId: 'w', sessionId: 'a' };
          file.save(scope, file.load(scope).revision, 'disk external original');
          file.close();
        } finally {
          access.lock.release();
        }
        child.stdin.write('quit\n');
        const blocked = new TextDecoder().decode((await reader.read()).value);
        prefix += blocked;
        expect(blocked).toContain('BLOCKED');
        child.stdin.write('force\n');
        child.stdin.end();
      }
      if (mode === 'crash') {
        const held = new TextDecoder().decode((await reader.read()).value);
        prefix = held;
        if (!held.includes('HELD')) {
          reader.releaseLock();
          throw Error(await new Response(child.stderr).text());
        }
        expect(held).toContain('HELD');
        await expect(
          createProfileBackup({ profile, destinationRoot: join(root, 'busy') }),
        ).rejects.toMatchObject({ code: 'owner_busy' });
        const other = acquireProfileAccess({ dataRoot: profile.dataRoot, profile: 'other' });
        other.lock.release();
        child.stdin.write('quit\n');
        child.stdin.end();
      }
      const [out, err, exit] = await Promise.all([
        (async () => {
          try {
            let out = prefix;
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) return out;
              out += new TextDecoder().decode(chunk.value);
            }
          } finally {
            reader.releaseLock();
          }
        })(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exit !== 0) console.error(err);
      expect(exit).toBe(0);
      expect(err).toBe('');
      expect(out).toContain(mode === 'conflict' ? 'HOST_EXIT_1' : 'HOST_EXIT_0');
    };
    await run('first');
    expect(JSON.parse(readFileSync(path, 'utf8')).drafts[0].text).toBe('cold original');
    await run('crash');
    const original = readFileSync(path);
    expect(JSON.parse(original.toString()).drafts[0].text).toBe('cold original last edit');
    const backup = await createProfileBackup({ profile, destinationRoot: join(root, 'backups') });
    expect(backup.manifest.assets.tuiUi.present).toBe(true);
    const result = await restoreProfileBackup({
      profile,
      expectedStoreId: storeId!,
      backup,
      intent: 'replace_with_selected_backup',
    });
    newStoreId = result.storeId;
    expect(result.storeId).not.toBe(storeId!);
    expect(readFileSync(path)).toEqual(original);
    await run('restored');
    const access = acquireProfileAccess(profile);
    try {
      const file = openTuiDraftFile({
        access,
        acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
      });
      expect(file.load({ storeId: result.storeId, workspaceId: 'w', sessionId: 'a' }).text).toBe(
        '/drafts',
      );
      expect(file.list().find((row) => row.storeId === storeId!)?.text).toBe(
        'cold original last edit',
      );
      file.close();
    } finally {
      access.lock.release();
    }
    await run('conflict');
    const final = JSON.parse(readFileSync(path, 'utf8'));
    expect(final.drafts.find((row: { storeId: string }) => row.storeId === newStoreId).text).toBe(
      'disk external original',
    );
    expect(final.drafts.find((row: { storeId: string }) => row.storeId === storeId).text).toBe(
      'cold original last edit',
    );
    expect(calls).toBe(0);
  } finally {
    for (const cleanup of cleanups) await cleanup();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 45000);
