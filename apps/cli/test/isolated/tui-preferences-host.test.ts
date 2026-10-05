import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { createClient } from '@kite-ai/client';
import { bootstrapSchema } from '@kite-ai/service/daemon';
import { launchPairedService } from '@kite-ai/service/paired';
import type { CLIServiceArtifact } from '../../host';

const repo = resolve(import.meta.dir, '../../../..');
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function seedTrust(client: ReturnType<typeof createClient>, storeId: string) {
  const state = await client.getWorkspaceTrust('w', { storeId });
  await client.setWorkspaceTrust('w', {
    expectedStoreId: storeId,
    commandId: randomUUID(),
    ifRevision: state.revision,
    trusted: true,
    canonicalIdentity: state.canonicalIdentity,
    externalReadScopeDigest: state.externalReadScopeDigest,
  });
}
async function seedModel(client: ReturnType<typeof createClient>, storeId: string) {
  await client.startRun('a', {
    expectedStoreId: storeId,
    commandId: 'original-model',
    kind: 'run.start',
    content: 'original seed',
  });
  const end = Date.now() + 10000;
  while ((await client.getView('a')).runs[0]?.status !== 'completed') {
    if (Date.now() > end) throw Error('seed_not_completed');
    await Bun.sleep(10);
  }
  expect((await client.getView('a')).runs[0]?.status).toBe('completed');
}
for (const mode of ['paired', 'shared'] as const)
  test(`80x24 actual ${mode} TUI preferences persist colors and language without extra work and retain old facts on save failure`, async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-tui-preferences-'));
    const workspace = join(root, 'workspace'),
      ownedPid = join(root, 'owned-pid');
    mkdirSync(workspace, { mode: 0o700 });
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    mkdirSync(join(profile.profilePath, 'ui'), { mode: 0o700 });
    writeFileSync(
      join(profile.profilePath, 'ui', 'preferences.jsonc'),
      JSON.stringify({ language: 'en-US', colorPreset: 'teal' }),
      { mode: 0o600 },
    );
    let calls = 0;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch() {
        calls++;
        const frame = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(
          frame({ content: 'ORIGINAL English model body stays exact.' }, null) +
            frame({}, 'stop') +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
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
    const entrypoint = join(repo, 'apps/service/dist/main.js');
    const artifact: CLIServiceArtifact = {
      entrypoint,
      entrypointSha256: sha(readFileSync(entrypoint)),
      executable: realpathSync(process.execPath),
      executableSha256: sha(readFileSync(process.execPath)),
      buildId: 'owned-preferences',
      apiMajor: 1,
    };
    let daemon: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined,
      python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    const socket = join(root, 'd.sock');
    try {
      let storeId: string;
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
          await seedTrust(seed.client, storeId);
          await seed.client.createSession({
            expectedStoreId: storeId,
            commandId: 'create-b',
            sessionId: 'b',
            workspaceId: 'w',
            title: 'Beta',
          });
          await seed.client.createSession({
            expectedStoreId: storeId,
            commandId: 'create',
            sessionId: 'a',
            workspaceId: 'w',
            title: 'status',
          });
          await seedModel(seed.client, storeId);
        } finally {
          await seed.close();
        }
      } else {
        const web = join(root, 'web');
        mkdirSync(web, { mode: 0o700 });
        const assets = [
          ['/index.html', 'text/html; charset=utf-8', '<title>owned</title>'],
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
          `${JSON.stringify({
            operation: 'start',
            startup: {
              profile: {
                dataRoot: profile.dataRoot,
                profile: profile.profile,
                profileAccessKey: profile.profileAccessKey,
              },
              instanceId,
              buildId: 'owned-preferences',
              token: 's'.repeat(64),
            },
            workspace,
            socket,
            web: { directory: web, manifestSha256: sha(manifest) },
          })}\n`,
        );
        daemon.stdin.end();
        const reader = daemon.stdout.getReader();
        let frame = '';
        try {
          while (!frame.includes('\n')) {
            const next = await reader.read();
            if (next.done) throw Error('status_daemon_start_failed');
            frame += new TextDecoder().decode(next.value);
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
        const boot = bootstrapSchema.parse(JSON.parse(frame));
        client = createClient({
          endpoint: boot.httpEndpoint,
          token: boot.token,
          expected: {
            profile: boot.profile,
            instanceId,
            buildId: boot.buildId,
            apiMajor: 1,
            requiredCapabilities: ['sessions', 'commands'],
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
        await seedTrust(client, storeId);
        await client.createSession({
          expectedStoreId: storeId,
          commandId: 'create-b',
          sessionId: 'b',
          workspaceId: 'w',
          title: 'Beta',
        });
        await client.createSession({
          expectedStoreId: storeId,
          commandId: 'create',
          sessionId: 'a',
          workspaceId: 'w',
          title: 'status',
        });
      }
      if (client) await seedModel(client, storeId);
      const runner = join(repo, 'apps/cli/test/fixtures/tui-preferences-runner.ts');
      const preferencePath = join(profile.profilePath, 'ui', 'preferences.jsonc');
      const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct,sqlite3,json
settings=${JSON.stringify(JSON.stringify({ root, dataRoot: profile.dataRoot, workspace, ...(mode === 'paired' ? { artifact } : { server: socket }) }))};pref=${JSON.stringify(preferencePath)};p=None;master=None;buffer=b'';all_output=b''
def spawn():
 global p,master,buffer
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));env=dict(os.environ);env['TUI_PREFERENCES_SETTINGS']=settings;env['TERM']='xterm-256color';env['FORCE_COLOR']='3';p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(runner)}],env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);buffer=b''
def wait(text):
 global buffer,all_output
 end=time.monotonic()+10
 while text not in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace'))):
  if time.monotonic()>end:raise RuntimeError('expected '+text+' tail='+buffer[-7000:].decode(errors='replace'))
  if select.select([master],[],[],.05)[0]:
   data=os.read(master,65536);buffer+=data;all_output+=data
def key(value):
 global buffer
 buffer=b'';os.write(master,value)
def counts():
 db=sqlite3.connect('file:'+${JSON.stringify(profile.databasePath)}+'?mode=ro',uri=True);values={table:db.execute('select count(*) from '+table).fetchone()[0] for table in ['session','run','execution','command','host_mutation']};db.close();return values
def close():
 global master
 key(b'\\x11');end=time.monotonic()+6
 while p.poll() is None and time.monotonic()<end:
  if select.select([master],[],[],.05)[0]:
   try:os.read(master,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0;os.close(master);master=None
try:
 spawn();wait('ORIGINAL English model body stays exact.');baseline=counts();key(b'/theme');wait('/theme');key(b'\\r');wait('[teal]');wait('Confirmed preferences');assert re.search(b'38;(?:2;78;201;176|5;115)m',buffer)
 key(b'\\x1b[B');wait('> blue');key(b'\\r');wait('blue [blue] ✓');wait('Preference saved');assert re.search(b'38;(?:2;86;156;214|5;110)m',buffer);assert json.load(open(pref))['colorPreset']=='blue'
 key(b'\\x1b');wait('ORIGINAL English model body stays exact.');key(b'/language');wait('/language');key(b'\\r');wait('Language');key(b'\\x1b[A');wait('> Simplified Chinese [zh-CN]');key(b'\\r');wait('偏好已保存');wait('简体中文 [zh-CN]');assert json.load(open(pref))['language']=='zh-CN'
 key(b'\\x1b');wait('会话 a');wait('ORIGINAL English model body stays exact.');assert counts()==baseline
 key(b'/theme');wait('/theme');key(b'\\r');wait('主题');wait('blue [blue] ✓');os.rename(pref,pref+'.saved');os.mkdir(pref,0o700)
 key(b'\\x1b[B');wait('> purple');key(b'\\r');wait('tui_preferences_unavailable');wait('保留原值');wait('blue [blue] ✓');assert re.search(b'38;(?:2;86;156;214|5;110)m',buffer);assert counts()==baseline
 os.rmdir(pref);os.rename(pref+'.saved',pref);key(b'r');wait('blue [blue] ✓');key(b'\\x1b');wait('会话 a');close();assert counts()==baseline
 spawn();wait('会话 a');wait('ORIGINAL English model body stays exact.');key(b'/theme');wait('/theme');key(b'\\r');wait('主题');wait('blue [blue] ✓');assert re.search(b'38;(?:2;86;156;214|5;110)m',buffer)
 key(b'\\x1b');wait('会话 a');key(b'/language');wait('/language');key(b'\\r');wait('语言');wait('简体中文 [zh-CN]');key(b'\\x1b');wait('ORIGINAL English model body stays exact.');close();assert counts()==baseline;assert json.load(open(pref))=={'colorPreset':'blue','language':'zh-CN'}
 print('PREFERENCES_ORIGINAL_COMPLETE')
finally:
 if p and p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
 if master is not None:os.close(master)
`;
      python = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
      const [out, err, exitCode] = await Promise.all([
        new Response(python.stdout).text(),
        new Response(python.stderr).text(),
        python.exited,
      ]);
      if (exitCode) {
        console.error(out, err);
      }
      expect(exitCode).toBe(0);
      expect(out).toContain('PREFERENCES_ORIGINAL_COMPLETE');
      expect(calls).toBe(1);
      if (mode === 'paired') {
        const pids = readFileSync(ownedPid, 'utf8').trim().split('\n').map(Number);
        expect(pids).toHaveLength(2);
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      } else {
        expect(daemon!.exitCode).toBeNull();
        expect((await client!.verifyConnection()).storeId).toBe(storeId);
        expect((await client!.getView('b')).runs.length).toBe(0);
      }
    } finally {
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
