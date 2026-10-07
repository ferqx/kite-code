import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import {
  CLI_REGISTRATION_FILE,
  readCLIRegistration,
} from '../../../apps/cli/host/cli-registration';
import { buildNativeCandidate } from '../../../apps/desktop/scripts/build-native';
import {
  installNativeBundle,
  uninstallNativeBundle,
} from '../../../scripts/release/native-install';
import {
  buildTerminalBundle,
  installTerminalBundle,
} from '../../../scripts/release/terminal-bundle';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const repositoryRoot = resolve(import.meta.dir, '../../..');
test.skipIf(process.platform !== 'darwin')(
  'actual installed standard and Native PATH entries run the selected full Native closure; cached standard recovers and Native-path stale hash is explicit',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-cli-registration-live-'));
    const home = join(root, 'home'),
      workspace = join(home, 'workspace');
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const profile = selectProfile({
      dataRoot: join(home, '.kite-code/unified-agent'),
      profile: 'default',
    });
    let calls = 0,
      nativeRoot = '',
      observedNativeCLI = false,
      observedNativeService = false,
      observedNativeTUI = false;
    let preserved: { database: string; config: string; caller: string } | undefined;
    const snapshots = () => ({
      database: sha(readFileSync(profile.databasePath)),
      config: sha(readFileSync(join(profile.profilePath, 'config.jsonc'))),
      caller: sha(readFileSync(join(profile.profilePath, 'ui/caller-intents.json'))),
    });
    let nativePrefix = '';
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === '/uninstall') {
          preserved = snapshots();
          uninstallNativeBundle(nativePrefix);
          return Response.json({ removed: true });
        }
        const body = (await request.json()) as { messages: { role: string; content: string }[] };
        const content = body.messages.filter((message) => message.role === 'user').at(-1)!.content;
        expect(['完整 Native CLI 申请\r\n中🪁', 'Registered TUI task']).toContain(content);
        calls++;
        const registrationBefore = readCLIRegistration(
          readCLIRegistration(nativePrefix, true)!.terminalPrefix,
        );
        expect(() => uninstallNativeBundle(nativePrefix)).toThrow('Lock is busy');
        expect(readCLIRegistration(registrationBefore!.terminalPrefix)).toEqual(registrationBefore);
        const owned = String(execFileSync('/bin/ps', ['-axo', 'pid=,comm=,args=']))
          .split('\n')
          .filter((line) => line.includes(nativeRoot));
        observedNativeCLI ||= owned.some(
          (line) =>
            line.includes('/terminal/runtime/bun') &&
            line.includes('/terminal/entrypoints/native-cli.js'),
        );
        observedNativeService ||= owned.some(
          (line) =>
            line.includes('/terminal/runtime/bun') &&
            line.includes('/node_modules/@kite-ai/service/main.js'),
        );
        observedNativeTUI ||= owned.some(
          (line) =>
            line.includes('/terminal/runtime/bun') &&
            line.includes('/terminal/entrypoints/native-tui.js'),
        );
        const frame = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'registration', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(
          frame(
            {
              content:
                content === 'Registered TUI task'
                  ? 'Registered TUI complete'
                  : 'Registered Native complete',
            },
            null,
          ) +
            frame({}, 'stop') +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const execute = async (argv: string[], path: string) => {
      const child = Bun.spawn(argv, {
        cwd: workspace,
        env: { HOME: home, PATH: path, LANG: 'C.UTF-8', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { code, stdout, stderr };
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      const storeId = (await store.getMetadata()).storeId;
      await store.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        name: 'Owned registration',
        rootUri: pathToFileURL(workspace).href,
      });
      await store.createSession({
        expectedStoreId: storeId,
        subjectId: 'local-user',
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        title: 'Registered',
      });
      await store.close();
      writeFileSync(
        join(profile.profilePath, 'config.jsonc'),
        JSON.stringify({
          modelId: 'fixed',
          tools: [],
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
      const terminal = await buildTerminalBundle({ destination: join(root, 'terminal-source') });
      const req = createRequire(join(repositoryRoot, 'apps/desktop/package.json'));
      const electronDist = resolve(dirname(dirname(req('electron') as string)), '../..');
      const native = await buildNativeCandidate({
        terminalRoot: terminal.root,
        electronDist,
        outdir: join(root, 'native-source'),
      });
      const standalone = installTerminalBundle({
        bundleRoot: terminal.root,
        prefix: join(root, 'standalone'),
      });
      const installed = installNativeBundle({
        bundleRoot: native.root,
        prefix: join(root, 'native'),
        cliPrefix: standalone.root,
      });
      nativePrefix = installed.root;
      nativeRoot = installed.releaseRoot;
      rmSync(terminal.root, { recursive: true });
      const body = {
        kind: 'run.start',
        expectedStoreId: storeId,
        commandId: 'registered-work',
        content: '完整 Native CLI 申请\r\n中🪁',
      };
      const first = await execute(
        [
          '/bin/bash',
          '--noprofile',
          '--norc',
          '-c',
          'hash kite; hash -t kite; kite "$@"',
          'owned',
          'work',
          's',
          '--input',
          JSON.stringify(body),
        ],
        `${standalone.root}/bin:${installed.root}/bin:/usr/bin:/bin`,
      );
      expect(first.code).toBe(0);
      expect(first.stdout).toContain(`${standalone.root}/bin/kite`);
      expect(first.stdout).toContain('completed');
      expect(calls).toBe(1);
      expect(observedNativeCLI).toBe(true);
      expect(observedNativeService).toBe(true);
      const intent = JSON.parse(
        readFileSync(join(profile.profilePath, 'ui/caller-intents.json'), 'utf8'),
      ).records[0].intent;
      expect(intent.request).toEqual(body);
      expect(intent.scope).toEqual({ storeId, sessionId: 's', workspaceId: 'w' });
      const second = await execute(
        [
          '/bin/bash',
          '--noprofile',
          '--norc',
          '-c',
          'hash kite; hash -t kite; kite "$@"',
          'owned',
          'work',
          's',
          '--input',
          JSON.stringify({ ...body, commandId: 'native-direct-work' }),
        ],
        `${installed.root}/bin:${standalone.root}/bin:/usr/bin:/bin`,
      );
      expect(second.code).toBe(0);
      expect(second.stdout).toContain(`${installed.root}/bin/kite`);
      expect(second.stdout).toContain('completed');
      expect(calls).toBe(2);
      const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(join(standalone.root, 'bin/kite-tui'))},'--thread','s','--workspace',${JSON.stringify(workspace)}],env={'PATH':'/usr/bin:/bin','HOME':${JSON.stringify(home)},'LANG':'C.UTF-8','TERM':'xterm-256color'},stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);buffer=b''
def read_until(text, seconds):
 global buffer
 end=time.monotonic()+seconds
 while text not in re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace')):
  if time.monotonic()>end:raise RuntimeError('registered PTY deadline '+buffer[-4000:].decode(errors='replace'))
  if select.select([master],[],[],.05)[0]:buffer+=os.read(master,65536)
try:
 read_until('Registered Native complete',20)
 os.write(master,b'Registered TUI task')
 read_until('Registered TUI task',10)
 os.write(master,b'\\r')
 read_until('Registered TUI complete',10)
 os.write(master,b'\\x11');end=time.monotonic()+5
 while p.poll() is None and time.monotonic()<end:
  if select.select([master],[],[],.05)[0]:
   try:buffer+=os.read(master,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0;open(${JSON.stringify(join(root, 'registered-pty-output'))},'wb').write(buffer);print('REGISTERED_PTY_COMPLETE')
finally:
 if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
 open(${JSON.stringify(join(root, 'registered-pty-output'))},'wb').write(buffer)
 os.close(master)
`;
      const pty = await execute(['/usr/bin/python3', '-c', program], '/usr/bin:/bin');
      if (pty.code !== 0) console.error({ phase: 'cli_registration_pty', root, ...pty });
      expect(pty.code).toBe(0);
      expect(pty.stdout).toContain('REGISTERED_PTY_COMPLETE');
      expect(calls).toBe(3);
      expect(observedNativeTUI).toBe(true);
      const persisted = JSON.parse(
        readFileSync(join(profile.profilePath, 'ui/caller-intents.json'), 'utf8'),
      ).records as { intent: { request: { commandId: string } } }[];
      const commandIds = persisted.map((record) => record.intent.request.commandId);
      expect(commandIds).toHaveLength(3);
      const observe = async () => {
        const result = await execute(
          [
            join(standalone.releaseRoot, 'runtime/bun'),
            '-e',
            `import {openSqliteStore} from ${JSON.stringify(pathToFileURL(join(standalone.releaseRoot, 'node_modules/@kite-ai/agent/sqlite.js')).href)}; const store=await openSqliteStore(${JSON.stringify({ dataRoot: profile.dataRoot, profile: profile.profile, mode: 'readonly' })}); try { const commands=await Promise.all(${JSON.stringify(commandIds)}.map(id=>store.getCommand(id))); const runs=await Promise.all(commands.map(command=>store.getRun(command.receipt.runId))); console.log(JSON.stringify({command:commands[0],commands,runs,session:await store.getSession('s'),metadata:await store.getMetadata()})); } finally {await store.close();}`,
          ],
          '/usr/bin:/bin',
        );
        expect(result.code).toBe(0);
        return JSON.parse(result.stdout) as {
          command: { originStoreId: string; status: string; requestDigest: string };
          metadata: { storeId: string; lastChangeCursor: string };
          session: { workspaceId: string };
          commands: { id: string; receipt: { runId: string } }[];
          runs: {
            id: string;
            originCommandId: string;
            originStoreId: string;
            sessionId: string;
            status: string;
          }[];
        };
      };
      const original = await observe(),
        command = original.command,
        before = original.metadata;
      const assertRuns = (value: Awaited<ReturnType<typeof observe>>) => {
        expect(value.session.workspaceId).toBe('w');
        expect(value.runs).toHaveLength(3);
        value.runs.forEach((run, index) => {
          expect(run).toMatchObject({
            id: value.commands[index]!.receipt.runId,
            originCommandId: commandIds[index],
            originStoreId: storeId,
            sessionId: 's',
            status: 'completed',
          });
        });
      };
      assertRuns(original);
      expect(command.originStoreId).toBe(storeId);
      expect(command.status).toBe('applied');
      expect(command.requestDigest).toBe(intent.requestDigest);
      const coldArgs = ['caller', 'lookup', 's', '--input', JSON.stringify(intent)];
      const direct = await execute(
        [join(installed.root, 'bin/kite'), ...coldArgs],
        `${installed.root}/bin:${standalone.root}/bin:/usr/bin:/bin`,
      );
      expect(direct.code).toBe(0);
      expect(direct.stdout).toContain(body.commandId);
      expect(calls).toBe(3);
      const recordPath = join(standalone.root, CLI_REGISTRATION_FILE),
        record = readFileSync(recordPath);
      writeFileSync(
        recordPath,
        JSON.stringify({ ...readCLIRegistration(standalone.root), nonce: 'f'.repeat(32) }),
      );
      const bad = await execute([join(standalone.root, 'bin/kite'), ...coldArgs], '/usr/bin:/bin');
      expect(bad.code).not.toBe(0);
      expect(bad.stderr).toContain('cli_registration_owner_mismatch');
      expect(calls).toBe(3);
      writeFileSync(recordPath, record);
      // One real shell retains its original standard hash while registration disappears.
      const cleanup = await execute(
        [
          '/bin/bash',
          '--noprofile',
          '--norc',
          '-c',
          `hash kite; hash -t kite; /usr/bin/curl -fsS ${JSON.stringify(`${provider.url.href}uninstall`)}; kite "$@"`,
          'owned',
          ...coldArgs,
        ],
        `${standalone.root}/bin:${installed.root}/bin:/usr/bin:/bin`,
      );
      expect(cleanup.code).toBe(0);
      expect(cleanup.stdout).toContain(`${standalone.root}/bin/kite`);
      expect(cleanup.stdout).toContain(body.commandId);
      expect(snapshots()).toEqual(preserved!);
      expect(calls).toBe(3);
      // Native-first PATH has a distinct parent-shell cache; observe it rather than claiming child uninstall can clear it.
      const reinstalled = installNativeBundle({
        bundleRoot: native.root,
        prefix: installed.root,
        cliPrefix: standalone.root,
      });
      nativeRoot = reinstalled.releaseRoot;
      const nativeFirst = await execute(
        [
          '/bin/bash',
          '--noprofile',
          '--norc',
          '-c',
          `hash kite; hash -t kite; kite "$@"; /usr/bin/curl -fsS ${JSON.stringify(`${provider.url.href}uninstall`)}; kite "$@"; stale=$?; echo "NATIVE_HASH_STALE=$stale"; hash -r; kite "$@"`,
          'owned',
          ...coldArgs,
        ],
        `${installed.root}/bin:${standalone.root}/bin:/usr/bin:/bin`,
      );
      expect(nativeFirst.code).toBe(0);
      expect(nativeFirst.stdout).toContain(`${installed.root}/bin/kite`);
      expect(nativeFirst.stdout).toContain('NATIVE_HASH_STALE=127');
      expect(nativeFirst.stderr).toContain('No such file or directory');
      expect(calls).toBe(3);
      expect(snapshots()).toEqual(preserved!);
      const fresh = await execute(
        ['/bin/bash', '--noprofile', '--norc', '-c', 'kite "$@"', 'owned', ...coldArgs],
        `${installed.root}/bin:${standalone.root}/bin:/usr/bin:/bin`,
      );
      expect(fresh.code).toBe(0);
      expect(fresh.stdout).toContain(body.commandId);
      expect(calls).toBe(3);
      expect(readCLIRegistration(standalone.root)).toBeUndefined();
      expect(existsSync(installed.root)).toBe(false);
      const after = await observe();
      assertRuns(after);
      expect(after.metadata.storeId).toBe(storeId);
      expect(after.metadata.lastChangeCursor).toBe(before.lastChangeCursor);
      console.log(
        JSON.stringify({
          qualification: 'native-cli-registration',
          root,
          terminal: standalone.candidateId,
          native: installed.candidateId,
          storeId,
          calls,
          observedNativeCLI,
          observedNativeService,
          observedNativeTUI,
        }),
      );
    } finally {
      provider.stop(true);
    }
  },
  120000,
);
