import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProfileBackup, restoreProfileBackup } from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { launchPairedService } from '@kite-ai/service/paired';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { ownedUserConfiguration } from '../../../service/test/fixtures/user-configuration-fixture';
import { openTuiDraftFile } from '../../host/tui-drafts';
import { buildOwnedDaemon } from '../fixtures/daemon-host-build';
import { compileFileRecoveryTUI } from '../fixtures/file-recovery-profile';

test('source-tree-external built PTY cold draft, Service SIGKILL holds host lease, final input flush and restored original remain read-only', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tui-draft-pty-')));
  const workspace = join(root, 'workspace');
  privateDirectory(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'draft' });
  const userConfiguration = ownedUserConfiguration(join(root, 'home'));
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
  await buildOwnedDaemon(join(root, 'service-artifact'));
  const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const entrypoint = join(root, 'service-artifact/node_modules/@kite-ai/service/main.js');
  const artifact = {
    entrypoint,
    entrypointSha256: sha(entrypoint),
    executable: realpathSync(process.execPath),
    executableSha256: sha(process.execPath),
    buildId: `development-${sha(entrypoint)}`,
    apiMajor: 1,
  };
  try {
    privateDirectory(profile.profilePath);
    // This fixture asserts English labels independently of the host device locale.
    privateDirectory(join(profile.profilePath, 'ui'));
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    writeFileSync(
      userConfiguration.path,
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
      spawnChild: userConfiguration.spawnChild,
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
      const trust = await seed.client.getWorkspaceTrust('w', { storeId });
      expect(
        (
          await seed.client.setWorkspaceTrust('w', {
            expectedStoreId: storeId,
            commandId: 'trust-owned-draft-workspace',
            trusted: true,
            ifRevision: trust.revision,
            canonicalIdentity: trust.canonicalIdentity,
            externalReadScopeDigest: trust.externalReadScopeDigest,
          })
        ).state,
      ).toBe('applied');
    } finally {
      await seed.close();
    }
    const build = await compileFileRecoveryTUI(
      root,
      join(import.meta.dir, 'tui-drafts.fixture.ts'),
    );
    if (!build.success) throw new AggregateError(build.logs, 'owned host build');
    const hostPath = join(root, 'tui-drafts.fixture.js');
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
      const child = Bun.spawn(
        [
          process.execPath,
          '--no-install',
          join(import.meta.dir, '../fixtures/tui-drafts-pty.ts'),
          JSON.stringify({ mode, root, hostPath, input, pidPath, storeId }),
        ],
        {
          env: { ...process.env, ...userConfiguration.homeEnvironment },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
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
