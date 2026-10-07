import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { launchPairedService } from '@kite-ai/service/paired';
import { terminalSqliteEngineRoot } from '@kite-ai/service/sqlite-release-assets';
import { verifyTerminalBundle } from '../../host/terminal-artifact';

const repository = resolve(import.meta.dir, '../../../..');
for (const mode of ['complete'] as readonly string[]) {
  test(`formal Terminal PTY reads original tail result/reason and exports frozen giant text in the original profile`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tui-host-')));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'default' });
    let calls = 0;
    let completeSource = false;
    const sourceTail = 'ORIGINAL_SOURCE_NINE_MIB_TAIL';
    if (mode === 'complete')
      writeFileSync(join(workspace, 'source.txt'), `${'中'.repeat(3 * 1024 * 1024)}${sourceTail}`);
    const tail = 'ACTUAL_HOST_VERIFIED_TAIL';
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      maxRequestBodySize: 64 * 1024 * 1024,
      async fetch(request) {
        const actual = JSON.stringify(await request.json());
        calls++;
        if (calls > 1 && actual.includes(sourceTail)) completeSource = true;
        const delta =
          mode === 'complete' && calls > 1
            ? {
                content: `${'正文'.repeat(1500000)}${tail}`,
                reasoning_content: 'ACTUAL_LOADED_REASON_TAIL',
              }
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: 'write-original',
                    type: 'function',
                    function: {
                      name: mode === 'complete' ? 'files.read' : 'files.write',
                      arguments: JSON.stringify(
                        mode === 'complete'
                          ? { path: 'source.txt' }
                          : { path: 'effect.txt', base: null, content: 'owned effect' },
                      ),
                    },
                  },
                ],
              };
        const chunk = (value: unknown, finish: string | null) =>
          `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
        return new Response(
          `${chunk(delta, null)}${chunk({}, mode === 'complete' && calls > 1 ? 'stop' : 'tool_calls')}data: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    try {
      const build = Bun.spawn(
        [
          process.execPath,
          join(repository, 'scripts/release/terminal.ts'),
          'build',
          '--directory',
          join(root, 'candidate'),
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const [buildOut, buildErr, buildExit] = await Promise.all([
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
        build.exited,
      ]);
      if (buildExit !== 0) console.error(buildOut + buildErr);
      expect(buildExit).toBe(0);
      const candidate = verifyTerminalBundle(join(root, 'candidate'));
      const artifact = candidate.artifact;
      // Use the verified formal engine before the fixture's first independent DB read.
      const engine = initializeSqliteEngine({
        root: join(candidate.root, terminalSqliteEngineRoot),
        manifestSha256: candidate.manifest.sqlite.manifestSha256,
      });
      expect(engine).toMatchObject({
        qualification: 'selected',
        linkage: candidate.manifest.sqlite.linkage,
        version: candidate.manifest.sqlite.version,
        sourceId: candidate.manifest.sqlite.sourceId,
      });
      mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
      // This fixture asserts English labels independently of the host device locale.
      mkdirSync(join(profile.profilePath, 'ui'), { recursive: true, mode: 0o700 });
      writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
        mode: 0o600,
      });
      writeFileSync(
        join(profile.profilePath, 'config.jsonc'),
        JSON.stringify({
          modelId: 'local',
          tools: [
            { id: 'files.write', definitionVersion: '2' },
            { id: 'files.read', definitionVersion: '3' },
          ],
          models: [
            {
              id: 'local',
              provider: 'compatible',
              model: 'fixture',
              baseURL: `${provider.url.href}v1`,
            },
          ],
        }),
        { mode: 0o600 },
      );
      const seed = await launchPairedService({
        profile,
        ...artifact,
        instanceId: crypto.randomUUID(),
        requiredCapabilities: ['sessions', 'commands', 'permission_controls'],
      });
      try {
        if (seed.bootstrap.dataAvailability !== 'available') throw new Error('seed_unavailable');
        const storeId = seed.bootstrap.storeId;
        await seed.client.createWorkspace({
          expectedStoreId: storeId,
          id: 'w',
          rootUri: pathToFileURL(workspace).href,
          name: 'Owned workspace',
        });
        await seed.client.createSession({
          expectedStoreId: storeId,
          commandId: 'create-a',
          sessionId: 'a',
          workspaceId: 'w',
          title: 'Owned Session',
        });
        const observed = await seed.client.getWorkspaceTrust('w', { storeId });
        await seed.client.setWorkspaceTrust('w', {
          expectedStoreId: storeId,
          commandId: 'trust',
          canonicalIdentity: observed.canonicalIdentity,
          externalReadScopeDigest: observed.externalReadScopeDigest,
          trusted: true,
          ifRevision: observed.revision,
        });
        const policy = await seed.client.getPermissionMode('a', { storeId });
        await seed.client.setPermissionMode('a', {
          expectedStoreId: storeId,
          commandId: 'ask',
          mode: 'ask',
          ifRevision: policy.revision,
          makeDefault: false,
          ifDefaultRevision: policy.defaultRevision,
        });
      } finally {
        await seed.close();
      }
      const program = `import os,pty,subprocess,select,time,signal,re,json,sqlite3,fcntl,termios,struct
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
p=subprocess.Popen([${JSON.stringify(artifact.executable)},${JSON.stringify(join(candidate.root, candidate.manifest.entries.tui))},'--workspace',${JSON.stringify(workspace)},'--thread','a','--data-root',${JSON.stringify(join(root, 'data'))}],cwd=${JSON.stringify(root)},stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
os.close(slave);buffer=b'';full_tail_observed=False;reason_seen=False;clear_seen=False
def record(data):
 global buffer,reason_seen,clear_seen
 window=buffer[-64:]+data
 reason_seen=reason_seen or b'ACTUAL_LOADED_REASON_TAIL' in window
 clear_seen=clear_seen or b'\\x1b[3J' in window
 buffer=(buffer+data)[-131072:]
def reset_frame():
 global buffer,reason_seen,clear_seen
 buffer=b'';reason_seen=False;clear_seen=False
def compact():
 return re.sub(r'\\s+','',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace')))
def tool_result():
 text=compact()
 assert 'files.read[' in text, ('missing original tool header',text[-2000:])
 return text.rsplit('files.read[',1)[1].split('Ctrl+Bpendingcards',1)[0]
def wait(text):
 global buffer
 deadline=time.monotonic()+30
 while re.sub(r'\\s+','',text) not in re.sub(r'\\s+','',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace'))):
  if time.monotonic()>deadline: raise RuntimeError('expected '+text+' tail='+buffer[-2000:].decode(errors='replace'))
  if select.select([master],[],[],.1)[0]:
   try: record(os.read(master,65536))
   except OSError: raise RuntimeError('host ended '+buffer[-2000:].decode(errors='replace'))
try:
 wait('New Run');owned=[int(line.split()[0]) for line in subprocess.check_output(['ps','-axo','pid,ppid'],text=True).splitlines()[1:] if len(line.split())==2 and line.split()[1]==str(p.pid)];assert owned;os.write(master,b'owned task');time.sleep(.1);os.write(master,b'\\r')
 ${
   mode === 'complete'
     ? `wait('9000025 bytes, complete');os.write(master,b'/export');wait('New Run > /export');os.write(master,b'\\r');wait('Exported loaded conversation:');import glob;files=glob.glob(${JSON.stringify(join(profile.profilePath, 'session-*.md'))});assert len(files)==1, ('first export paths',files);preview=open(files[0],encoding='utf8').read();assert 'Loaded preview only' in preview, ('missing preview marker',preview[-1000:]);assert '${tail}' not in preview, 'unread full tail unexpectedly exported';assert 'ACTUAL_LOADED_REASON_TAIL' not in preview, 'unread reasoning unexpectedly exported';buffer=b'';time.sleep(.1);os.write(master,b'\\x0f');time.sleep(.4);
 for_drain=time.monotonic()+1
 while time.monotonic()<for_drain:
  if select.select([master],[],[],.05)[0]: buffer=(buffer+os.read(master,65536))[-131072:]
 wait('${tail}');full_tail_observed=True;wait('New Run >')
 reset_frame();os.write(master,b'\\r');wait('Result collapsed');wait('Empty Enter expands the current tail result')
 assert clear_seen and not reason_seen and '${tail}' in compact(), ('collapse original content',clear_seen,reason_seen,compact()[-2000:])
 assert 'Resultcollapsed' in tool_result() and '"artifactRefs"' not in tool_result(), ('collapsed result',tool_result())
 reset_frame();os.write(master,b'\\r');wait('${tail}');wait('Empty Enter collapses the current tail result')
 assert clear_seen and not reason_seen and '${tail}' in compact(), ('expand original content',clear_seen,reason_seen,compact()[-2000:])
 assert '"artifactRefs"' in tool_result() and 'Resultcollapsed' not in tool_result(), ('expanded result',tool_result())
 print('TAIL_RESULT_COLLAPSE_EXPAND_ORIGINAL_ARTIFACT_REFS')
 reset_frame();os.write(master,b'\\x14');wait('ACTUAL_LOADED_REASON_TAIL');wait('${tail}');wait('Ctrl+T hides recorded reasoning')
 assert clear_seen and reason_seen, ('show original reasoning',clear_seen,reason_seen)
 reset_frame();os.write(master,b'\\x14');wait('${tail}');wait('Ctrl+T shows recorded reasoning')
 assert clear_seen and not reason_seen and '"artifactRefs"' in tool_result(), ('hide only reasoning',clear_seen,reason_seen,tool_result())
 print('RECORDED_REASON_SHOW_HIDE_ORIGINAL_CONTENT')
 buffer=b'';os.write(master,b'/export');wait('New Run > /export');buffer=b'';os.write(master,b'\\r');export_deadline=time.monotonic()+30
 while len(glob.glob(${JSON.stringify(join(profile.profilePath, 'session-*.md'))}))<2:
  if time.monotonic()>export_deadline: raise RuntimeError('second export missing tail='+buffer[-2000:].decode(errors='replace'))
  if select.select([master],[],[],.1)[0]: buffer=(buffer+os.read(master,65536))[-131072:]
 files=glob.glob(${JSON.stringify(join(profile.profilePath, 'session-*.md'))});assert len(files)==2, ('second export paths',files);newest=max(files,key=os.path.getmtime);wait(os.path.basename(newest));full=max((open(f,encoding='utf8').read() for f in files),key=len);assert len(full.encode('utf8'))>8*1024*1024 and '${tail}' in full and '> ACTUAL_LOADED_REASON_TAIL' in full;assert all(os.stat(f).st_mode&0o777==0o600 for f in files);print('EXPORT_FULL_TAIL_REASON_0600');os.write(master,b'\\x11')`
     : mode === 'cancel'
       ? `wait('approval [');buffer=b'';os.write(master,b'\\x03');time.sleep(.1);os.write(master,b'\\x03');wait('Idle');os.write(master,b'\\x11')`
       : `wait('approval [');os.close(master);master=-1;time.sleep(.3);assert p.poll() is None;db=sqlite3.connect('file:'+${JSON.stringify(profile.databasePath)}+'?mode=ro',uri=True);assert db.execute('SELECT status FROM run').fetchall()==[('waiting_interaction',)];assert db.execute("SELECT count(*) FROM interaction WHERE state='accepted'").fetchone()[0]==0;db.close();print('EOF_WAITING_ZERO_APPROVAL');os.kill(p.pid,signal.SIGTERM)`
}
 deadline=time.monotonic()+6
 while master>=0 and p.poll() is None and time.monotonic()<deadline:
  if select.select([master],[],[],.1)[0]:
   try: buffer=(buffer+os.read(master,65536))[-131072:]
   except OSError: break
 p.wait(timeout=3);assert p.returncode==0, ('exit '+str(p.returncode)+' tail='+buffer[-2000:].decode(errors='replace'))
 for pid in owned:
  try: os.kill(pid,0);raise RuntimeError('owned Service process remains')
  except ProcessLookupError: pass
 print('OWNED_SERVICE_STOPPED')
 print('HOST_EXIT '+str(p.returncode))
 print('FULL_TAIL_OBSERVED '+str(full_tail_observed))
finally:
 if p.poll() is None: os.killpg(p.pid,signal.SIGKILL);p.wait()
 if master>=0: os.close(master)
`;
      const child = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
      const [out, err, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exit !== 0) console.error(err);
      expect(exit).toBe(0);
      expect(err).toBe('');
      expect(out).toContain('HOST_EXIT 0');
      expect(out).toContain('OWNED_SERVICE_STOPPED');
      if (mode === 'eof') expect(out).toContain('EOF_WAITING_ZERO_APPROVAL');
      expect(existsSync(join(workspace, 'effect.txt'))).toBe(false);
      expect(calls).toBe(mode === 'complete' ? 2 : 1);
      const database = new Database(profile.databasePath, { readonly: true });
      try {
        const runs = database.query('SELECT status FROM run').all();
        expect(runs).toEqual([
          {
            status: mode === 'complete' ? 'completed' : 'cancelled',
          },
        ]);
        expect(
          database
            .query("SELECT count(*) AS n FROM execution WHERE kind='tool' AND state='succeeded'")
            .get(),
        ).toEqual({ n: mode === 'complete' ? 1 : 0 });
        if (mode === 'complete') {
          expect(out).toContain('FULL_TAIL_OBSERVED True');
          expect(out).toContain('EXPORT_FULL_TAIL_REASON_0600');
          expect(out).toContain('TAIL_RESULT_COLLAPSE_EXPAND_ORIGINAL_ARTIFACT_REFS');
          expect(out).toContain('RECORDED_REASON_SHOW_HIDE_ORIGINAL_CONTENT');
          expect(completeSource).toBe(true);
          expect(database.query('SELECT count(*) AS n FROM session').get()).toEqual({ n: 1 });
        } else
          expect(
            database.query("SELECT count(*) AS n FROM interaction WHERE state='accepted'").get(),
          ).toEqual({ n: 0 });
      } finally {
        database.close();
      }
      // A new genuine paired owner can acquire the same profile immediately after explicit host exit.
      const reopened = await launchPairedService({
        profile,
        ...artifact,
        instanceId: crypto.randomUUID(),
        requiredCapabilities: ['sessions'],
      });
      await reopened.close();
      expect(calls).toBe(mode === 'complete' ? 2 : 1);
    } finally {
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 90000);
}
