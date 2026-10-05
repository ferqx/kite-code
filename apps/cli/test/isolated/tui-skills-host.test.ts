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
for (const mode of ['paired', 'shared'] as const)
  test(`80x24 actual ${mode} TUI Skills reads full real catalogue and discards old scope replies without work`, async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-tui-skills-'));
    const workspace = join(root, 'workspace'),
      ledger = join(root, 'catalogue-reads'),
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
    let releasePage!: () => void;
    const pageHeld = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/held-page') {
          await pageHeld;
          return new Response('released');
        }
        if (path === '/release-page') {
          releasePage();
          return new Response('released');
        }
        calls++;
        return new Response('unexpected Model', { status: 500 });
      },
    });
    const skills = [
      { id: 'a000', path: 'a000' },
      { id: 'a001-disabled', path: 'a001', enabled: false },
      { id: 'a002-broken', path: 'a002' },
      { id: 'a003-missing', path: 'a003' },
      ...Array.from({ length: 300 }, (_, i) => ({
        id: `g${String(i).padStart(3, '0')}`,
        path: `g${String(i).padStart(3, '0')}`,
      })),
    ];
    for (const skill of skills) {
      mkdirSync(join(workspace, skill.path));
      writeFileSync(
        join(workspace, skill.path, 'SKILL.md'),
        skill.id === 'a002-broken'
          ? 'invalid\0'
          : `---\nname: ${skill.id === 'a000' ? 'Guide000' : skill.id}\ndescription: ${'metadata '.repeat(128)}\n${skill.id === 'a003-missing' ? 'required-capabilities: fixture.unavailable\n' : ''}---\nKnowledge only; never execute script.sh\n`,
      );
      writeFileSync(
        join(workspace, skill.path, 'script.sh'),
        `touch ${join(root, 'script-effect')}\n`,
      );
    }
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        skills,
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
      buildId: 'owned-skills',
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
              buildId: 'owned-skills',
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
            requiredCapabilities: ['sessions', 'skill_catalogue'],
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
      const runner = join(repo, 'apps/cli/test/fixtures/tui-skills-runner.ts');
      const settings = {
        root,
        dataRoot: profile.dataRoot,
        workspace,
        control: provider.url.href,
        ...(mode === 'paired' ? { artifact } : { server: socket }),
      };
      const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct,sqlite3,json,urllib.request
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));env=dict(os.environ);env['TUI_SKILLS_SETTINGS']=${JSON.stringify(JSON.stringify(settings))};p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(runner)}],env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);buffer=b'';all_output=b''
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
def rows():return [json.loads(row) for row in open(${JSON.stringify(ledger)})]
def counts():
 db=sqlite3.connect('file:'+${JSON.stringify(profile.databasePath)}+'?mode=ro',uri=True);values={table:db.execute('select count(*) from '+table).fetchone()[0] for table in ['session','run','execution','command','host_mutation']};db.close();return values
try:
 wait('New Run >');baseline=counts();key(b'/skills');wait('/skills');key(b'\\r');wait('Knowledge Skills');wait('total 304');wait('Catalog read: verified');wait('Guide000 [available]');wait('a001-disabled [disabled]');wait('a002-broken [unavailable]');wait('a003-missing [unavailable]')
 key(b'\\x1b[B'*303);wait('Entry 304/304');wait('g299 [available]');key(b'\\x1b[A'*303);wait('Entry 1/304');wait('Guide000 [available]')
 original=rows();assert len(original)>1;entries=[entry for page in original for entry in page['value']['entries']];assert len(entries)==304;assert len({entry['id'] for entry in entries})==304;assert original[-1]['value']['complete'];assert len({page['value']['revision'] for page in original})==1
 assert next(entry for entry in entries if entry['id']=='a002-broken')['state']=='unavailable';assert next(entry for entry in entries if entry['id']=='a001-disabled')['state']=='disabled';assert next(entry for entry in entries if entry['id']=='a003-missing')['missingCapabilities']==['fixture.unavailable'];os.write(master,b'\\r');time.sleep(.1);assert counts()==baseline
 key(b'r');end=time.monotonic()+5
 while not os.path.exists(${JSON.stringify(join(root, 'held-page'))}):
  if time.monotonic()>end:raise RuntimeError('refresh did not request original page')
  time.sleep(.01)
 key(b'\\x1b');wait('New Run >');key(b'\\x12');wait('Select Session');wait('> Beta [b]');key(b'\\r');wait('Session b · Idle')
 open(${JSON.stringify(join(workspace, 'a000', 'SKILL.md'))},'w').write('---\\nname: ScopeFresh000\\ndescription: refreshed real file\\n---\\nKnowledge only; never execute script.sh\\n')
 key(b'/skills');wait('/skills');key(b'\\r');wait('Catalog read: verified');wait('ScopeFresh000 [available]')
 urllib.request.urlopen(${JSON.stringify(`${provider.url.href}release-page`)}).read();time.sleep(.2);key(b'\\x1b[B');wait('ScopeFresh000 [available]');key(b'\\x1b[A');wait('ScopeFresh000 [available]');assert counts()==baseline
 key(b'\\x1b');wait('Session b');key(b'/skills');wait('/skills');key(b'\\r');wait('ScopeFresh000 [available]');wait('Read only');assert counts()==baseline;assert not os.path.exists(${JSON.stringify(join(root, 'script-effect'))});key(b'\\x03');wait('New Run >');key(b'\\x11')
 end=time.monotonic()+6
 while p.poll() is None and time.monotonic()<end:
  if select.select([master],[],[],.05)[0]:
   try:all_output+=os.read(master,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0;assert counts()==baseline
 print('SKILLS_ORIGINAL_COMPLETE')
finally:
 if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(master)
`;
      python = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
      const [out, err, exitCode] = await Promise.all([
        new Response(python.stdout).text(),
        new Response(python.stderr).text(),
        python.exited,
      ]);
      if (exitCode) {
        console.error(out, err);
        try {
          const pages = readFileSync(ledger, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          console.error(
            'Actual skill HTTP facts',
            JSON.stringify(
              pages.map((page) => ({
                query: page.query,
                ...(!page.value.entries
                  ? { body: page.value }
                  : {
                      availability: page.value.availability,
                      reason: page.value.reason,
                      count: page.value.entries.length,
                      revision: page.value.revision,
                      complete: page.value.complete,
                    }),
              })),
            ),
          );
        } catch {}
      }
      expect(exitCode).toBe(0);
      expect(out).toContain('SKILLS_ORIGINAL_COMPLETE');
      expect(calls).toBe(0);
      if (mode === 'paired') {
        const pid = Number(readFileSync(ownedPid, 'utf8'));
        expect(() => process.kill(pid, 0)).toThrow();
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
      releasePage();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 40000);
