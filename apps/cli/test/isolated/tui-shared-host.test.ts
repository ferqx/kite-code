import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProfileBackup } from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { createClient } from '@kite-ai/client';
import { bootstrapSchema } from '@kite-ai/service/daemon';

const repository = resolve(import.meta.dir, '../../../..');
const nativeTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
async function until(read: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!(await read())) {
    if (Date.now() >= end) throw Error('tui_shared_fixture_deadline');
    await Bun.sleep(10);
  }
}
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('tui_shared_fixture_deadline')), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

nativeTest(
  'actual shared TUI exits detach; wrong workspace/absent create nothing; daemon loss retains draft and UI lease',
  async () => {
    const root = mkdtempSync('/private/tmp/kite-tui-shared-');
    const workspace = join(root, 'workspace');
    const wrongWorkspace = join(root, 'wrong');
    const web = join(root, 'web');
    for (const directory of [workspace, wrongWorkspace, web]) mkdirSync(directory, { mode: 0o700 });
    const assets = [
      ['/index.html', 'text/html; charset=utf-8', '<!doctype html><title>Shared fixture</title>'],
      ['/app.js', 'text/javascript; charset=utf-8', 'globalThis.sharedFixture = true;'],
      ['/app.css', 'text/css; charset=utf-8', 'body {color:black}'],
    ].map(([path, mediaType, content]) => {
      writeFileSync(join(web, path!.slice(1)), content!);
      return { path, mediaType, size: Buffer.byteLength(content!), sha256: sha(content!) };
    });
    const manifest = JSON.stringify(assets);
    writeFileSync(join(web, 'manifest.json'), manifest);
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
    mkdirSync(join(profile.profilePath, 'ui'), { recursive: true, mode: 0o700 });
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    const host = Object.fromEntries(
      ['configured', 'models', 'entered', 'effects', 'cancelled'].map((key) => [
        key,
        join(root, key),
      ]),
    );
    const socket = join(root, 'd.sock');
    const instanceId = randomUUID();
    const daemon = Bun.spawn(
      [process.execPath, join(repository, 'apps/service/test/fixtures/daemon-process-child.ts')],
      {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const daemonErrors = new Response(daemon.stderr).text();
    daemon.stdin.write(
      `${JSON.stringify({ operation: 'start', startup: { profile: { dataRoot: profile.dataRoot, profile: profile.profile, profileAccessKey: profile.profileAccessKey }, instanceId, buildId: 'tui-shared-fixture', token: 's'.repeat(64), hostConfiguration: host }, workspace, socket, web: { directory: web, manifestSha256: sha(manifest) } })}\n`,
    );
    daemon.stdin.end();
    let client: ReturnType<typeof createClient> | undefined;
    let python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    let absent: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    try {
      const reader = daemon.stdout.getReader();
      let frame = '';
      try {
        while (!frame.includes('\n')) {
          const next = await deadline(reader.read());
          if (next.done) throw Error('tui_shared_daemon_start_failed');
          frame += new TextDecoder().decode(next.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const bootstrap = bootstrapSchema.parse(JSON.parse(frame));
      client = createClient({
        endpoint: bootstrap.httpEndpoint,
        token: bootstrap.token,
        expected: {
          profile: bootstrap.profile,
          instanceId,
          buildId: bootstrap.buildId,
          apiMajor: 1,
          requiredCapabilities: ['sessions', 'commands'],
        },
      });
      const info = await client.connect();
      const storeId = info.storeId!;
      await client.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        rootUri: pathToFileURL(workspace).href,
        name: 'Shared workspace',
      });
      for (const id of ['held', 'visible'])
        await client.createSession({
          expectedStoreId: storeId,
          commandId: `create-${id}`,
          sessionId: id,
          workspaceId: 'w',
          title: id,
        });
      await client.startRun('held', {
        expectedStoreId: storeId,
        commandId: 'held-work',
        kind: 'run.start',
        content: 'Held daemon work',
      });
      await until(() => existsSync(host.entered!));
      const originalRun = (await client.getView('held')).runs[0]!;
      const draftPath = join(profile.profilePath, 'ui/tui.json');
      const live = join(root, 'ui-live');
      const checked = join(root, 'lease-checked');
      const exitsReady = join(root, 'exits-ready');
      const exitsChecked = join(root, 'exits-checked');
      const program = `import os,pty,subprocess,select,time,signal,re,json,fcntl,termios,struct
def interrupted(*args):raise SystemExit(130)
signal.signal(signal.SIGTERM,interrupted)
bun=${JSON.stringify(process.execPath)};entry=${JSON.stringify(join(repository, 'scripts/development/unified-tui.ts'))}
base=[bun,entry,'--server',${JSON.stringify(socket)},'--data-root',${JSON.stringify(profile.dataRoot)},'--thread','visible']
def run(mode,extra=[]):
 master,slave=pty.openpty()
 fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
 assert struct.unpack('HHHH',fcntl.ioctl(slave,termios.TIOCGWINSZ,bytes(8)))[:2]==(24,80)
 p=subprocess.Popen(base+extra,stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);buffer=b''
 def pump():
  nonlocal buffer
  if select.select([master],[],[],.05)[0]:
   try:buffer+=os.read(master,65536)
   except OSError:pass
 def wait(text):
  end=time.monotonic()+10
  while text not in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace'))):
   if time.monotonic()>end:raise RuntimeError('expected '+text+' tail='+buffer[-1000:].decode(errors='replace'))
   pump()
 try:
  if mode=='wrong':
   end=time.monotonic()+10
   while p.poll() is None and time.monotonic()<end:pump()
   p.wait(timeout=1);assert p.returncode==1;assert b'shared_workspace_mismatch' in buffer;print('WORKSPACE_REJECTED');return
  wait('New Run');wait('disconnect shared service')
  children=[line.decode(errors='replace') for line in subprocess.check_output(['/bin/ps','-axo','pid,ppid,command']).splitlines()[1:] if len(line.split(None,2))>=2 and line.split(None,2)[1]==str(p.pid).encode()];assert not children,children
  os.write(master,('draft-'+mode).encode());wait('draft-'+mode)
  if mode=='loss':
   os.kill(${daemon.pid},signal.SIGKILL);wait('Stale');assert p.poll() is None
   open(${JSON.stringify(live)},'w').write(str(p.pid))
   end=time.monotonic()+10
   while not os.path.exists(${JSON.stringify(checked)}):
    if time.monotonic()>end:raise RuntimeError('lease check deadline')
    pump()
   os.write(master,b'\\x11')
  elif mode=='eof':os.close(master);master=-1
  elif mode=='term':os.kill(p.pid,signal.SIGTERM)
  else:os.write(master,b'\\x11')
  end=time.monotonic()+10
  while p.poll() is None and time.monotonic()<end:
   if master>=0:pump()
   else:time.sleep(.01)
  p.wait(timeout=1);assert p.returncode==0,(mode,p.returncode,buffer[-1000:]);print('DETACHED_'+mode)
 finally:
  if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
  if master>=0:os.close(master)
for mode in ['quit','eof','term']:run(mode)
run('wrong',['--workspace',${JSON.stringify(wrongWorkspace)}])
assert not os.path.exists(${JSON.stringify(host.cancelled)})
assert open(${JSON.stringify(host.models)}).read().splitlines()==['call']
open(${JSON.stringify(exitsReady)},'w').write('ready')
end=time.monotonic()+10
while not os.path.exists(${JSON.stringify(exitsChecked)}):
 if time.monotonic()>end:raise RuntimeError('exit proof deadline')
 time.sleep(.01)
run('loss')
print('ALL_SHARED_BOUNDARIES')
`;
      python = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
      const output = new Response(python.stdout).text();
      const errors = new Response(python.stderr).text();
      await until(() => existsSync(exitsReady) || python!.exitCode !== null);
      if (!existsSync(exitsReady)) throw Error(`tui_shared_pty_failed:${await errors}`);
      expect((await client.getRun(originalRun.id)).isActive).toBe(true);
      expect((await client.getExecution(readFileSync(host.entered!, 'utf8'))).status).toBe(
        'dispatching',
      );
      expect(daemon.exitCode).toBeNull();
      writeFileSync(exitsChecked, 'checked');
      await until(() => existsSync(live) || python!.exitCode !== null);
      if (!existsSync(live)) throw Error(`tui_shared_pty_failed:${await errors}`);
      await deadline(daemon.exited);
      await expect(
        createProfileBackup({
          profile: { dataRoot: profile.dataRoot, profile: profile.profile },
          destinationRoot: join(root, 'backup'),
        }),
      ).rejects.toMatchObject({ code: 'owner_busy' });
      writeFileSync(checked, 'checked');
      expect(await deadline(python.exited)).toBe(0);
      expect(await errors).toBe('');
      const out = await output;
      for (const marker of [
        'DETACHED_quit',
        'DETACHED_eof',
        'DETACHED_term',
        'DETACHED_loss',
        'WORKSPACE_REJECTED',
        'ALL_SHARED_BOUNDARIES',
      ])
        expect(out).toContain(marker);
      expect(existsSync(host.cancelled!)).toBe(false);
      expect(readFileSync(host.models!, 'utf8').trim().split('\n')).toEqual(['call']);
      const drafts = JSON.parse(readFileSync(draftPath, 'utf8'));
      expect(drafts.drafts).toContainEqual(
        expect.objectContaining({
          storeId,
          workspaceId: 'w',
          sessionId: 'visible',
          text: 'draft-quitdraft-eofdraft-termdraft-loss',
        }),
      );
      const backup = await createProfileBackup({
        profile: { dataRoot: profile.dataRoot, profile: profile.profile },
        destinationRoot: join(root, 'backup'),
      });
      expect(backup.manifest.source.storeId).toBe(storeId);
      expect(originalRun.isActive).toBe(true);
      // An absent explicit target must fail before acquiring/initializing the new UI profile.
      const missing = join(root, 'missing-data');
      const absentScript = `import os,pty,subprocess,signal,fcntl,termios,struct
def interrupted(*args):raise SystemExit(130)
signal.signal(signal.SIGTERM,interrupted)
m,s=pty.openpty()
fcntl.ioctl(s,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
assert struct.unpack('HHHH',fcntl.ioctl(s,termios.TIOCGWINSZ,bytes(8)))[:2]==(24,80)
p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(join(repository, 'scripts/development/unified-tui.ts'))},'--server',${JSON.stringify(join(root, 'absent.sock'))},'--data-root',${JSON.stringify(missing)}],stdin=s,stdout=s,stderr=s,start_new_session=True);os.close(s)
try:p.wait(timeout=10);assert p.returncode==1
finally:
 if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(m)
`;
      absent = Bun.spawn(['python3', '-c', absentScript], { stdout: 'pipe', stderr: 'pipe' });
      expect(await deadline(absent.exited)).toBe(0);
      expect(existsSync(missing)).toBe(false);
    } finally {
      client?.disposeNetwork();
      const cleanup = await Promise.allSettled([
        (async () => {
          if (python && python.exitCode === null) {
            // The fixture's handler runs its owned PTY-child finally before exiting.
            python.kill('SIGTERM');
            await deadline(python.exited);
          }
        })(),
        (async () => {
          if (absent && absent.exitCode === null) {
            absent.kill('SIGTERM');
            await deadline(absent.exited);
          }
        })(),
        (async () => {
          if (daemon.exitCode === null) {
            daemon.kill('SIGKILL');
            await deadline(daemon.exited);
          }
        })(),
      ]);
      await daemonErrors;
      expect(cleanup.filter((result) => result.status === 'rejected')).toEqual([]);
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
