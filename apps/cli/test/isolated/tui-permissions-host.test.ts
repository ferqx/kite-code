import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';

const repo = resolve(import.meta.dir, '../../../..');
test('built Service and actual PTY permission controls create exact Shell grants, clear only selected Session, no default approval', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tui-permissions-'))),
    workspace = join(root, 'workspace'),
    profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
  mkdirSync(workspace, { mode: 0o700 });
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
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      calls++;
      const last = body.messages.reduce(
          (last, m, i) => (m.role === 'user' && /^owned-[123]$/.test(m.content) ? i : last),
          -1,
        ),
        key = body.messages[last]!.content,
        results = body.messages.slice(last + 1).filter((m) => m.role === 'tool');
      const call =
        results.length === 0
          ? {
              name: 'shell.launch',
              input: { key, command: "printf 'owned\\n' >> effects", cancellation: 'attached' },
            }
          : results.length === 1
            ? { name: 'shell.wait', input: { shellId: key, timeoutMs: 4000 } }
            : undefined;
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call${calls}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              },
            ],
          }
        : { content: `DONE ${key}` };
      const frame = (d: unknown, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta: d, finish_reason: reason }] })}\n\n`;
      return new Response(
        `${frame(delta, null)}${frame({}, call ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  try {
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'fixed',
        tools: ['shell.launch', 'shell.wait'].map((id) => ({ id, definitionVersion: '1' })),
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
    const fixture = join(root, 'service.ts');
    writeFileSync(
      fixture,
      `import {runServiceProcess} from ${JSON.stringify(join(repo, 'apps/service/dist/main.js'))};import {createDefaultProcessConfiguration} from ${JSON.stringify(join(repo, 'apps/service/dist/configuration.js'))};import {selectProfile} from ${JSON.stringify(join(repo, 'packages/agent/dist/profile.js'))};await runServiceProcess({configure:startup=>createDefaultProcessConfiguration({profile:selectProfile({dataRoot:startup.profile.dataRoot,profile:startup.profile.profile}),shell:{platform:'darwin',configurationId:'owned-shell',env:{PATH:'/usr/bin:/bin'},supervisorPath:${JSON.stringify(join(repo, 'packages/agent/dist/platform/process/shell-supervisor.js'))},bunExecutable:${JSON.stringify(realpathSync(process.execPath))},shellExecutable:'/bin/sh',graceMs:20}})});`,
    );
    const built = await Bun.build({
      entrypoints: [fixture],
      outdir: join(root, 'built'),
      target: 'bun',
      packages: 'external',
      external: [
        join(repo, 'apps/service/dist/main.js'),
        join(repo, 'apps/service/dist/configuration.js'),
        join(repo, 'packages/agent/dist/profile.js'),
      ],
    });
    expect(built.success).toBe(true);
    const entrypoint = built.outputs[0]!.path,
      sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
      artifact = {
        entrypoint,
        entrypointSha256: sha(readFileSync(entrypoint)),
        executable: realpathSync(process.execPath),
        executableSha256: sha(readFileSync(process.execPath)),
        buildId: 'owned-permission-host',
        apiMajor: 1,
      };
    const seed = await launchPairedService({
      profile,
      ...artifact,
      instanceId: crypto.randomUUID(),
      requiredCapabilities: ['sessions', 'permission_controls', 'permission_grants'],
    });
    try {
      const expectedStoreId = seed.bootstrap.storeId!;
      await seed.client.createWorkspace({
        expectedStoreId,
        id: 'w',
        rootUri: `file://${workspace}`,
        name: 'owned',
      });
      await seed.client.createSession({
        expectedStoreId,
        commandId: 'create',
        sessionId: 'a',
        workspaceId: 'w',
        title: 'permissions',
      });
    } finally {
      await seed.close();
    }
    const runner = join(root, 'runner.ts');
    writeFileSync(
      runner,
      `import {runTUIHost} from ${JSON.stringify(join(repo, 'apps/cli/host/tui.tsx'))};await runTUIHost({artifact:${JSON.stringify(artifact)},dataRoot:${JSON.stringify(profile.dataRoot)},profile:'development',thread:'a',cwd:${JSON.stringify(workspace)}});`,
    );
    const program = `import os,pty,subprocess,select,time,signal,re,json,sqlite3
master,slave=pty.openpty();p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(runner)}],stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);buffer=b''
def wait(text):
 global buffer
 end=time.monotonic()+10
 while text not in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace'))):
  if time.monotonic()>end:
   db=sqlite3.connect(${JSON.stringify(profile.databasePath)});print('FINITE_SQL '+json.dumps({'executions':db.execute('select kind,adapter_id,state,cancel_requested from execution').fetchall(),'interactions':db.execute('select definition_id,state,accepted_decision_revision,answer_json from interaction').fetchall(),'runs':db.execute('select status from run').fetchall()}),flush=True);db.close();raise RuntimeError('expected '+text+' tail='+buffer[-3000:].decode(errors='replace'))
  if select.select([master],[],[],.1)[0]:buffer+=os.read(master,65536)
def send(text):
 global buffer
 buffer=b'';os.write(master,text.encode());wait('New Run > '+text);buffer=b'';os.write(master,b'\\r')
def key(value):
 global buffer
 buffer=b'';os.write(master,value);time.sleep(.2)
def pump():
 global buffer
 end=time.monotonic()+.4
 while time.monotonic()<end:
  if select.select([master],[],[],.05)[0]:buffer+=os.read(master,65536)
try:
 wait('New Run');send('/permissions');wait('Saved same_command grants: 0');key(b't');wait('Confirm original');key(b'\\r');wait('workspace.trust: applied');wait('trusted, revision');pump();key(b'\\r');wait('Confirm original');key(b'\\r');wait('permission.mode: applied');key(b'\\x1b');wait('New Run >');send('owned-1');wait('same_command');key(b'\\r');pump()
 db=sqlite3.connect(${JSON.stringify(profile.databasePath)});assert db.execute('select count(*) from interaction where answer_json is not null').fetchone()[0]==0;db.close();assert not os.path.exists(${JSON.stringify(join(workspace, 'effects'))})
 key(b'\\x1b[B');key(b'\\x1b[B');wait('same command in original Session');key(b'\\r');wait('interaction.answer: applied');pump()
 db=sqlite3.connect(${JSON.stringify(profile.databasePath)});end=time.monotonic()+5;card=None
 while card is None and time.monotonic()<end:
  card=db.execute("select id from interaction where definition_id='shell.command' and state='pending'").fetchone();pump()
 db.close();assert card is not None;wait('approval ['+card[0]+'] original Session');pump();key(b'\\x1b[B');key(b'\\x1b[B');wait('same command in original Session');key(b'\\r');wait('DONE owned-1');pump();send('/permissions');wait('Saved same_command grants: 2');key(b'\\x1b');wait('New Run >');send('owned-2');wait('DONE owned-2');pump();send('/permissions');wait('Saved same_command grants: 2');key(b'c');wait('Confirm original');key(b'\\r');wait('permission.grants.clear: applied');wait('Saved same_command grants: 0');key(b'\\x1b');wait('New Run >');send('owned-3');wait('same_command');key(b'\\x03');pump();key(b'\\x11')
 end=time.monotonic()+6
 while p.poll() is None and time.monotonic()<end:
  if select.select([master],[],[],.1)[0]:
   try:buffer+=os.read(master,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0;print('PERMISSIONS_ORIGINAL_COMPLETE')
finally:
 if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(master)
`;
    const child = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0) console.error(out, err);
    expect(exit).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('PERMISSIONS_ORIGINAL_COMPLETE');
    expect(readFileSync(join(workspace, 'effects'), 'utf8')).toBe('owned\nowned\n');
    expect(calls).toBe(7);
    const db = new Database(profile.databasePath, { readonly: true });
    try {
      expect(
        db.query('SELECT count(*) AS n FROM interaction WHERE answer_json IS NOT NULL').get(),
      ).toEqual({ n: 2 });
      expect(
        db
          .query(
            "SELECT count(*) AS n FROM host_mutation WHERE kind='permission.grants.clear' AND state='applied'",
          )
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  } finally {
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 40000);
