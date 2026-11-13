import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { readCLIRegistration } from '../../../apps/cli/host/cli-registration';
import {
  ptyDeadline,
  spawnTuiPTY,
  terminateTuiTree,
} from '../../../apps/cli/test/fixtures/tui-pty';
import { ownedUserConfiguration } from '../../../apps/service/test/fixtures/user-configuration-fixture';
import {
  installNativeBundle,
  rollbackNativeBundle,
  uninstallNativeBundle,
} from '../../../scripts/release/native-install';
import {
  installTerminalBundle,
  uninstallTerminalBundle,
} from '../../../scripts/release/terminal-bundle';
import { replaceWindowsNativeBundle } from '../../../scripts/release/windows-native-install';
import { prepareSetupLocation } from '../../../scripts/release/windows-setup/install-location';
import { privateDirectory, removeTemporaryDirectory, temporaryDirectory } from '../test-filesystem';

const windows = process.platform === 'win32';
const phase = (name: string, detail: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ qualification: 'native-terminal-split', phase: name, ...detail }));

async function qualify(terminal: string, combined: string, desktop: string) {
  assert(
    (windows && process.arch === 'x64') ||
      (process.platform === 'darwin' && process.arch === 'arm64'),
  );
  const previous = verifyNativeRuntimeBundle(combined);
  const replacement = verifyNativeRuntimeBundle(desktop);
  assert('cli' in previous.terminal.manifest.entries);
  assert.deepEqual(Object.keys(replacement.terminal.manifest.entries).sort(), [
    'runtime',
    'service',
  ]);
  assert(!existsSync(join(replacement.terminal.root, 'node_modules')));
  const root = temporaryDirectory('kite-native-terminal-split-');
  phase('isolated_root', { root });
  const home = join(root, 'home'),
    workspace = join(root, 'workspace');
  privateDirectory(home);
  privateDirectory(workspace);
  const configuration = ownedUserConfiguration(home);
  const dataRoot = join(home, '.kite-code', 'unified-agent');
  const profile = selectProfile({ dataRoot, profile: 'default' });
  const preferences = join(profile.profilePath, 'ui', 'preferences.jsonc');
  const terminalPrefix = join(root, 'terminal'),
    location = join(root, 'desktop');
  const oldPrefix = windows ? join(location, 'client') : location;
  const cli = join(terminalPrefix, 'bin', windows ? 'kite.exe' : 'kite');
  const tui = join(terminalPrefix, 'bin', windows ? 'kite-tui.exe' : 'kite-tui');
  const env = {
    ...process.env,
    ...configuration.homeEnvironment,
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  for (const key of [
    'NODE_PATH',
    'NODE_OPTIONS',
    'BUN_OPTIONS',
    'BUN_BE_BUN',
    'ELECTRON_RUN_AS_NODE',
  ])
    delete (env as NodeJS.ProcessEnv)[key];
  if (windows) {
    Object.assign(env, {
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
    });
    privateDirectory(join(home, 'AppData', 'Roaming'));
    privateDirectory(join(home, 'AppData', 'Local'));
  }
  const prompts = [
    'Before desktop upgrade',
    'CLI after desktop upgrade',
    'TUI after desktop upgrade',
  ];
  const replies = ['BEFORE_UPGRADE_REPLY', 'INDEPENDENT_CLI_REPLY', 'INDEPENDENT_TUI_REPLY'];
  const calls: string[] = [];
  let unexpectedModelRequests = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const payload = (await request.json()) as { messages: { role: string; content: string }[] };
      const task = payload.messages
        .reverse()
        .find((message) => message.role === 'user' && prompts.includes(message.content))?.content;
      if (!task || task !== prompts[calls.length]) {
        unexpectedModelRequests++;
        return new Response('unexpected model request', { status: 500 });
      }
      const reply = replies[calls.length];
      calls.push(task);
      const frame = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: 'split', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        `${frame({ content: reply }, null)}${frame({}, 'stop')}data: [DONE]\n\n`,
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      );
    },
  });
  const runCLI = async (...args: string[]) => {
    const child = Bun.spawn([cli, ...args], {
      cwd: workspace,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const result = Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    let code: number, stdout: string, stderr: string;
    try {
      [code, stdout, stderr] = await ptyDeadline(
        result,
        60000,
        `installed kite ${args[0]} timed out`,
      );
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
    assert.equal(code, 0, `${stderr}\n${stdout}`);
    return stdout;
  };

  try {
    writeFileSync(
      configuration.path,
      JSON.stringify({
        modelId: 'fixed',
        tools: [],
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `${server.url.href}v1`,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const store = await openSqliteStore({ dataRoot, profile: 'default' });
    let storeId: string;
    try {
      storeId = (await store.getMetadata()).storeId;
      await store.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        name: 'Upgrade workspace',
        rootUri: pathToFileURL(workspace).href,
      });
      await store.createSession({
        expectedStoreId: storeId,
        subjectId: 'local-user',
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        title: 'Upgrade session',
      });
    } finally {
      await store.close();
    }
    privateDirectory(join(profile.profilePath, 'ui'));
    writeFileSync(preferences, '{"language":"en-US"}', { mode: 0o600 });
    const runTask = (index: number) =>
      runCLI(
        'work',
        's',
        '--data-root',
        dataRoot,
        '--input',
        JSON.stringify({
          kind: 'run.start',
          expectedStoreId: storeId,
          commandId: `upgrade-cli-${index}`,
          content: prompts[index],
        }),
      );
    installTerminalBundle({ bundleRoot: terminal, prefix: terminalPrefix });
    if (windows) privateDirectory(location);
    installNativeBundle({ bundleRoot: combined, prefix: oldPrefix, cliPrefix: terminalPrefix });
    const registration = readCLIRegistration(terminalPrefix);
    assert.equal(registration?.candidateId, previous.digest);
    assert.deepEqual(readCLIRegistration(oldPrefix, true), registration);
    phase('combined_registered', { candidate: previous.digest });
    assert.match(await runTask(0), /completed/);
    phase('registered_cli_completed', { storeId, candidate: previous.digest });

    assert.throws(
      () =>
        installNativeBundle({ bundleRoot: desktop, prefix: oldPrefix, cliPrefix: terminalPrefix }),
      /cli_registration_candidate_invalid/,
    );
    assert.deepEqual(readCLIRegistration(terminalPrefix), registration);
    const beforeUpgrade = readFileSync(profile.databasePath);
    const install = (prefix: string) => installNativeBundle({ bundleRoot: desktop, prefix });
    const upgraded = windows
      ? (() => {
          const destination = prepareSetupLocation(location, {
            candidate: replacement.digest,
            registered: oldPrefix,
          });
          assert.equal(destination.replacing, oldPrefix);
          return replaceWindowsNativeBundle(oldPrefix, () => install(destination.prefix));
        })()
      : install(oldPrefix);
    assert.equal(upgraded.candidateId, replacement.digest);
    assert.equal(readCLIRegistration(terminalPrefix), undefined);
    assert.equal(readCLIRegistration(upgraded.root, true), undefined);
    if (windows) assert(!existsSync(oldPrefix));
    else assert.deepEqual(readdirSync(join(upgraded.root, 'bin')), ['kite-desktop']);
    assert.deepEqual(readFileSync(profile.databasePath), beforeUpgrade);
    phase('desktop_upgrade_released_registration', { candidate: upgraded.candidateId });
    assert.match(await runTask(1), /completed/);
    assert.deepEqual(calls, prompts.slice(0, 2));
    phase('independent_cli_completed');

    async function openTui(submit: boolean) {
      const pty = spawnTuiPTY({
        cmd: [tui, '--workspace', workspace, '--thread', 's', '--data-root', dataRoot],
        cwd: workspace,
        env,
        conptyCellWidths: windows,
      });
      const wait = async (label: string, ready: (frame: string) => boolean) => {
        const deadline = Date.now() + 30000;
        for (;;) {
          await pty.drain();
          const frame = pty.viewport();
          if (ready(frame)) {
            phase(label, { frame });
            return frame;
          }
          assert(!pty.ended && Date.now() < deadline, `${label}\n${frame}`);
          await Bun.sleep(30);
        }
      };
      const idle = (frame: string) => frame.includes('❯') && !frame.includes('Working');
      const trust = 'Trust this workspace and continue';
      try {
        await wait(
          'tui_startup',
          (frame) =>
            frame.includes(trust) ||
            (idle(frame) && frame.includes(submit ? replies[1]! : replies[2]!)),
        );
        if (pty.viewport().includes(trust)) {
          await pty.key('\x1b[A');
          await wait('tui_trust_selected', (frame) => frame.includes(`› ${trust}`));
          await pty.key('\r');
        }
        await wait(
          submit ? 'tui_reads_cli_reply' : 'tui_reopen_reads_reply',
          (frame) => idle(frame) && frame.includes(submit ? replies[1]! : replies[2]!),
        );
        if (submit) {
          await pty.key(prompts[2]!);
          await wait('tui_input_visible', (frame) => frame.includes(`❯ ${prompts[2]}`));
          assert.deepEqual(calls, prompts.slice(0, 2));
          await pty.key('\r');
          const frame = await wait(
            'tui_reply_and_editor',
            (value) => idle(value) && value.includes(replies[2]!),
          );
          assert.equal(frame.split(replies[2]!).length, 2);
        }
        await pty.key('\x11');
        assert.deepEqual(
          await ptyDeadline(
            Promise.all([pty.host.exited, pty.eof]),
            8000,
            'installed kite-tui did not exit',
          ),
          [0, undefined],
        );
        phase('tui_normal_exit', { submit });
      } finally {
        try {
          if (!pty.ended) await terminateTuiTree(pty, { exitTimeoutMs: 5000 });
        } finally {
          pty.close();
        }
      }
    }
    await openTui(true);
    await openTui(false);
    assert.deepEqual(calls, prompts);

    const beforeMaintenance = readFileSync(profile.databasePath);
    const destination = join(root, 'backup');
    privateDirectory(destination);
    const backed = JSON.parse(
      await runCLI(
        'maintenance',
        'backup',
        '--data-root',
        dataRoot,
        '--profile',
        'default',
        '--destination',
        destination,
      ),
    );
    assert.equal(backed.status, 'verified');
    assert.equal(backed.backup.manifest.source.storeId, storeId);
    const inspected = JSON.parse(await runCLI('maintenance', 'inspect', backed.backup.directory));
    assert.equal(inspected.status, 'verified');
    assert.deepEqual(inspected.backup, backed.backup);
    assert.deepEqual(readFileSync(profile.databasePath), beforeMaintenance);
    assert.deepEqual(calls, prompts);
    phase('independent_maintenance_verified', { storeId });

    if (!windows) {
      assert.equal(rollbackNativeBundle(upgraded.root).candidateId, previous.digest);
      assert.deepEqual(readdirSync(join(upgraded.root, 'bin')).sort(), [
        'kite',
        'kite-desktop',
        'kite-tui',
      ]);
      assert.equal(readCLIRegistration(terminalPrefix), undefined);
      assert.equal(rollbackNativeBundle(upgraded.root).candidateId, replacement.digest);
      assert.deepEqual(readdirSync(join(upgraded.root, 'bin')), ['kite-desktop']);
    }
    uninstallNativeBundle(upgraded.root);
    assert(existsSync(cli) && existsSync(tui));
    uninstallTerminalBundle(terminalPrefix);
    assert.deepEqual(readFileSync(profile.databasePath), beforeMaintenance);
    assert.equal(unexpectedModelRequests, 0);
    phase('complete', { storeId, modelCalls: calls.length });
  } finally {
    server.stop(true);
  }
  removeTemporaryDirectory(root);
}

const args = process.argv.slice(2);
assert.equal(
  args.length,
  3,
  'expected --terminal=<candidate> --native=<combined> --desktop=<desktop-only>',
);
const directories = ['terminal', 'native', 'desktop'].map((key, index) => {
  const prefix = `--${key}=`;
  assert(args[index]?.startsWith(prefix) && args[index]!.length > prefix.length);
  return realpathSync.native(resolve(args[index]!.slice(prefix.length)));
});
await qualify(directories[0]!, directories[1]!, directories[2]!);
