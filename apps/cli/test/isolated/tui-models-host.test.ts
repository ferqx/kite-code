import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { createClient } from '@kite-ai/client';
import { bootstrapSchema } from '@kite-ai/service/daemon';
import { launchPairedService } from '@kite-ai/service/paired';

const repo = resolve(import.meta.dir, '../../../..');
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
for (const mode of ['paired', 'shared'] as const)
  test(`actual ${mode} TUI model/default/effort CAS preserves held Run and lost original reply never resubmits`, async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-tui-model-')),
      workspace = join(root, 'workspace'),
      profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
    mkdirSync(workspace, { mode: 0o700 });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    // This fixture asserts English labels independently of the host device locale.
    mkdirSync(join(profile.profilePath, 'ui'), { recursive: true, mode: 0o700 });
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    const calls: { model: string; reasoning_effort?: string }[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 30,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/release') {
          release();
          return new Response('released');
        }
        if (url.pathname === '/calls') return Response.json(calls);
        const body = (await req.json()) as {
          model: string;
          reasoning_effort?: string;
          messages: { role: string; content: string }[];
        };
        calls.push({ model: body.model, reasoning_effort: body.reasoning_effort });
        if (body.messages.some((m) => m.content === 'held-original') && calls.length === 1)
          await held;
        const frame = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(
          frame({ content: `DONE ${body.model}` }, null) + frame({}, 'stop') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    let daemon: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    let python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    try {
      writeFileSync(
        join(profile.profilePath, 'config.jsonc'),
        JSON.stringify({
          modelId: 'one',
          models: ['one', 'two'].map((id) => ({
            id,
            provider: 'compatible',
            model: id,
            baseURL: provider.url.href + 'v1',
          })),
        }),
        { mode: 0o600 },
      );
      const entrypoint = join(repo, 'apps/service/dist/main.js'),
        artifact = {
          entrypoint,
          entrypointSha256: sha(readFileSync(entrypoint)),
          executable: realpathSync(process.execPath),
          executableSha256: sha(readFileSync(process.execPath)),
          buildId: 'owned-models',
          apiMajor: 1,
        };
      let storeId: string;
      const socket = join(root, 'd.sock');
      if (mode === 'paired') {
        const seed = await launchPairedService({
          profile,
          ...artifact,
          instanceId: randomUUID(),
          requiredCapabilities: ['sessions'],
        });
        try {
          storeId = seed.bootstrap.storeId!;
          await seed.client.createWorkspace({
            expectedStoreId: storeId,
            id: 'w',
            rootUri: `file://${workspace}`,
            name: 'owned',
          });
          await seed.client.createSession({
            expectedStoreId: storeId,
            commandId: 'create',
            sessionId: 'a',
            workspaceId: 'w',
            title: 'models',
          });
        } finally {
          await seed.close();
        }
      } else {
        const web = join(root, 'web');
        mkdirSync(web, { mode: 0o700 });
        const assets = [
          ['/index.html', 'text/html; charset=utf-8', '<!doctype html><title>owned</title>'],
          ['/app.js', 'text/javascript; charset=utf-8', 'globalThis.owned=true;'],
          ['/app.css', 'text/css; charset=utf-8', 'body{color:black}'],
        ].map(([path, mediaType, content]) => {
          writeFileSync(join(web, path!.slice(1)), content!);
          return { path, mediaType, size: Buffer.byteLength(content!), sha256: sha(content!) };
        });
        const manifest = JSON.stringify(assets);
        writeFileSync(join(web, 'manifest.json'), manifest);
        const instanceId = randomUUID();
        daemon = Bun.spawn([process.execPath, join(repo, 'apps/service/dist/daemon-main.js')], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
        daemon.stdin.write(
          JSON.stringify({
            operation: 'start',
            startup: {
              profile: {
                dataRoot: profile.dataRoot,
                profile: profile.profile,
                profileAccessKey: profile.profileAccessKey,
              },
              instanceId,
              buildId: 'owned-models',
              token: 's'.repeat(64),
            },
            workspace,
            socket,
            web: { directory: web, manifestSha256: sha(manifest) },
          }) + '\n',
        );
        daemon.stdin.end();
        const reader = daemon.stdout.getReader();
        let frame = '';
        while (!frame.includes('\n')) {
          const next = await reader.read();
          if (next.done) throw Error('daemon_start_failed');
          frame += new TextDecoder().decode(next.value);
        }
        await reader.cancel();
        reader.releaseLock();
        const boot = bootstrapSchema.parse(JSON.parse(frame));
        client = createClient({
          endpoint: boot.httpEndpoint,
          token: boot.token,
          expected: {
            profile: boot.profile,
            instanceId,
            buildId: boot.buildId,
            apiMajor: 1,
            requiredCapabilities: ['sessions'],
          },
        });
        const info = await client.connect();
        storeId = info.storeId!;
        await client.createWorkspace({
          expectedStoreId: storeId,
          id: 'w',
          rootUri: `file://${workspace}`,
          name: 'owned',
        });
        await client.createSession({
          expectedStoreId: storeId,
          commandId: 'create',
          sessionId: 'a',
          workspaceId: 'w',
          title: 'models',
        });
      }
      const runner = join(root, 'runner.ts'),
        count = join(root, 'post-count'),
        lookupCount = join(root, 'lookup-count');
      writeFileSync(
        runner,
        `import {appendFileSync} from 'node:fs';import {runTUIHost} from ${JSON.stringify(join(repo, 'apps/cli/host/tui.tsx'))};const actual=globalThis.fetch;let lost=false;globalThis.fetch=async(...args)=>{const response=await actual(...args);const u=String(args[0]);if(u.includes('/host-mutations/'))appendFileSync(${JSON.stringify(lookupCount)},'get\\n');if(args[1]?.method==='POST'&&u.endsWith('/models')){appendFileSync(${JSON.stringify(count)},'post\\n');if(!lost){lost=true;throw Error('owned_lost_reply')}}return response};const exit=new AbortController();process.once('SIGTERM',()=>exit.abort());await runTUIHost({exitSignal:exit.signal,${mode === 'paired' ? `artifact:${JSON.stringify(artifact)}` : `server:${JSON.stringify(socket)}`},dataRoot:${JSON.stringify(profile.dataRoot)},profile:'development',thread:'a',cwd:${JSON.stringify(workspace)}});`,
      );
      const program = `import os,pty,subprocess,select,time,signal,re,json,urllib.request,sqlite3,fcntl,termios,struct
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(runner)}],stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);buffer=b''
def wait(text):
 global buffer
 end=time.monotonic()+10
 while text not in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace'))):
  if time.monotonic()>end:
   db=sqlite3.connect(${JSON.stringify(profile.databasePath)});print('FINITE_MUTATIONS '+str(db.execute('select kind,state,safe_request_json,receipt_json from host_mutation').fetchall()),flush=True);db.close();raise RuntimeError('expected '+text+' tail='+buffer[-5000:].decode(errors='replace'))
  if select.select([master],[],[],.05)[0]:buffer+=os.read(master,65536)
def key(value):
 global buffer
 buffer=b'';os.write(master,value);time.sleep(.15)
def send(text):
 key(text.encode());wait(text);key(b'\\r')
def requests():return json.load(urllib.request.urlopen(${JSON.stringify(provider.url.href + 'calls')}))
try:
 wait('New Run');send('/permissions');wait('Workspace w: untrusted');key(b't');wait('Confirm original');key(b'\\r');wait('workspace.trust: applied');key(b'\\x1b');wait('New Run');send('held-original')
 end=time.monotonic()+5
 while len(requests())!=1:
  if time.monotonic()>end:raise RuntimeError('held provider not entered')
  time.sleep(.02)
 wait('Steer original active Run >');send('/model');wait('Desired default: one');key(b'\\x1b[B');wait('› compatible / two');key(b'\\r');wait('Confirm original project change');key(b'\\r');wait('outcome_unknown');key(b'\\r');wait('Confirm original project change');key(b'\\r');wait('model_settings_original_outcome_required');key(b'k');wait('Desired default: two');assert requests()==[{'model':'one'}]
 key(b'\\x1b');wait('Steer original active Run >');send('/effort');wait('clear project effort');key(b'\\x1b[B');wait('› none');key(b'\\x1b[B');wait('› minimal');key(b'\\x1b[B');wait('› low');key(b'\\x1b[B');wait('› medium');key(b'\\x1b[B');wait('› high');key(b'\\r');wait('Confirm original project change');key(b'\\r');wait('Current effective effort: high');assert requests()==[{'model':'one'}]
 key(b'\\x1b');urllib.request.urlopen(${JSON.stringify(provider.url.href + 'release')}).read();wait('DONE one');wait('New Run >');send('next-original');wait('DONE two');assert requests()==[{'model':'one'},{'model':'two','reasoning_effort':'high'}]
 db=sqlite3.connect(${JSON.stringify(profile.databasePath)});assert db.execute("select count(*) from host_mutation where json_extract(safe_request_json,'$.modelSettings') is not null").fetchone()[0]==2;db.close();assert open(${JSON.stringify(count)}).read()=='post\\npost\\n';key(b'\\x11')
 end=time.monotonic()+6
 while p.poll() is None and time.monotonic()<end:
  if select.select([master],[],[],.05)[0]:
   try:buffer+=os.read(master,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0;print('MODEL_ORIGINAL_COMPLETE')
finally:
 if p.poll() is None:
  os.killpg(p.pid,signal.SIGTERM)
  end=time.monotonic()+6
  while p.poll() is None and time.monotonic()<end:
   if select.select([master],[],[],.05)[0]:
    try:os.read(master,65536)
    except OSError:break
  if p.poll() is None:os.killpg(p.pid,signal.SIGKILL)
  p.wait(timeout=3)
 os.close(master)
`;
      python = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
      const [out, err, exit] = await Promise.all([
        new Response(python.stdout).text(),
        new Response(python.stderr).text(),
        python.exited,
      ]);
      if (exit) console.error(out, err);
      expect(exit).toBe(0);
      expect(out).toContain('MODEL_ORIGINAL_COMPLETE');
      expect(calls).toEqual([
        { model: 'one', reasoning_effort: undefined },
        { model: 'two', reasoning_effort: 'high' },
      ]);
      expect(readFileSync(count, 'utf8')).toBe('post\npost\n');
      expect(readFileSync(lookupCount, 'utf8')).toBe('get\n');
    } finally {
      release();
      if (python && python.exitCode === null) {
        python.kill('SIGTERM');
        await python.exited;
      }
      client?.disposeNetwork();
      if (daemon && daemon.exitCode === null) {
        daemon.kill('SIGTERM');
        await daemon.exited;
      }
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 40000);
test('model host review: pending 409 and wrong ifMatch stay original unknown; known CAS failure remains finite', async () => {
  const { createTuiModelPort } = await import('../../host/tui');
  const { TuiController } = await import('@kite-ai/ui/tui');
  const { ClientError } = await import('@kite-ai/client');
  const readSet = {
    userEtag: 'a'.repeat(64),
    workspaceEtag: 'b'.repeat(64),
    explicitDigest: 'c'.repeat(64),
    effectiveDigest: 'd'.repeat(64),
  };
  const facts = {
    storeId: 'store',
    scope: 'workspace' as const,
    workspaceId: 'w',
    readSet,
    defaultModelId: 'one',
    models: ['one', 'two'].map((id) => ({ id, enabled: true, configured: true, diagnostics: [] })),
    errors: [],
  };
  let writes = 0,
    gets = 0,
    command = 0,
    cas = false,
    wrong = true;
  let saved: import('@kite-ai/client').ModelSettingsRequest | undefined;
  const models = createTuiModelPort(
    {
      getModelSettings: async () => facts,
      updateModelSettings: async (_scope, request) => {
        writes++;
        saved = request;
        throw new ClientError(
          cas ? 'model_settings_conflict' : 'mutation_incomplete',
          'owned 409',
          409,
        );
      },
      getHostMutation: async () => {
        gets++;
        return {
          commandId: saved!.commandId,
          originStoreId: 'store',
          kind: 'model_settings.update',
          scope: 'workspace',
          workspaceId: 'w',
          ifMatch: wrong ? 'e'.repeat(64) : readSet.workspaceEtag,
          state: 'applied',
          receipt: { status: 'applied', etag: 'f'.repeat(64) },
          modelSettings: {
            operation: { modelId: 'two', kind: 'default' },
            expectedReadSet: {
              effectiveDigest: readSet.effectiveDigest,
              explicitDigest: readSet.explicitDigest,
              workspaceEtag: readSet.workspaceEtag,
              userEtag: readSet.userEtag,
            },
          },
        };
      },
    } as Parameters<typeof createTuiModelPort>[0],
    'store',
  );
  const controller = new TuiController({
    storeId: 'store',
    models,
    nextCommandId: () => `c${++command}`,
    listSessions: async () => [],
    readSession: async (id) =>
      ({
        storeId: 'store',
        view: {
          storeId: 'store',
          session: { id, workspaceId: 'w', rootSessionId: id, parentSessionId: null },
          runs: [],
          executions: [],
          messages: [],
        },
        messages: [],
        interactions: [],
      }) as unknown as import('@kite-ai/ui/tui').TuiSnapshot,
    submit: async () => {
      throw Error('zero work');
    },
    answer: async () => {
      throw Error('zero answer');
    },
    cancel: async () => {
      throw Error('zero cancel');
    },
    getCommand: async () => {
      throw Error('zero command');
    },
  });
  try {
    await controller.select('a');
    await controller.openModels();
    await controller.chooseModel({ kind: 'default', modelId: 'two' });
    expect(writes).toBe(1);
    expect(controller.state.modelOutcome?.status).toBe('outcome_unknown');
    await controller.chooseModel({ kind: 'default', modelId: 'two' });
    expect(writes).toBe(1);
    await controller.lookupModel();
    expect(gets).toBe(1);
    expect(controller.state.modelOutcome?.status).toBe('outcome_unknown');
    expect(controller.state.models?.defaultModelId).toBe('one');
    await controller.chooseModel({ kind: 'default', modelId: 'two' });
    expect(writes).toBe(1);
    wrong = false;
    await controller.lookupModel();
    expect(gets).toBe(2);
    cas = true;
    await controller.chooseModel({ kind: 'default', modelId: 'two' });
    expect(writes).toBe(2);
    expect(controller.state.modelOutcome?.status).toBe('failed');
    expect(controller.state.models?.defaultModelId).toBe('one');
    expect(controller.state.error).toBe('model_settings_save_failed');
    await controller.openModels();
    expect(writes).toBe(2);
  } finally {
    controller.dispose();
  }
});
