import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { selectProfile } from '@kite-ai/agent/profile';
import { constants, Database } from '@kite-ai/agent/runtime-sqlite';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { userConfigurationPath } from '../../../apps/service/src/user-configuration-path';
import { build as buildFixture } from '../../../scripts/tooling/build';
import { serve as serveFixture } from '../../../scripts/tooling/http';
import { which as findFixtureExecutable } from '../../../scripts/tooling/process';
import { temporarySocketDirectory } from '../test-filesystem';

const exec = promisify(execFile);
const usage =
  'Usage: node --import ./scripts/tooling/register.mjs tests/fixtures/unified-agent/macos-dmg.qualification.ts --previous <A.dmg> --current <B.dmg> --evidence <directory> [--applications /Applications]';
const repository = resolve(import.meta.dirname, '../../..');
const bundleName = 'Kite Desktop.app';
const nativeResources = 'Contents/Resources/native';
type InstallPhase = 'previous' | 'current' | 'rollback' | 'fresh';
const finderCopy = `on run argv
    set imageFolder to POSIX file (item 1 of argv) as alias
    set sourceItem to POSIX file (item 2 of argv) as alias
    set targetFolder to POSIX file (item 3 of argv) as alias
    set replacement to (item 5 of argv) is "replace"
    if replacement then set priorItem to POSIX file (item 4 of argv) as alias
    with timeout of 90 seconds
        tell application "Finder"
            open imageFolder
            if replacement then
                set copiedItem to duplicate sourceItem to targetFolder with replacing
            else
                set copiedItem to duplicate sourceItem to targetFolder
            end if
            return POSIX path of (copiedItem as alias)
        end tell
    end timeout
end run`;
const finderTrash = `on run argv
    set targetItem to POSIX file (item 1 of argv) as alias
    set recoveredFolder to POSIX file (item 2 of argv) as alias
    with timeout of 90 seconds
        tell application "Finder"
            set originalName to name of targetItem
            set disposedItem to delete targetItem
            if container of disposedItem is not trash then error "The app did not reach Trash"
            set trashPath to POSIX path of (disposedItem as alias)
            set recoveredItem to move disposedItem to recoveredFolder
            if name of recoveredItem is not originalName then set name of recoveredItem to originalName
            return trashPath
        end tell
    end timeout
end run`;
const sessionId = 'macos-dmg-session';
const sessionTitle = 'macOS DMG installation witness';
const modelId = 'macos-dmg-fixture';
const message = '请保留这条 macOS 安装验收消息。';
const answer = '已记录 macOS 安装验收回复。';
const freshMessage = '请保留新版 Node 安装后的这条消息。';
const freshAnswer = '新版 Node 已记录这条回复。';

async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function argumentsFrom(args: string[]) {
  if (args.length !== 6 && args.length !== 8) throw Error(usage);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!,
      value = args[index + 1]!;
    if (
      !['--previous', '--current', '--evidence', '--applications'].includes(name) ||
      !value ||
      values.has(name)
    )
      throw Error(usage);
    if (name === '--applications' && value !== '/Applications') throw Error(usage);
    values.set(name, resolve(value));
  }
  if (!['--previous', '--current', '--evidence'].every((name) => values.has(name)))
    throw Error(usage);
  return {
    previous: values.get('--previous')!,
    current: values.get('--current')!,
    evidence: values.get('--evidence')!,
    applications: values.get('--applications'),
  };
}

function inspect(path: string) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

function prepareEvidence(requested: string) {
  if (!existsSync(requested)) mkdirSync(requested, { mode: 0o700 });
  const evidence = realpathSync(requested);
  const stat = lstatSync(evidence);
  assert.equal(evidence, requested);
  assert(
    stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0,
    'macos_dmg_evidence_directory_must_be_private',
  );
  return mkdtempSync(join(evidence, 'macos-dmg-'));
}

async function runQualification(args: string[]) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw Error('macos_dmg_qualification_requires_arm64_mac');
  const inputs = argumentsFrom(args);
  const previous = realpathSync(inputs.previous),
    current = realpathSync(inputs.current);
  assert(previous.endsWith('.dmg') && current.endsWith('.dmg') && previous !== current);
  if (inputs.applications) {
    assert.equal(realpathSync(inputs.applications), inputs.applications);
    assert.equal(
      inspect(join(inputs.applications, bundleName)),
      undefined,
      'system_app_destination_already_exists',
    );
  }
  const imageDigests = { previous: await digest(previous), current: await digest(current) };
  assert.notEqual(imageDigests.previous, imageDigests.current);
  const node = findFixtureExecutable('node');
  assert(node && isAbsolute(node), 'node_for_playwright_required');
  const evidence = prepareEvidence(inputs.evidence);
  const root = temporarySocketDirectory('kite-dmg-');
  const home = join(root, 'home'),
    workspace = join(root, 'work'),
    scratch = join(root, 'tmp');
  assert.notEqual(home, homedir());
  const applications = inputs.applications ?? join(home, 'Applications');
  const app = join(applications, bundleName);
  const executable = join(app, 'Contents/MacOS/KiteDesktop');
  const native = join(app, nativeResources);
  const recovered = join(root, 'removed-app');
  let ownedApp: ReturnType<typeof inspect>;
  const profile = selectProfile({
    dataRoot: join(home, '.kite-code/unified-agent'),
    profile: 'default',
  });
  const userConfig = userConfigurationPath(home);
  const workspaceFile = join(workspace, 'keep.txt');
  const env = { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: scratch, LANG: 'C.UTF-8' };
  console.log(JSON.stringify({ evidence, root, applications }));

  async function command(label: string, executable: string, args: string[], timeout = 120000) {
    const path = join(evidence, `${label}.log`);
    try {
      const { stdout, stderr } = await exec(executable, args, { cwd: home, env, timeout });
      writeFileSync(path, stdout + stderr, { mode: 0o600 });
      return stdout;
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string };
      writeFileSync(path, `${output.stdout ?? ''}${output.stderr ?? ''}\n${String(error)}\n`, {
        mode: 0o600,
      });
      throw Error(`${label}_failed (see ${path})`, { cause: error });
    }
  }

  function checkOwnedApp(path: string) {
    const actual = inspect(path);
    assert(
      actual && ownedApp && actual.isDirectory() && ownedApp.isDirectory(),
      'finder_fixture_app_identity_missing',
    );
    assert.equal(actual.dev, ownedApp.dev, 'finder_fixture_app_device_changed');
    assert.equal(actual.ino, ownedApp.ino, 'finder_fixture_app_inode_changed');
  }

  function checkDesktopPayload(root: string) {
    const directories = [root];
    for (const directory of directories) {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        assert.notEqual(
          item.name.toLowerCase(),
          'node_modules',
          `unexpected dependency tree ${path}`,
        );
        if (item.isDirectory()) directories.push(path);
      }
    }
    const terminal = join(root, nativeResources, 'terminal');
    for (const entry of ['entrypoints', 'web', 'code/@kite-ai/cli', 'code/@kite-ai/ui']) {
      const path = join(terminal, entry);
      assert.equal(inspect(path), undefined, `unexpected Terminal payload ${path}`);
    }
  }

  async function applyImage(label: InstallPhase, image: string) {
    const mount = join(root, label);
    mkdirSync(mount, { mode: 0o700 });
    await command(`${label}-attach`, '/usr/bin/hdiutil', [
      'attach',
      image,
      '-readonly',
      '-verify',
      '-noautoopen',
      '-nobrowse',
      '-mountpoint',
      mount,
    ]);
    try {
      const source = join(mount, bundleName);
      assert(inspect(source)?.isDirectory(), 'macos_dmg_app_bundle_missing');
      const shortcut = join(mount, 'Applications');
      assert(inspect(shortcut)?.isSymbolicLink());
      assert.equal(readlinkSync(shortcut), '/Applications');
      if (label === 'current' || label === 'fresh') checkDesktopPayload(source);
      const replacing = label === 'current' || label === 'rollback';
      if (replacing) checkOwnedApp(app);
      else assert.equal(inspect(app), undefined, 'finder_app_destination_already_exists');
      const copied = await command(`${label}-finder-copy`, '/usr/bin/osascript', [
        '-e',
        finderCopy,
        mount,
        source,
        applications,
        app,
        replacing ? 'replace' : 'copy',
      ]);
      assert.equal(resolve(copied.trim()), app);
      ownedApp = inspect(app);
      assert(ownedApp?.isDirectory());
    } finally {
      await command(`${label}-detach`, '/usr/bin/hdiutil', ['detach', mount]);
      if (existsSync(mount)) rmdirSync(mount);
    }
  }

  async function moveOwnedAppToTrash(label: string) {
    checkOwnedApp(app);
    const folder = join(recovered, label);
    mkdirSync(folder, { mode: 0o700 });
    const staged = join(folder, bundleName);
    assert.equal(inspect(staged), undefined);
    // Finder proves the item reached Trash and moves only this exact fixture item
    // into owned scratch for cleanup, leaving all other Trash items untouched.
    const trashPath = (
      await command(label, '/usr/bin/osascript', ['-e', finderTrash, app, folder])
    ).trim();
    assert(isAbsolute(trashPath) && resolve(trashPath) !== app);
    assert.equal(inspect(app), undefined);
    checkOwnedApp(staged);
    ownedApp = undefined;
    return trashPath;
  }

  function installedCandidate(phase: InstallPhase) {
    assert(lstatSync(executable).isFile());
    const bundle = verifyNativeRuntimeBundle(native);
    assert.deepEqual(bundle.manifest.target, { platform: 'darwin', arch: 'arm64' });
    const { entries, bunVersion, nodeVersion, source, files } = bundle.terminal.manifest;
    const node = phase === 'current' || phase === 'fresh';
    if (node) {
      checkDesktopPayload(app);
      assert.deepEqual(entries, {
        runtime: 'runtime/node',
        service: 'code/@kite-ai/service/main.js',
      });
      assert(nodeVersion);
      assert.equal(bunVersion, undefined);
      assert.equal(inspect(join(bundle.terminal.root, 'runtime/bun')), undefined);
      assert(files.some((file) => file.path === 'code/@kite-ai/agent/runtime-native.node'));
    } else {
      assert(bunVersion);
      assert.equal(nodeVersion, undefined);
      assert.equal(entries.runtime, 'runtime/bun');
    }
    const main = bundle.manifest.files.find((file) => file.path === bundle.manifest.entries.main);
    assert(main);
    return {
      id: bundle.digest,
      source,
      mainSha256: main.sha256,
      entries,
      runtimeVersion: nodeVersion ?? bunVersion,
      terminalRoot: bundle.terminal.root,
      runtime: join(bundle.terminal.root, entries.runtime),
      serviceEntrypoint: join(bundle.terminal.root, entries.service),
      mainExecutable: join(bundle.root, bundle.manifest.entries.electron),
      rendererUrl: pathToFileURL(join(bundle.root, bundle.manifest.entries.html)).href,
    };
  }

  async function filesSnapshot(storeId: string) {
    const modelPreference = `${createHash('sha256').update(storeId).digest('hex')}.json`;
    const paths = {
      core: profile.databasePath,
      desktop: join(profile.profilePath, 'desktop-private/data.sqlite'),
      profile: join(profile.profilePath, 'profile.json'),
      configuration: userConfig,
      electronModelPreference: join(home, 'electron-data/model-preferences', modelPreference),
      workspace: workspaceFile,
    };
    return Object.fromEntries(
      await Promise.all(
        Object.entries(paths).map(async ([name, path]) => {
          const stat = lstatSync(path, { bigint: true });
          assert(stat.isFile() && stat.nlink === 1n);
          return [
            name,
            {
              inode: String(stat.ino),
              device: String(stat.dev),
              size: String(stat.size),
              sha256: await digest(path),
            },
          ] as const;
        }),
      ),
    );
  }

  function sessionSnapshot() {
    // Main and Service have exited and SQLite has checkpointed the WAL. Inspect
    // the database without creating new WAL or SHM files in the observed Profile.
    for (const suffix of ['-wal', '-shm']) assert(!existsSync(`${profile.databasePath}${suffix}`));
    const location = pathToFileURL(profile.databasePath);
    location.search = 'mode=ro&immutable=1';
    const database = new Database(
      location.href,
      constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI | constants.SQLITE_OPEN_NOFOLLOW,
    );
    try {
      const metadata = database
        .query<{ store_id: string }, []>('SELECT store_id FROM storage_meta WHERE singleton=1')
        .get();
      assert(metadata);
      return {
        storeId: metadata.store_id,
        messages: database
          .query<{ id: string; role: string; source_json: string }, [string]>(
            'SELECT id, role, source_json FROM message WHERE session_id=? ORDER BY seq',
          )
          .all(sessionId),
        runs: database
          .query<{ id: string; status: string }, [string]>(
            'SELECT id, status FROM run WHERE session_id=? ORDER BY id',
          )
          .all(sessionId),
      };
    } finally {
      database.close();
    }
  }

  let providerCalls = 0;
  const provider = await serveFixture({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const route = new URL(request.url).pathname;
      if (request.method !== 'POST' || route !== '/v1/chat/completions')
        return new Response('missing fixture route', { status: 404 });
      const input = (await request.json()) as {
        model: string;
        messages: { role: string; content: string }[];
      };
      assert.equal(input.model, modelId);
      const expected = providerCalls === 0 ? message : freshMessage;
      assert.equal(
        input.messages.filter(({ role, content }) => role === 'user' && content === expected)
          .length,
        1,
      );
      const reply = expected === freshMessage ? freshAnswer : answer;
      providerCalls++;
      const frame = (delta: unknown, finishReason: string | null) =>
        `data: ${JSON.stringify({ id: 'macos-dmg', object: 'chat.completion.chunk', model: modelId, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
      return new Response(
        `${frame({ content: reply }, null)}${frame({}, 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });

  try {
    for (const path of [home, workspace, scratch, recovered]) mkdirSync(path, { mode: 0o700 });
    if (!inputs.applications) mkdirSync(applications, { mode: 0o700 });
    writeFileSync(workspaceFile, 'user workspace data survives the installer\n', { mode: 0o600 });
    const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    let storeId: string;
    try {
      ({ storeId } = await store.getMetadata());
      await store.createWorkspace({
        expectedStoreId: storeId,
        id: 'macos-dmg-workspace',
        name: 'macOS DMG witness',
        rootUri: pathToFileURL(workspace).href,
      });
      await store.createSession({
        expectedStoreId: storeId,
        subjectId: 'local-user',
        commandId: 'macos-dmg-create',
        sessionId,
        workspaceId: 'macos-dmg-workspace',
        title: sessionTitle,
      });
    } finally {
      await store.close();
    }
    writeFileSync(
      userConfig,
      JSON.stringify({
        modelId,
        tools: [],
        models: [
          {
            id: modelId,
            provider: 'compatible',
            model: modelId,
            baseURL: `${provider.url.href}v1`,
          },
        ],
      }),
      { mode: 0o600 },
    );

    const driver = join(evidence, 'electron-driver.mjs');
    const built = await buildFixture({
      entrypoints: [join(import.meta.dirname, 'macos-dmg-electron.fixture.ts')],
      target: 'node',
      format: 'esm',
    });
    assert(built.success && built.outputs.length === 1, built.logs.join('\n'));
    writeFileSync(driver, await built.outputs[0]!.text(), { mode: 0o600 });
    const window = (phase: InstallPhase, candidate: ReturnType<typeof installedCandidate>) =>
      command(
        `${phase}-window`,
        node,
        [
          driver,
          JSON.stringify({
            desktopPackage: join(repository, 'apps/desktop/package.json'),
            phase,
            executable,
            mainExecutable: candidate.mainExecutable,
            runtime: candidate.runtime,
            serviceEntrypoint: candidate.serviceEntrypoint,
            rendererUrl: candidate.rendererUrl,
            home,
            temporaryDirectory: scratch,
            storeId,
            sessionId,
            sessionTitle,
            modelId,
            message,
            answer,
            freshMessage,
            freshAnswer,
            screenshot: join(evidence, `${phase}.png`),
          }),
        ],
        60000,
      );

    assert.equal(inspect(app), undefined);
    await applyImage('previous', previous);
    const initial = installedCandidate('previous');
    await window('previous', initial);
    assert.equal(providerCalls, 1);
    const originalSession = sessionSnapshot();
    assert.equal(originalSession.storeId, storeId);
    assert.equal(originalSession.runs.length, 1);
    assert.equal(originalSession.runs[0]?.status, 'completed');
    assert.deepEqual(
      originalSession.messages.map(({ role, source_json }) => [
        role,
        JSON.parse(source_json).content,
      ]),
      [
        ['user', message],
        ['assistant', answer],
      ],
    );
    const beforeUpdate = await filesSnapshot(storeId);

    await applyImage('current', current);
    const updated = installedCandidate('current');
    assert.notEqual(updated.id, initial.id);
    const afterUpdate = await filesSnapshot(storeId);
    assert.deepEqual(afterUpdate, beforeUpdate);
    await window('current', updated);
    assert.equal(providerCalls, 1, 'cold read must not replay the original model request');
    assert.deepEqual(sessionSnapshot(), originalSession);

    const beforeRollback = await filesSnapshot(storeId);
    await applyImage('rollback', previous);
    const rolledBack = installedCandidate('rollback');
    assert.deepEqual(rolledBack, initial);
    const afterRollback = await filesSnapshot(storeId);
    assert.deepEqual(afterRollback, beforeRollback);
    await window('rollback', rolledBack);
    assert.equal(providerCalls, 1);
    assert.deepEqual(sessionSnapshot(), originalSession);

    const beforeUninstall = await filesSnapshot(storeId);
    const trashPath = await moveOwnedAppToTrash('finder-move-to-trash');
    assert.equal(inspect(app), undefined);
    const afterUninstall = await filesSnapshot(storeId);
    assert.deepEqual(afterUninstall, beforeUninstall);
    assert.deepEqual(sessionSnapshot(), originalSession);

    await applyImage('fresh', current);
    const freshlyInstalled = installedCandidate('fresh');
    assert.deepEqual(freshlyInstalled, updated);
    assert.deepEqual(await filesSnapshot(storeId), afterUninstall);
    await window('fresh', freshlyInstalled);
    assert.equal(providerCalls, 2);
    const freshSession = sessionSnapshot();
    const originalRunId = originalSession.runs[0]!.id;
    assert.deepEqual(
      freshSession.runs.filter(({ id }) => id === originalRunId),
      originalSession.runs,
    );
    assert.equal(freshSession.runs.length, 2);
    assert.equal(freshSession.runs.find(({ id }) => id !== originalRunId)?.status, 'completed');
    assert.deepEqual(freshSession.messages.slice(0, 2), originalSession.messages);
    assert.deepEqual(
      freshSession.messages
        .slice(2)
        .map(({ role, source_json }) => [role, JSON.parse(source_json).content]),
      [
        ['user', freshMessage],
        ['assistant', freshAnswer],
      ],
    );
    const nodeProbe = await command('fresh-node-model-output', freshlyInstalled.runtime, [
      join(import.meta.dirname, 'macos-dmg-model-output.fixture.mjs'),
      freshlyInstalled.terminalRoot,
      scratch,
    ]);
    assert.match(nodeProbe, /PACKAGED_NODE_KEYCHAIN_LOOKUP_OK/);
    assert.match(nodeProbe, /PACKAGED_NODE_MODEL_OUTPUT_OK/);
    const beforeFreshUninstall = await filesSnapshot(storeId);
    const freshTrashPath = await moveOwnedAppToTrash('fresh-finder-move-to-trash');
    const afterFreshUninstall = await filesSnapshot(storeId);
    assert.deepEqual(afterFreshUninstall, beforeFreshUninstall);
    assert.deepEqual(sessionSnapshot(), freshSession);
    assert.deepEqual(
      { previous: await digest(previous), current: await digest(current) },
      imageDigests,
    );
    const report = {
      applications,
      imageDigests,
      initial,
      updated,
      rolledBack,
      freshlyInstalled,
      storeId,
      sessionId,
      providerCalls,
      beforeUpdate,
      afterUpdate,
      beforeRollback,
      afterRollback,
      beforeUninstall,
      afterUninstall,
      beforeFreshUninstall,
      afterFreshUninstall,
      appRemoved: true,
      trashPath,
      freshTrashPath,
    };
    writeFileSync(join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    assert.equal(realpathSync(root), root);
    rmSync(root, { recursive: true });
    console.log(
      JSON.stringify({ result: 'passed', evidence, previous: initial.id, current: updated.id }),
    );
  } catch (error) {
    console.error(JSON.stringify({ result: 'failed', evidence, retainedRoot: root }));
    if (inputs.applications && ownedApp && inspect(app)) {
      try {
        const processes = await command('failed-run-processes', '/bin/ps', ['-axo', 'comm=']);
        assert(
          !processes.split('\n').some((process) => process.trim().startsWith(`${native}/`)),
          'finder_fixture_app_still_running',
        );
        await moveOwnedAppToTrash('failed-run-finder-move-to-trash');
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], `finder_fixture_cleanup_failed for ${app}`);
      }
    }
    throw error;
  } finally {
    provider.stop(true);
  }
}

if (import.meta.main) {
  if (process.argv.slice(2).join(' ') === '--help') console.log(usage);
  else await runQualification(process.argv.slice(2));
}
