import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { createClient, requiresInteractionAttachment } from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';
import type { CLIServiceArtifact } from '../../host';
import { verifyTerminalBundle } from '../../host/terminal-artifact';

const repo = resolve(import.meta.dir, '../../../..');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = performance.now() + 10000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw Error('owned_cold_mcp_pty_deadline');
    await Bun.sleep(20);
  }
}
type HttpRow = {
  pid: number;
  phase: string;
  method: string;
  path: string;
  body?: { kind?: string; commandId?: string };
};
test('80x24 cold TUI selects the second real original MCP intent from an empty catalogue with GET-only recovery', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-mcp-cold-pty-'));
  const evidence = `/private/tmp/kite-mcp-cold-pty-evidence-${randomUUID()}`;
  mkdirSync(evidence, { mode: 0o700 });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
  let rpc = 0;
  const remote = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      rpc++;
      return new Response('forbidden', { status: 500 });
    },
  });
  let observer: ReturnType<typeof createClient> | undefined;
  let control: ReturnType<typeof Bun.serve> | undefined;
  let python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let artifact: CLIServiceArtifact | undefined;
  let storeId = '';
  let subjectId: string | undefined;
  const receipts: Record<string, unknown>[] = [];
  const originals: string[] = [];
  const ledger = (): HttpRow[] =>
    existsSync(join(root, 'http-ledger.jsonl'))
      ? readFileSync(join(root, 'http-ledger.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const selectionPosts = (phase: string) =>
    ledger().filter(
      (row) =>
        row.phase === phase && row.method === 'POST' && row.body?.kind === 'extension.invoke',
    );
  let phase: 'warm' | 'cold' = 'warm';
  const configPath = join(profile.profilePath, 'config.jsonc');
  const projectPath = join(workspace, 'kite-agent.jsonc');
  const journalPath = join(profile.profilePath, 'ui/mcp-selection-intents.json');
  try {
    const build = Bun.spawn(
      [
        process.execPath,
        join(repo, 'scripts/release/terminal.ts'),
        'build',
        '--directory',
        join(root, 'candidate'),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [out, err, exit] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ]);
    writeFileSync(join(evidence, 'candidate-build.log'), out + err);
    expect(exit).toBe(0);
    const candidate = verifyTerminalBundle(join(root, 'candidate'));
    symlinkSync(join(candidate.root, 'node_modules'), join(root, 'node_modules'));
    const built = await Bun.build({
      entrypoints: [join(repo, 'apps/cli/test/fixtures/tui-mcp-cold-pty.ts')],
      target: 'bun',
      packages: 'external',
      outdir: root,
    });
    expect(built.success).toBe(true);
    const entrypoint = join(root, 'tui-mcp-cold-pty.js');
    artifact = {
      executable: candidate.artifact.executable,
      executableSha256: candidate.artifact.executableSha256,
      apiMajor: 1,
      entrypoint,
      entrypointSha256: sha(readFileSync(entrypoint)),
      buildId: `cold-mcp-pty-${randomUUID()}`,
    };
    const publish = () =>
      writeFileSync(
        join(root, 'settings.json'),
        JSON.stringify({
          root,
          workspace,
          dataRoot: profile.dataRoot,
          mcpUrl: remote.url.href,
          artifact,
          phase,
        }),
        { mode: 0o600 },
      );
    publish();
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    writeFileSync(
      configPath,
      '// USER COMMENT\n{"unknown":{"keep":true},"mcp":[{"id":"owned-server","enabled":false}]}\n',
      { mode: 0o600 },
    );
    writeFileSync(projectPath, '// PROJECT COMMENT\n{"unknown":42}\n', { mode: 0o600 });
    mkdirSync(join(profile.profilePath, 'ui'), { mode: 0o700 });
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}\n', {
      mode: 0o600,
    });
    const seed = await launchPairedService({
      profile,
      ...artifact,
      instanceId: randomUUID(),
      requiredCapabilities: ['sessions', 'commands'],
    });
    try {
      storeId = seed.bootstrap.storeId!;
      await seed.client.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        rootUri: pathToFileURL(workspace).href,
        name: 'owned',
      });
      await seed.client.createSession({
        expectedStoreId: storeId,
        commandId: 'create-a',
        sessionId: 'a',
        workspaceId: 'w',
        title: 'cold original choices',
      });
    } finally {
      await seed.close();
      expect(() => process.kill(seed.pid, 0)).toThrow();
      receipts.push({ stage: 'seed-closed', servicePid: seed.pid, exited: true });
    }
    async function connected() {
      if (observer) return observer;
      const privateRow = JSON.parse(
        readFileSync(join(root, `${phase}-observer-private.json`), 'utf8'),
      ) as { endpoint: string; token: string };
      observer = createClient({
        ...privateRow,
        expected: {
          profile: {
            dataRoot: profile.dataRoot,
            name: profile.profile,
            accessKey: profile.profileAccessKey,
          },
          apiMajor: 1,
          requiredCapabilities: ['sessions', 'commands', 'interactions'],
        },
      });
      await observer.connect();
      expect(observer.serverInfo!.storeId).toBe(storeId);
      if (subjectId === undefined) subjectId = observer.serverInfo!.subjectId;
      else expect(observer.serverInfo!.subjectId).toBe(subjectId);
      return observer;
    }
    let coldBaseline = 0;
    control = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        try {
          const path = new URL(request.url).pathname;
          const client = await connected();
          if (path.startsWith('/approve-')) {
            const ordinal = Number(path.slice('/approve-'.length));
            const posts = selectionPosts('warm');
            expect(posts).toHaveLength(ordinal);
            const id = posts[ordinal - 1]!.body!.commandId!;
            originals.push(id);
            const command = await until(async () => {
              const row = await client.getCommand(id);
              return row.status === 'applied' ? row : undefined;
            });
            const executionId = (command.receipt as { executionId: string }).executionId;
            const card = await until(async () =>
              (
                await client.listInteractions('a', { storeId, state: 'pending', limit: 20 })
              ).interactions.find((row) => row.executionId === executionId),
            );
            expect(readFileSync(configPath, 'utf8')).toContain(
              `"enabled":${ordinal === 1 ? 'false' : 'true'}`,
            );
            if (requiresInteractionAttachment(card)) await client.readInteractionAttachment(card);
            await client.answerInteraction('a', card.id, {
              expectedStoreId: storeId,
              commandId: `approve-original-${ordinal}`,
              expectedRevision: card.revision,
              answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
            });
            const execution = await until(async () => {
              const row = await client.getExecution(executionId);
              return row.status === 'succeeded' ? row : undefined;
            });
            const details = (execution.result as { details: Record<string, unknown> }).details;
            const mutation = await client.getHostMutation((details.mutation as { id: string }).id, {
              storeId,
            });
            expect(mutation.state).toBe('applied');
            expect(readFileSync(configPath, 'utf8')).toContain('// USER COMMENT');
            expect(readFileSync(configPath, 'utf8')).toContain('"keep":true');
            receipts.push({
              stage: path,
              storeId,
              subjectId,
              command,
              execution,
              mutation,
              cardId: card.id,
            });
          } else if (path === '/warm-closed') {
            const servicePid = Number(readFileSync(join(root, 'warm-owned-pid'), 'utf8'));
            expect(() => process.kill(servicePid, 0)).toThrow();
            const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
              records: { intent: { request: { commandId: string } } }[];
            };
            expect(journal.records.map((row) => row.intent.request.commandId)).toEqual(originals);
            expect(originals).toHaveLength(2);
            writeFileSync(join(evidence, 'warm-journal.json'), readFileSync(journalPath));
            writeFileSync(join(evidence, 'warm-config.jsonc'), readFileSync(configPath));
            observer!.disposeNetwork();
            observer = undefined;
            // Remove only the owned catalogue/selection after both original effects are verified.
            phase = 'cold';
            writeFileSync(configPath, '// USER COMMENT\n{"unknown":{"keep":true},"mcp":[]}\n', {
              mode: 0o600,
            });
            publish();
            receipts.push({ stage: path, servicePid, exited: true, originals });
          } else if (path === '/cold-open') {
            expect(selectionPosts('cold')).toHaveLength(0);
            const originalGets = ledger().filter(
              (row) =>
                row.phase === 'cold' &&
                row.method === 'GET' &&
                originals.some((id) => row.path.endsWith(`/commands/${id}`)),
            );
            expect(originalGets).toHaveLength(0);
            coldBaseline = ledger().length;
          } else if (path === '/cold-selected') {
            expect(
              ledger()
                .slice(coldBaseline)
                .filter(
                  (row) =>
                    row.method === 'GET' &&
                    originals.some((id) => row.path.endsWith(`/commands/${id}`)),
                ),
            ).toHaveLength(0);
            expect(selectionPosts('cold')).toHaveLength(0);
          } else if (path === '/cold-lookup') {
            const originalGets = ledger()
              .slice(coldBaseline)
              .filter(
                (row) =>
                  row.method === 'GET' &&
                  originals.some((id) => row.path.endsWith(`/commands/${id}`)),
              );
            expect(originalGets.map((row) => row.path.split('/').at(-1))).toEqual([originals[1]!]);
            expect(selectionPosts('cold')).toHaveLength(0);
            const view = await client.getView('a');
            expect(view.storeId).toBe(storeId);
            expect(view.session.workspaceId).toBe('w');
            expect(view.runs).toHaveLength(0);
            expect(view.executions.filter((row) => row.kind === 'model')).toHaveLength(0);
            const command = await client.getCommand(originals[1]!);
            const execution = await client.getExecution(
              (command.receipt as { executionId: string }).executionId,
            );
            expect(execution.status).toBe('succeeded');
            const mutation = await client.getHostMutation(
              (execution.result as { details: { mutation: { id: string } } }).details.mutation.id,
              { storeId },
            );
            expect(mutation.state).toBe('applied');
            receipts.push({ stage: path, storeId, subjectId, command, execution, mutation, view });
          }
          return Response.json({ passed: true, originals });
        } catch (error) {
          writeFileSync(
            join(evidence, 'control-error.json'),
            JSON.stringify({ phase, error: String(error) }),
          );
          return new Response(String(error), { status: 500 });
        }
      },
    });
    const program = `import os,pty,subprocess,select,time,fcntl,termios,struct,re,json,urllib.request
all_output=b''; p=None; m=None
def publish_pid():
 with open(${JSON.stringify(join(root, 'pty-pids.jsonl'))}, 'a') as channel:
  channel.write(json.dumps({'pid':p.pid,'pgid':os.getpgid(p.pid)})+'\\n');channel.flush();os.fsync(channel.fileno())
def start():
 global p,m,b
 m,s=pty.openpty();fcntl.ioctl(s,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(artifact.executable)},${JSON.stringify(entrypoint)}],stdin=s,stdout=s,stderr=s,start_new_session=True);os.close(s);publish_pid();b=b''
def current_frame():
 frames=b.decode(errors='replace').split('\\x1b[?2026h')
 raw=next((part.split('\\x1b[?2026l')[0] for part in reversed(frames[1:]) if '\\x1b[?2026l' in part),'')
 return re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',raw)
def selected_label():
 return next((line.strip()[2:] for line in current_frame().splitlines() if line.strip().startswith('› ')),None)
def wait(text, absent=None):
 global b,all_output
 end=time.monotonic()+10
 while True:
  frame=re.sub(r'\\s+',' ',current_frame())
  if text in frame and (absent is None or absent not in frame):return
  if p.poll() is not None:raise RuntimeError('early exit '+b[-3000:].decode(errors='replace'))
  if time.monotonic()>end:raise RuntimeError('expected '+text+' tail='+b[-5000:].decode(errors='replace'))
  if select.select([m],[],[],.05)[0]:
   data=os.read(m,65536);b+=data;all_output+=data
def key(value):
 global b
 b=b'';os.write(m,value)
def choose(label):
 global b,all_output
 end=time.monotonic()+10
 if selected_label()==label:return
 if selected_label()!='Project sources':
  key(b'\\x1b[A'*64);wait('› Project sources')
 while selected_label()!=label:
  previous=selected_label();key(b'\\x1b[B')
  while selected_label() is None or selected_label()==previous:
   if time.monotonic()>end:raise RuntimeError('original MCP selection did not move: '+label)
   if select.select([m],[],[],.05)[0]:
    data=os.read(m,65536);b+=data;all_output+=data
def check(path):
 with urllib.request.urlopen(${JSON.stringify(control.url.href)}+path,timeout=12) as response:return json.load(response)
def quit():
 global m
 key(b'\\x11');end=time.monotonic()+6
 while p.poll() is None and time.monotonic()<end:
  if select.select([m],[],[],.05)[0]:
   try:os.read(m,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0;pid=p.pid;os.close(m);m=None;return pid
try:
 start();wait('New Run')
 for ordinal in [1,2]:
  key(b'/mcp');wait('/mcp');key(b'\\r');wait('owned-server','Reading servers');wait('Server list ready');key(b'\\x1b[B');wait('› owned-server ·');key(b'\\r');wait('Server: owned-server');key(b'\\x1b[B');wait('› '+('Enable' if ordinal==1 else 'Disable')+' · User settings');key(b'\\r');wait('Confirm server change:');key(b'\\r');wait('Waiting for original result');row=check('approve-'+str(ordinal));key(b'\\x1b[B'*2);wait('› Check original change');key(b'\\r');wait('Selection saved');key(b'\\x1b');wait('New Run')
 warm=quit();row=check('warm-closed');second=row['originals'][1]
 start();wait('New Run');key(b'/mcp');wait('/mcp');key(b'\\r');wait('No configured MCP servers');wait('Original change: '+second);check('cold-open')
 choose('Original change: '+second);key(b'\\r');wait('Original change: '+second+' · Outcome unknown; check original change');check('cold-selected');choose('Check original change');key(b'\\r');wait('Selection saved');check('cold-lookup');key(b'\\x1b');wait('New Run');cold=quit();print(json.dumps({'columns':80,'rows':24,'warmPid':warm,'coldPid':cold,'exit':0}))
finally:
 with open(${JSON.stringify(join(evidence, 'terminal.txt'))},'wb') as f:f.write(all_output)
 if p is not None and p.poll() is None:os.killpg(p.pid,9);p.wait(timeout=5)
 if m is not None:os.close(m)
`;
    python = Bun.spawn(['python3', '-c', program], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        HOME: root,
        KITE_CODE_HOME: join(root, 'owned-home'),
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        TERM: 'xterm-256color',
        NO_COLOR: '1',
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(python.stdout).text(),
      new Response(python.stderr).text(),
      python.exited,
    ]);
    writeFileSync(join(evidence, 'python-stdout.log'), stdout);
    writeFileSync(join(evidence, 'python-stderr.log'), stderr);
    expect(code).toBe(0);
    const pids = JSON.parse(stdout) as { warmPid: number; coldPid: number };
    for (const pid of [
      pids.warmPid,
      pids.coldPid,
      Number(readFileSync(join(root, 'cold-owned-pid'), 'utf8')),
    ])
      expect(() => process.kill(pid, 0)).toThrow();
    expect(rpc).toBe(0);
    expect(existsSync(join(root, 'credential-io'))).toBe(false);
    expect(existsSync(join(root, 'mcp-admit'))).toBe(false);
    expect(selectionPosts('warm')).toHaveLength(2);
    expect(selectionPosts('cold')).toHaveLength(0);
    expect(ledger().filter((row) => row.phase === 'cold' && row.method === 'POST')).toHaveLength(0);
    expect(ledger().filter((row) => row.path.endsWith('/cancel'))).toHaveLength(0);
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      records: { intent: { request: { commandId: string } } }[];
    };
    expect(journal.records.map((row) => row.intent.request.commandId)).toEqual(originals);
    expect(readFileSync(projectPath, 'utf8')).toBe('// PROJECT COMMENT\n{"unknown":42}\n');
    writeFileSync(
      join(evidence, 'receipts.json'),
      JSON.stringify(
        {
          artifact,
          candidateManifestSha: candidate.digest,
          pids,
          storeId,
          subjectId,
          originals,
          rpc,
          receipts,
          ledger: ledger(),
          cleanup: 'await_finally',
        },
        null,
        2,
      ),
    );
  } finally {
    async function cleanupOwned() {
      let cleanupError: unknown;
      const cleanupPids = new Set<number>();
      try {
        if (python?.exitCode === null) {
          // SIGINT enters Python's finally, which kills only its owned TUI process group.
          python.kill('SIGINT');
          const stopped = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), 9000);
            void python!.exited.then(() => {
              clearTimeout(timer);
              resolve(true);
            });
          });
          if (!stopped) throw Error('python_cleanup_unconfirmed');
        }
        for (const row of ledger()) cleanupPids.add(row.pid);
        const channel = join(root, 'pty-pids.jsonl');
        if (existsSync(channel))
          for (const line of readFileSync(channel, 'utf8').trim().split('\n')) {
            const row = JSON.parse(line) as { pid: number; pgid: number };
            if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || row.pgid !== row.pid)
              throw Error('owned_pty_pid_channel_invalid');
            cleanupPids.add(row.pid);
          }
        for (const name of ['warm-owned-pid', 'cold-owned-pid'])
          if (existsSync(join(root, name)))
            cleanupPids.add(Number(readFileSync(join(root, name), 'utf8')));
        for (const pid of cleanupPids)
          await until(async () => {
            try {
              process.kill(pid, 0);
              return undefined;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
              return true;
            }
          });
      } catch (error) {
        cleanupError = error;
      } finally {
        try {
          for (const name of [
            'http-ledger.jsonl',
            'warm-owned-pid',
            'cold-owned-pid',
            'pty-pids.jsonl',
          ])
            if (existsSync(join(root, name)))
              writeFileSync(join(evidence, name), readFileSync(join(root, name)));
          if (existsSync(journalPath))
            writeFileSync(join(evidence, 'journal.json'), readFileSync(journalPath), {
              mode: 0o600,
            });
          for (const [path, name] of [
            [configPath, 'final-user-config.jsonc'],
            [projectPath, 'project-config.jsonc'],
          ])
            if (path && name && existsSync(path))
              writeFileSync(join(evidence, name), readFileSync(path));
          if (artifact && existsSync(artifact.entrypoint))
            writeFileSync(join(evidence, 'helper.js'), readFileSync(artifact.entrypoint));
          writeFileSync(
            join(evidence, 'cleanup.json'),
            JSON.stringify({
              pids: [...cleanupPids],
              exited: cleanupError === undefined,
              ...(cleanupError === undefined
                ? {}
                : { error: String(cleanupError), retainedRoot: root }),
            }),
          );
        } finally {
          try {
            observer?.disposeNetwork();
          } finally {
            try {
              await control?.stop(true);
            } finally {
              await remote.stop(true);
            }
          }
        }
      }
      if (cleanupError === undefined) rmSync(root, { recursive: true, force: true });
      console.error(
        JSON.stringify({
          evidence,
          originals,
          storeId,
          ...(cleanupError === undefined
            ? {}
            : { retainedRoot: root, cleanupError: String(cleanupError) }),
        }),
      );
      if (cleanupError !== undefined) throw cleanupError;
    }
    await cleanupOwned();
  }
}, 180000);
