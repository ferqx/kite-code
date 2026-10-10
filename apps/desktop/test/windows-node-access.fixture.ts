import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { acquireNodeArtifactAccess } from '../electron/artifact-access';
import { spawnNodePairedChild } from '../electron/node-process';
import { openPrivateData } from '../electron/private-data';
import { acquireDesktopProfileAccess } from '../electron/profile-access';
import { loadWindowsAccess } from '../electron/windows-access';

const input = JSON.parse(process.argv[2]!);
const send = (phase: string, facts: Record<string, unknown> = {}) =>
  console.log(
    JSON.stringify({
      phase,
      pid: process.pid,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      ...facts,
    }),
  );
const commands = createInterface({ input: process.stdin });
if (input.mode === 'candidate-denied') {
  const backend = loadWindowsAccess(input.windowsAsset);
  assert.equal(typeof backend.candidateShared, 'function');
  assert.throws(
    () =>
      backend.candidateShared(
        input.candidate.root,
        input.candidate.prefix,
        input.candidate.id,
        input.candidate.files,
        {
          launcherPipe: `\\\\.\\pipe\\kite-native-launch-${'a'.repeat(32)}`,
          mainPipe: `\\\\.\\pipe\\kite-native-main-${'b'.repeat(32)}`,
        },
      ),
    /windows_access_unavailable/,
  );
  send('candidate-denied');
} else if (input.mode === 'denied') {
  const acquire =
    input.denyKind === 'artifact'
      ? () =>
          acquireNodeArtifactAccess({
            ...input.access,
            windowsAsset: input.windowsAsset,
            root: input.roots[0],
          })
      : () =>
          acquireDesktopProfileAccess({
            ...input.access,
            windowsAsset: input.windowsAsset,
            profile: input.profile,
          });
  await assert.rejects(acquire(), new RegExp(input.expectedCode));
  send('denied');
} else if (input.mode === 'cold') {
  const profile = selectProfile(input.profile);
  const access = await acquireDesktopProfileAccess({
    ...input.access,
    windowsAsset: input.windowsAsset,
    profile,
  });
  const data = openPrivateData(profile.profilePath, access);
  assert.deepEqual(data.read(input.scope), input.draft);
  data.close();
  access.close();
  send('cold-original', { draft: input.draft });
} else if (input.mode === 'gc') {
  const backend = loadWindowsAccess(input.windowsAsset);
  let lease = backend.artifactShared(input.roots[0]);
  lease.verify();
  send('gc-held');
  for await (const command of commands) {
    if (command === 'gc') {
      lease = undefined as unknown as typeof lease;
      assert.equal(typeof global.gc, 'function');
      for (let index = 0; index < 20; index++) {
        global.gc!();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      send('gc-requested');
    } else if (command === 'close') break;
  }
} else if (input.mode === 'ui-proof') {
  const profile = selectProfile(input.profile);
  const lease = loadWindowsAccess(input.windowsAsset).profileShared(
    profile.dataRoot,
    profile.profile,
  );
  let database: import('node:sqlite').DatabaseSync | undefined;
  try {
    assert.throws(() => lease.verifyPrivateUi(), /windows_access_unavailable/);
    send('ui-unprepared');
    for await (const command of commands) {
      if (command === 'prepare') {
        lease.preparePrivateUi();
        assert.throws(() => lease.preparePrivateUi(), /windows_access_unavailable/);
        lease.verifyPrivateUi();
        send('ui-prepared');
      } else if (command === 'open') {
        const { DatabaseSync } = await import('node:sqlite');
        database = new DatabaseSync(`${profile.profilePath}/desktop-private/data.sqlite`);
        lease.verifyPrivateUi();
        database.exec(
          "PRAGMA journal_mode=WAL; CREATE TABLE owned_ui_proof(value TEXT); INSERT INTO owned_ui_proof VALUES('original'); PRAGMA wal_checkpoint(TRUNCATE);",
        );
        lease.verifyPrivateUi();
        send('ui-opened');
      } else if (command === 'verify') {
        lease.verifyPrivateUi();
        send('ui-verified');
      } else if (command === 'close') break;
    }
  } finally {
    database?.close();
    lease.release();
  }
} else {
  const roots = [];
  let profileAccess: Awaited<ReturnType<typeof acquireDesktopProfileAccess>> | undefined;
  let data: ReturnType<typeof openPrivateData> | undefined;
  let paired: Awaited<ReturnType<typeof launchPairedService>> | undefined;
  try {
    for (const root of input.roots)
      roots.push(
        await acquireNodeArtifactAccess({
          ...input.access,
          windowsAsset: input.windowsAsset,
          root,
        }),
      );
    const profile = selectProfile(input.profile);
    profileAccess = await acquireDesktopProfileAccess({
      ...input.access,
      windowsAsset: input.windowsAsset,
      profile,
    });
    send('parent-held');
    paired = await launchPairedService({
      profile,
      entrypoint: input.service,
      executable: input.access.bunExecutable,
      spawnChild: spawnNodePairedChild,
      instanceId: input.instanceId,
      buildId: 'owned-windows-holder',
      apiMajor: 1,
      requiredCapabilities: ['sessions', 'commands'],
    });
    assert(paired.bootstrap.storeId);
    const storeId = paired.bootstrap.storeId;
    await paired.client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: new URL(`file:///${input.workspace.replaceAll('\\', '/')}`).href,
    });
    await paired.client.createSession({
      expectedStoreId: storeId,
      sessionId: 's',
      workspaceId: 'w',
      commandId: 'create',
      title: 'original',
    });
    data = openPrivateData(profile.profilePath, profileAccess);
    const scope = { storeId, workspaceId: 'w', rootSessionId: 's' };
    const draft = data.save(scope, 0, '\ufeff原始 Windows UI 😀\r\n');
    assert.throws(() => profileAccess!.close(), /profile_access_in_use/);
    send('paired-held', {
      childPid: paired.pid,
      storeId,
      profileAccessKey: profile.profileAccessKey,
      draft,
    });
    for await (const command of commands) {
      if (command === 'kill-child') {
        process.kill(paired.pid, 'SIGKILL');
        await paired.exited;
        assert.deepEqual(data.read(scope), draft);
        send('child-dead-ui-held', { draft });
      } else if (command === 'close') break;
    }
    writeFileSync(input.gate, 'release');
    data.close();
    data = undefined;
    profileAccess.close();
    await paired.close();
    send('closed');
  } finally {
    writeFileSync(input.gate, 'release');
    data?.close();
    profileAccess?.close();
    await paired?.close();
    for (const lease of roots.reverse()) lease.close();
  }
}
commands.close();
