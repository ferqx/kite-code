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
for (const mode of ['paired', 'shared', 'shared-loss'] as const)
  test(`80x24 actual ${mode} TUI status checks original host with no work and preserves failed facts`, async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-tui-status-'));
    const workspace = join(root, 'workspace'),
      ledger = join(root, 'reads'),
      ownedPid = join(root, 'owned-pid');
    mkdirSync(workspace, { mode: 0o700 });
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    // This fixture asserts English labels independently of the host device locale.
    mkdirSync(join(profile.profilePath, 'ui'), { recursive: true, mode: 0o700 });
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    let calls = 0;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        calls++;
        return new Response('unexpected Model', { status: 500 });
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
      buildId: 'owned-status',
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
          await seed.client.createSession({
            expectedStoreId: storeId,
            commandId: 'create',
            sessionId: 'a',
            workspaceId: 'w',
            title: 'status',
          });
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
              buildId: 'owned-status',
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
            requiredCapabilities: ['sessions', 'host_status'],
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
          title: 'status',
        });
      }
      const runner = join(root, 'runner.ts');
      writeFileSync(
        runner,
        `import {appendFileSync,writeFileSync} from 'node:fs';import {runTUIHost} from ${JSON.stringify(join(repo, 'apps/cli/host/tui.tsx'))};const actual=globalThis.fetch;let gets=0;globalThis.fetch=async(...args)=>{const response=await actual(...args);if(String(args[0]).includes('/diagnostics/host-status')){const value=await response.clone().json();appendFileSync(${JSON.stringify(ledger)},JSON.stringify(value)+'\\n');if(++gets===2)throw Error('SECRET endpoint token')}return response};const exit=new AbortController();process.once('SIGTERM',()=>exit.abort());await runTUIHost({exitSignal:exit.signal,onLaunched:({pid})=>writeFileSync(${JSON.stringify(ownedPid)},String(pid)),${mode === 'paired' ? `artifact:${JSON.stringify(artifact)}` : `server:${JSON.stringify(socket)}`},dataRoot:${JSON.stringify(profile.dataRoot)},profile:'development',thread:'a',cwd:${JSON.stringify(workspace)}});`,
      );
      const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct,sqlite3,json
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(runner)}],stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);buffer=b'';all_output=b''
def wait(text):
 global buffer,all_output
 end=time.monotonic()+10
 while text not in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace'))):
  if time.monotonic()>end:raise RuntimeError('expected '+text+' tail='+buffer[-6000:].decode(errors='replace'))
  if select.select([master],[],[],.05)[0]:
   data=os.read(master,65536);buffer+=data;all_output+=data
def key(value):
 global buffer
 buffer=b'';os.write(master,value)
try:
 wait('New Run >');key(b'/status');wait('/status');key(b'\\r');wait('Connection: verified');wait('${mode === 'paired' ? 'paired' : 'shared'}');wait('Profile: development');wait('Build: owned-status');wait('Workspace: w');wait('Session: a');wait('Shell: unavailable');wait('Telemetry: disabled')
 rows=[json.loads(row) for row in open(${JSON.stringify(ledger)})];assert len(rows)==1;assert rows[0]['scope']=={'workspaceId':'w','sessionId':'a'};assert rows[0]['identity']['storeId']==${JSON.stringify(storeId)}
 key(b'r');wait('Connection: unknown');wait('Last confirmed host facts');wait('Build: owned-status');assert b'SECRET' not in all_output
 key(b'r');wait('Connection: verified');key(b'\\x03');wait('New Run >');assert len(open(${JSON.stringify(ledger)}).readlines())==3
 key(b'/status');wait('/status');key(b'\\r');wait('Connection: verified')
 ${mode === 'shared-loss' ? `os.kill(${daemon?.pid},signal.SIGKILL);wait('Connection: unknown');key(b'r');wait('Current host status unknown');wait('Last confirmed host facts');wait('Build: owned-status')` : ''}
 key(b'\\x1b');wait('New Run >');db=sqlite3.connect('file:'+${JSON.stringify(profile.databasePath)}+'?mode=ro',uri=True);assert db.execute('select count(*) from run').fetchone()[0]==0;assert db.execute('select count(*) from execution').fetchone()[0]==0;assert db.execute("select count(*) from command where kind='command.cancel'").fetchone()[0]==0;db.close();key(b'\\x11')
 end=time.monotonic()+6
 while p.poll() is None and time.monotonic()<end:
  if select.select([master],[],[],.05)[0]:
   try:all_output+=os.read(master,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0
 assert ${JSON.stringify(profile.profileAccessKey)}.encode() not in all_output;assert ${JSON.stringify(profile.profilePath)}.encode() not in all_output;assert b'httpEndpoint' not in all_output
 ${
   mode === 'paired'
     ? `pid=int(open(${JSON.stringify(ownedPid)}).read());
 try:os.kill(pid,0);raise RuntimeError('owned Service remains')
 except ProcessLookupError:pass`
     : ''
}
 print('STATUS_ORIGINAL_COMPLETE')
finally:
 if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
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
      expect(out).toContain('STATUS_ORIGINAL_COMPLETE');
      expect(calls).toBe(0);
      if (mode === 'shared') {
        expect(daemon!.exitCode).toBeNull();
        expect((await client!.verifyConnection()).storeId).toBe(storeId);
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
