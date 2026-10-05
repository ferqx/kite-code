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
import { ClientError, createClient, requiresInteractionAttachment } from '@kite-ai/client';
import { bootstrapSchema } from '@kite-ai/service/daemon';
import { launchPairedService } from '@kite-ai/service/paired';
import type { CLIServiceArtifact } from '../../host';
import { verifyTerminalBundle } from '../../host/terminal-artifact';
import { createTuiMcpPort } from '../../host/tui-mcp';

const repo = resolve(import.meta.dir, '../../../..');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function until<T>(
  label: string,
  work: () => Promise<T | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = performance.now() + 10000;
  for (;;) {
    signal?.throwIfAborted();
    const value = await work();
    signal?.throwIfAborted();
    if (value !== undefined) return value;
    if (performance.now() >= deadline) throw Error(`owned_connection_deadline:${label}`);
    await Bun.sleep(10);
  }
}
type HttpRow = {
  phase: string;
  pid: number;
  method: string;
  path: string;
  body?: { kind?: string };
};

test('80x24 TUI explicitly requests cold connections and checks original warm/cold receipts without replay; paired drains and shared detaches', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-tui-mcp-connection-'));
  const evidence = `/private/tmp/kite-tui-mcp-connection-evidence-${randomUUID()}`;
  mkdirSync(evidence, { mode: 0o700 });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
  let phase: 'warm' | 'cold' = 'warm';
  let serviceMode: 'paired' | 'shared' = 'paired',
    server: string | undefined;
  let daemon: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
  let daemonErrors: Promise<string> | undefined;
  const rpc: { phase: string; method: string }[] = [];
  const facts: unknown[] = [];
  let modelCalls = 0,
    success = false,
    cleanupConfirmed = false;
  let python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let build: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let observer: ReturnType<typeof createClient> | undefined;
  let seed: Awaited<ReturnType<typeof launchPairedService>> | undefined;
  let control: ReturnType<typeof Bun.serve> | undefined;
  let artifact: CLIServiceArtifact | undefined;
  let storeId = '',
    subjectId: string | undefined,
    failure: unknown,
    cleanupError: unknown;
  const businessAbort = new AbortController(),
    controlWork = new Set<Promise<Response>>();
  const ledger = (name: string): unknown[] =>
    existsSync(join(root, name))
      ? readFileSync(join(root, name), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const http = () => ledger('ui-http.jsonl') as HttpRow[];
  const model = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      modelCalls++;
      return new Response('owned_model_forbidden', { status: 500 });
    },
  });
  const peer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const row = (await request.json()) as { id?: number | string; method: string };
      rpc.push({ phase, method: row.method });
      if (row.id === undefined) return new Response(null, { status: 202 });
      const tools = [
        {
          name: 'owned-tool',
          description: 'Finite explicitly connected Tool',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
          outputSchema: { type: 'object' },
        },
      ];
      const result =
        row.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'owned-connection', version: '1' },
              capabilities: { tools: {} },
            }
          : row.method === 'tools/list'
            ? { tools }
            : undefined;
      if (result === undefined) {
        facts.push({ unexpectedRpc: row.method });
        return Response.json({
          jsonrpc: '2.0',
          id: row.id,
          error: { code: -32601, message: 'owned_unexpected_rpc' },
        });
      }
      return Response.json({ jsonrpc: '2.0', id: row.id, result });
    },
  });
  try {
    build = Bun.spawn(
      [
        process.execPath,
        join(repo, 'scripts/release/terminal.ts'),
        'build',
        '--directory',
        join(root, 'candidate'),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [out, err, code] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ]);
    writeFileSync(join(evidence, 'build.log'), out + err);
    expect(code).toBe(0);
    const candidate = verifyTerminalBundle(join(root, 'candidate'));
    writeFileSync(
      join(evidence, 'candidate.json'),
      JSON.stringify(
        {
          digest: candidate.digest,
          candidateId: candidate.candidateId,
          buildId: candidate.buildId,
          manifest: candidate.manifest,
        },
        null,
        2,
      ),
    );
    symlinkSync(join(candidate.root, 'node_modules'), join(root, 'node_modules'));
    const bundled = await Bun.build({
      entrypoints: [join(import.meta.dir, '../fixtures/tui-mcp-connection.ts')],
      outdir: root,
      naming: 'host.js',
      target: 'bun',
      packages: 'external',
    });
    expect(bundled.success).toBe(true);
    artifact = {
      executable: candidate.artifact.executable,
      executableSha256: candidate.artifact.executableSha256,
      entrypoint: join(root, 'host.js'),
      entrypointSha256: sha(readFileSync(join(root, 'host.js'))),
      buildId: 'owned-connection',
      apiMajor: 1,
    };
    writeFileSync(join(evidence, 'host.js'), readFileSync(artifact.entrypoint));
    const settings = () =>
      writeFileSync(
        join(root, 'settings.json'),
        JSON.stringify({
          root,
          workspace,
          dataRoot: profile.dataRoot,
          mcpUrl: `${peer.url.href}mcp`,
          artifact,
          phase,
          serviceMode,
          ...(server ? { server } : {}),
        }),
        { mode: 0o600 },
      );
    settings();
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(profile.profilePath, 'mcp.json'),
      JSON.stringify({
        mcpServers: { owned: { type: 'http', url: `${peer.url.href}mcp`, auth: { type: 'none' } } },
      }),
      { mode: 0o600 },
    );
    seed = await launchPairedService({
      ...artifact,
      profile,
      instanceId: randomUUID(),
      requiredCapabilities: ['sessions', 'commands', 'interactions'],
    });
    storeId = seed.bootstrap.storeId!;
    subjectId = seed.bootstrap.subjectId;
    await seed.client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(workspace).href,
    });
    await seed.client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 'a',
      workspaceId: 'w',
      title: 'Owned MCP Tools',
    });
    const directory = await createTuiMcpPort(seed.client, storeId).read('a', businessAbort.signal);
    expect(directory.items).toHaveLength(1);
    const selectedServerId = directory.items[0]!.id;
    facts.push({ stage: 'configured-source', serverId: selectedServerId });
    mkdirSync(join(profile.profilePath, 'ui'), { mode: 0o700 });
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        mcp: [{ id: selectedServerId, enabled: true }],
        modelId: 'forbidden',
        models: [
          {
            id: 'forbidden',
            provider: 'compatible',
            model: 'forbidden',
            baseURL: `${model.url.href}v1`,
          },
        ],
      }),
      { mode: 0o600 },
    );
    await seed.close();
    expect(await seed.exited).toBe(0);
    seed = undefined;
    async function connected() {
      businessAbort.signal.throwIfAborted();
      if (observer) return observer;
      const privateInfo = await until(
        'observer',
        async () =>
          existsSync(join(root, 'observer-private.json'))
            ? (JSON.parse(readFileSync(join(root, 'observer-private.json'), 'utf8')) as {
                endpoint: string;
                token: string;
              })
            : undefined,
        businessAbort.signal,
      );
      observer = createClient({
        endpoint: privateInfo.endpoint,
        token: privateInfo.token,
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
      businessAbort.signal.throwIfAborted();
      expect(observer.serverInfo!.storeId).toBe(storeId);
      expect(observer.serverInfo!.subjectId).toBe(subjectId);
      return observer;
    }
    async function approve(executionId: string) {
      businessAbort.signal.throwIfAborted();
      const client = await connected();
      const card = await until(
        `approval:${executionId}`,
        async () =>
          (await client.listInteractions('a', { storeId, state: 'pending' })).interactions.find(
            (row) => row.executionId === executionId,
          ),
        businessAbort.signal,
      );
      if (requiresInteractionAttachment(card)) await client.readInteractionAttachment(card);
      businessAbort.signal.throwIfAborted();
      await client.answerInteraction('a', card.id, {
        expectedStoreId: storeId,
        commandId: `approve-${card.id}`,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
      });
      facts.push({ card });
    }
    const submitted = () =>
      http().filter(
        (row) => row.method === 'POST' && row.body?.kind === 'extension.invoke',
      ) as (HttpRow & {
        body: { kind: string; commandId: string; input: { serverId: string; key: string } };
      })[];
    const pendingCommand = async (expectedCount: number) =>
      until(
        'UI original submission',
        async () => {
          const requests = submitted();
          if (requests.length < expectedCount) return undefined;
          if (requests.length !== expectedCount)
            throw Error('owned_connection_duplicate_submission');
          const latest = requests.at(-1)!;
          const client = await connected();
          let command: Awaited<ReturnType<typeof client.getCommand>>;
          try {
            command = await client.getCommand(latest.body.commandId);
          } catch (error) {
            // The UI ledger records the exact attempted POST before Service persists it.
            // Wait only for that original ID's real 404, within the existing submission deadline.
            if (
              error instanceof ClientError &&
              error.code === 'command_not_found' &&
              error.status === 404
            )
              return undefined;
            throw error;
          }
          return command.status === 'applied'
            ? { client, command, input: latest.body.input }
            : undefined;
        },
        businessAbort.signal,
      );
    const factsFor = async (commandId: string, input: { serverId: string; key: string }) => {
      const client = await connected();
      const command = await client.getCommand(commandId);
      const executionId = (command.receipt as { executionId: string }).executionId;
      const response = await client.queryExtension('a', 'builtin.mcp', 'mcp.connection', {
        executionId,
        ...input,
      });
      const fact = response[0]!.payload as Record<string, unknown>;
      expect(fact.storeId).toBe(storeId);
      expect(fact.sessionId).toBe('a');
      return { command, fact };
    };
    let warmBaseline = 0;
    const controlRequest = async (request: Request) => {
      try {
        businessAbort.signal.throwIfAborted();
        const path = new URL(request.url).pathname;
        if (path === '/approve-new' || path === '/approve-reuse') {
          const { client, command, input } = await pendingCommand(
            phase === 'cold' ? 3 : path === '/approve-reuse' ? 2 : 1,
          );
          const actionId = (command.receipt as { executionId: string }).executionId;
          const baseline = rpc.length,
            resolutionBaseline = ledger('resolutions.jsonl').length;
          expect(baseline).toBe(
            phase === 'cold' ? warmBaseline : path === '/approve-new' ? 0 : warmBaseline,
          );
          await approve(actionId);
          if (path === '/approve-new') {
            const job = await until(
              'independent connection Job Ask',
              async () =>
                (
                  await client.listInteractions('a', { storeId, state: 'pending' })
                ).interactions.find((row) => row.definitionId === 'mcp.source.connection'),
              businessAbort.signal,
            );
            expect((await client.getExecution(job.executionId)).parentExecutionId).toBe(actionId);
            expect(rpc.length).toBe(baseline);
            expect(ledger('resolutions.jsonl')).toHaveLength(resolutionBaseline);
            await approve(job.executionId);
          }
          const ready = await until(
            'original Action ready',
            async () => {
              const row = await client.getExecution(actionId);
              return row.status === 'succeeded' ? row : undefined;
            },
            businessAbort.signal,
          );
          const original = await factsFor(command.id, input);
          expect(original.fact.phase).toBe('ready');
          expect(original.fact.created).toBe(path === '/approve-new');
          expect(original.fact.live).toBe(true);
          facts.push({ phase, path, ...original, execution: ready });
          if (phase === 'warm') warmBaseline = rpc.length;
          return Response.json({ commandId: command.id, actionId, ready: true });
        }
        if (path === '/cold') {
          observer?.disposeNetwork();
          observer = undefined;
          phase = 'cold';
          serviceMode = 'shared';
          rmSync(join(profile.profilePath, 'mcp.json'));
          rmSync(join(root, 'observer-private.json'), { force: true });
          settings();
          const web = join(root, 'web');
          mkdirSync(web, { mode: 0o700 });
          const assets = [
            ['/index.html', 'text/html; charset=utf-8', '<title>owned</title>'],
            ['/app.js', 'text/javascript; charset=utf-8', 'globalThis.owned=true;'],
            ['/app.css', 'text/css; charset=utf-8', 'body{color:black}'],
          ].map(([path, mediaType, content]) => {
            writeFileSync(join(web, path!.slice(1)), content!);
            return {
              path,
              mediaType,
              size: Buffer.byteLength(content!),
              sha256: sha(Buffer.from(content!)),
            };
          });
          const manifest = JSON.stringify(assets);
          writeFileSync(join(web, 'manifest.json'), manifest);
          daemon = Bun.spawn([process.execPath, artifact!.entrypoint], {
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
          });
          daemonErrors = new Response(daemon.stderr).text();
          daemon.stdin.write(
            `${JSON.stringify({ operation: 'start', startup: { profile: { dataRoot: profile.dataRoot, profile: profile.profile, profileAccessKey: profile.profileAccessKey }, instanceId: randomUUID(), buildId: 'owned-connection', token: randomUUID().replaceAll('-', '').repeat(2) }, workspace, socket: join(root, 'daemon.sock'), web: { directory: web, manifestSha256: sha(Buffer.from(manifest)) } })}\n`,
          );
          daemon.stdin.end();
          const reader = daemon.stdout.getReader();
          let text = '';
          try {
            while (!text.includes('\n')) {
              businessAbort.signal.throwIfAborted();
              const next = await reader.read();
              if (next.done) throw Error('owned_daemon_bootstrap_failed');
              text += new TextDecoder().decode(next.value);
            }
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }
          const boot = bootstrapSchema.parse(JSON.parse(text));
          server = join(root, 'daemon.sock');
          settings();
          const sharedObserver = createClient({
            endpoint: boot.httpEndpoint,
            token: boot.token,
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
          try {
            await sharedObserver.connect();
            expect(sharedObserver.serverInfo!.storeId).toBe(storeId);
            expect(sharedObserver.serverInfo!.subjectId).toBe(subjectId);
            facts.push({
              phase,
              sharedServicePid: daemon.pid,
              storeId: sharedObserver.serverInfo!.storeId,
              subjectId: sharedObserver.serverInfo!.subjectId,
            });
          } finally {
            sharedObserver.disposeNetwork();
          }
          return Response.json({ phase });
        }
        if (path === '/restore-source') {
          writeFileSync(
            join(profile.profilePath, 'mcp.json'),
            JSON.stringify({
              mcpServers: {
                owned: { type: 'http', url: `${peer.url.href}mcp`, auth: { type: 'none' } },
              },
            }),
            { mode: 0o600 },
          );
          return Response.json({ restored: true });
        }
        const client = await connected();
        const view = await client.getView('a');
        expect(view.runs).toHaveLength(0);
        expect(modelCalls).toBe(0);
        expect(ledger('credentials.jsonl')).toHaveLength(0);
        if (path === '/detached') {
          expect(daemon?.exitCode).toBeNull();
          const cold = submitted().find((row) => row.phase === 'cold')!;
          const original = await factsFor(cold.body.commandId, cold.body.input);
          expect(original.fact.live).toBe(true);
          facts.push({ sharedDetached: true, servicePid: daemon!.pid, ...original });
        }
        if (path === '/cold-selected') {
          const warmIds = submitted()
            .filter((row) => row.phase === 'warm')
            .map((row) => row.body.commandId);
          expect(
            http().filter(
              (row) => row.phase === 'cold' && warmIds.some((id) => row.path.includes(id)),
            ),
          ).toHaveLength(0);
          expect(submitted().filter((row) => row.phase === 'cold')).toHaveLength(0);
        }
        if (path === '/cold-lookup') {
          const warm = submitted()
            .filter((row) => row.phase === 'warm')
            .at(-1)!;
          const original = await factsFor(warm.body.commandId, warm.body.input);
          expect(original.fact.ready).not.toBeNull();
          expect(original.fact.live).toBe(false);
          expect(original.fact.created).toBe(false);
          expect(
            http().some(
              (row) =>
                row.phase === 'cold' &&
                row.method === 'GET' &&
                row.path.includes(warm.body.commandId),
            ),
          ).toBe(true);
          expect(rpc.length).toBe(warmBaseline);
          expect(submitted().filter((row) => row.phase === 'cold')).toHaveLength(0);
          facts.push({ phase, coldOriginal: true, ...original });
        }
        facts.push({ phase, runs: view.runs, uiPosts: submitted().length, rpc: rpc.length });
        return Response.json({ checked: true });
      } catch (error) {
        if (!businessAbort.signal.aborted) facts.push({ controlFailure: String(error) });
        return Response.json({ error: String(error) }, { status: 500 });
      }
    };
    control = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const pending = controlRequest(request);
        controlWork.add(pending);
        void pending.then(
          () => controlWork.delete(pending),
          () => controlWork.delete(pending),
        );
        return pending;
      },
    });
    const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct,json,urllib.request
p=None;master=None;buffer=b''
def control(path):
 with urllib.request.urlopen(${JSON.stringify(control.url.href)}+path,timeout=12) as response:return json.load(response)
def normalized():
 frames=buffer.split(b'\\x1b[?2026h')
 complete=next((frame.split(b'\\x1b[?2026l')[0] for frame in reversed(frames[1:]) if b'\\x1b[?2026l' in frame),b'')
 return re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',complete.decode(errors='replace')))
def receive(timeout=.05):
 global buffer
 if select.select([master],[],[],timeout)[0]:
  chunk=os.read(master,65536)
  if not chunk:raise RuntimeError('owned_pty_eof')
  buffer=(buffer+chunk)[-1048576:]
def drain(deadline=None):
 reads=0
 while select.select([master],[],[],0)[0]:
  if reads>=16:raise RuntimeError('owned_frame_drain_limit')
  if deadline is not None and time.monotonic()>deadline:raise RuntimeError('owned_frame_drain_deadline')
  receive(0);reads+=1
def wait(text,compact=False):
 deadline=time.monotonic()+10
 while True:
  drain(deadline)
  if text in (normalized().replace(' ','') if compact else normalized()):return
  if time.monotonic()>deadline:raise RuntimeError('expected '+text+' tail='+normalized()[-5000:])
  receive()
def key(value):
 global buffer
 drain();buffer=b'';os.write(master,value)
def selected_connection(command_id):
 # Only selected outcome details include their finite phase; list labels have no phase.
 wait('Originalconnection:'+command_id+'·Connectionoutcomeunknown;checkoriginal',True)
def start(phase):
 global p,master,buffer
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
 p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(join(root, 'host.js'))}],stdin=slave,stdout=slave,stderr=slave,start_new_session=True,env=dict(os.environ,HOME=${JSON.stringify(root)},KITE_CODE_HOME=${JSON.stringify(join(root, 'owned-home'))}))
 os.close(slave);buffer=b''
 with open(${JSON.stringify(join(evidence, 'pids.jsonl'))},'a') as log:log.write(json.dumps({'phase':phase,'tuiPid':p.pid})+'\\n');log.flush();os.fsync(log.fileno())
 wait('New Run >')
def request_connection():
 key(b'/mcp');wait('New Run > /mcp');key(b'\\r');wait('Server list ready');key(b'\\x1b[B');wait('›'+${JSON.stringify(selectedServerId)}+'·enabled·available',True);key(b'\\r');wait('Server:'+${JSON.stringify(selectedServerId)}+'·http',True);wait('Source:')
 key(b'\\x1b[B'*6);wait('› Request connection');key(b'\\r');wait('Confirm connection request:');key(b'\\r');wait('Original connection:')
def lookup_detail():
 key(b'\\x1b[B');wait('› Check original connection');key(b'\\r');wait('Original catalogue ready')
 with open(${JSON.stringify(join(evidence, 'frames.jsonl'))},'a') as log:log.write(json.dumps({'phase':phase,'frame':normalized()})+'\\n')
def close():
 global master
 key(b'\\x11');deadline=time.monotonic()+6
 while p.poll() is None and time.monotonic()<deadline:
  if select.select([master],[],[],.1)[0]:
   try:os.read(master,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0;os.close(master);master=None
 with open(${JSON.stringify(join(evidence, 'exits.jsonl'))},'a') as log:log.write(json.dumps({'pid':p.pid,'exit':p.returncode})+'\\n')
try:
 phase='warm';start(phase);request_connection();first=control('approve-new')['commandId'];lookup_detail();key(b'\\x1b[A');wait('› Request connection');key(b'\\r');wait('Confirm connection request:');key(b'\\r');wait('Original connection:');second=control('approve-reuse')['commandId'];lookup_detail();wait('Reused original connection');close()
 control('cold');phase='cold';start(phase);key(b'/mcp');wait('New Run > /mcp');key(b'\\r');wait('No configured MCP servers');key(b'\\x1b[B'*5);wait('› Original connection: '+second);key(b'\\r');selected_connection(second);control('cold-selected');key(b'\\x1b[A'*2);wait('› Check original connection');key(b'\\r');wait('Original catalogue ready');wait('Live connection not confirmed');control('cold-lookup');key(b'\\x1b[B');wait('› Original connection: '+first);key(b'\\r');selected_connection(first);key(b'\\x1b[A');wait('› Check original connection');key(b'\\r');wait('Original catalogue ready');wait('Live connection not confirmed');control('check');key(b'\\x1b');wait('New Run >');control('restore-source');request_connection();control('approve-new');lookup_detail();wait('Created by original request');close();control('detached');print('ORIGINAL_CONNECTION_WARM_COLD_COMPLETE')
finally:
 try:
  with open(${JSON.stringify(join(evidence, 'final-frame.txt'))},'wb') as log:log.write(buffer)
 finally:
  try:
   if p is not None and p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
  finally:
   if master is not None:os.close(master)
`;
    python = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
    const [pythonOut, pythonErr, pythonExit] = await Promise.all([
      new Response(python.stdout).text(),
      new Response(python.stderr).text(),
      python.exited,
    ]);
    writeFileSync(join(evidence, 'pty.log'), pythonOut + pythonErr);
    expect(pythonExit).toBe(0);
    expect(pythonOut).toContain('ORIGINAL_CONNECTION_WARM_COLD_COMPLETE');
    expect(submitted().filter((row) => row.phase === 'warm')).toHaveLength(2);
    expect(submitted().filter((row) => row.phase === 'cold')).toHaveLength(1);
    expect(new Set(submitted().map((row) => row.body.commandId)).size).toBe(3);
    expect(new Set(submitted().map((row) => row.body.input.key)).size).toBe(3);
    expect(rpc.filter((row) => row.method === 'tools/list')).toHaveLength(2);
    expect(rpc.filter((row) => row.phase === 'cold' && row.method === 'tools/list')).toHaveLength(
      1,
    );
    expect(modelCalls).toBe(0);
    expect(ledger('credentials.jsonl')).toHaveLength(0);
    success = true;
  } catch (error) {
    failure = error;
  } finally {
    businessAbort.abort(Error('owned_connection_closing'));
    const errors: unknown[] = [];
    const collect = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        errors.push(error);
      }
    };
    const boundedExit = async (work: Promise<unknown>, milliseconds: number, label: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          work,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(Error(label)), milliseconds);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      observer?.disposeNetwork();
      await collect(async () => {
        if (python?.exitCode === null) {
          python.kill('SIGINT');
          await boundedExit(python.exited, 9000, 'owned_python_exit_unconfirmed');
        }
      });
      await collect(async () => {
        if (build?.exitCode === null) {
          build.kill('SIGKILL');
          await boundedExit(build.exited, 9000, 'owned_build_exit_unconfirmed');
        }
      });
      await collect(async () => {
        if (seed) await seed.close();
      });
      await collect(async () => {
        if (daemon?.exitCode === null) {
          daemon.kill('SIGTERM');
          await boundedExit(daemon.exited, 9000, 'owned_shared_daemon_exit_unconfirmed');
        }
        if (daemon) expect(daemon.exitCode).toBe(0);
        if (daemonErrors) writeFileSync(join(evidence, 'daemon.log'), await daemonErrors);
      });
      await collect(async () => {
        await boundedExit(
          Promise.allSettled([...controlWork]),
          12000,
          'owned_control_work_unconfirmed',
        );
        if (controlWork.size) throw Error('owned_control_work_unconfirmed');
      });
      await collect(async () => {
        for (const row of ledger('owned-services.jsonl') as { servicePid: number }[]) {
          try {
            process.kill(row.servicePid, 0);
            throw Error('owned_service_exit_unconfirmed');
          } catch (error) {
            if ((error as { code?: string }).code !== 'ESRCH') throw error;
          }
        }
      });
      cleanupConfirmed =
        (python === undefined || python.exitCode !== null) &&
        (daemon === undefined || daemon.exitCode !== null) &&
        errors.length === 0;
    } catch (error) {
      errors.push(error);
    } finally {
      observer?.disposeNetwork();
      try {
        await control?.stop(true);
      } catch (error) {
        errors.push(error);
      }
      try {
        await peer.stop(true);
      } catch (error) {
        errors.push(error);
      }
      try {
        await model.stop(true);
      } catch (error) {
        errors.push(error);
      }
      for (const name of [
        'ui-http.jsonl',
        'owned-services.jsonl',
        'permissions.jsonl',
        'admissions.jsonl',
        'resolutions.jsonl',
        'credentials.jsonl',
      ]) {
        try {
          if (existsSync(join(root, name)))
            writeFileSync(join(evidence, name), readFileSync(join(root, name)));
        } catch (error) {
          errors.push(error);
        }
      }
      if (success && cleanupConfirmed && errors.length === 0) {
        try {
          rmSync(root, { recursive: true, force: true });
          if (existsSync(root)) errors.push(Error('owned_connection_root_unconfirmed'));
        } catch (error) {
          errors.push(error);
        }
      }
      cleanupError = errors.length
        ? new AggregateError(errors, 'owned_connection_cleanup_unconfirmed')
        : undefined;
      cleanupConfirmed = cleanupConfirmed && errors.length === 0;
      writeFileSync(
        join(evidence, 'packet.json'),
        JSON.stringify(
          {
            success,
            cleanupConfirmed,
            retainedRoot: existsSync(root) ? root : null,
            ...(failure ? { failure: String(failure) } : {}),
            ...(cleanupError ? { cleanupError: String(cleanupError) } : {}),
            storeId,
            subjectId,
            artifact,
            rpc,
            modelCalls,
            ...(daemon
              ? { sharedServicePid: daemon.pid, sharedServiceExitCode: daemon.exitCode }
              : {}),
            facts,
            deadlines: {
              stepMs: 10000,
              controlMs: 12000,
              exitMs: 6000,
              exitWaitMs: 3000,
              testMs: 180000,
            },
          },
          null,
          2,
        ),
      );
      console.error(
        JSON.stringify({
          evidence,
          success,
          cleanupConfirmed,
          retainedRoot: existsSync(root) ? root : null,
        }),
      );
    }
  }
  if (cleanupError) throw cleanupError;
  if (failure) throw failure;
}, 180000);
