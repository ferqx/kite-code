import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { recoveryProfile } from '../fixtures/recovery-profile';

const repo = resolve(import.meta.dir, '../../../..');
for (const mode of ['run', 'interrupt'] as const)
  test(`80x24 actual TUI ${mode} retains original cold intent through lost receipt, Ctrl+C and Ctrl+L`, async () => {
    const f = await recoveryProfile();
    let python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    try {
      const runner = join(f.root, 'runner.ts'),
        network = join(f.root, 'network');
      writeFileSync(
        runner,
        `import {appendFileSync,writeFileSync} from 'node:fs';import {runTUIHost} from ${JSON.stringify(join(repo, 'apps/cli/host/tui.tsx'))};const actual=globalThis.fetch;let saved,lost=false;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const options=args[1],path=new URL(String(args[0])).pathname,body=options?.body?JSON.parse(String(options.body)):null;appendFileSync(${JSON.stringify(network)},JSON.stringify({method:options?.method??'GET',path,body})+'\\n');const result=await actual(...args);if(options?.method==='POST'&&['run.resume','session.recover'].includes(body?.kind)){saved=body.commandId;await result.arrayBuffer();throw Error('committed response physically lost');}if(saved&&!lost&&path==='/v1/commands/'+saved){lost=true;await result.arrayBuffer();writeFileSync(${JSON.stringify(join(f.root, 'lost'))},'lost');throw Error('first original GET physically lost');}return result;},{preconnect:actual.preconnect});await runTUIHost({dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',thread:'s',cwd:${JSON.stringify(f.workspace)},artifact:${JSON.stringify(f.artifact)}});`,
      );
      const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct,sqlite3,json
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(runner)}],stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);buffer=b'';full=b''
def wait(text):
 global buffer,full
 deadline=time.monotonic()+10
 while text not in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace'))):
  if time.monotonic()>deadline:raise RuntimeError('expected '+text+' tail='+buffer[-5000:].decode(errors='replace'))
  if select.select([master],[],[],.05)[0]:
   data=os.read(master,65536);buffer+=data;full+=data
def key(value):
 global buffer
 buffer=b'';os.write(master,value)
try:
 wait('Waiting for answer');key(b'/recovery');wait('/recovery');key(b'\\r');wait('Explicit recovery')
 key(${JSON.stringify(mode === 'run' ? `run ${f.run.id}` : 'interrupt confirm')}.encode());wait(${JSON.stringify(mode === 'run' ? `run ${f.run.id}` : 'interrupt confirm')});key(b'\\r');wait('outcome_unknown');assert os.path.exists(${JSON.stringify(join(f.root, 'lost'))})
 key(b'\\x03');time.sleep(.1);key(b'\\x0c');wait(${JSON.stringify(mode === 'run' ? 'run · resumed' : 'interrupt · interrupted')})
 ${mode === 'run' ? `key(b'\\x1b');wait(${JSON.stringify(f.card.id.slice(0, 24))});key(b'\\x1b[B');wait('only this call');key(b'\\r');wait('RECOVERED_ORIGINAL_DONE')` : ''}
 key(b'\\x11')
 deadline=time.monotonic()+6
 while p.poll() is None and time.monotonic()<deadline:
  if select.select([master],[],[],.05)[0]:
   try:os.read(master,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0;print('ORIGINAL_RECOVERY_CONFIRMED')
finally:
 open(${JSON.stringify(join(f.root, 'pty-output'))},'wb').write(full)
 if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(master)
`;
      python = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([
        new Response(python.stdout).text(),
        new Response(python.stderr).text(),
        python.exited,
      ]);
      if (code !== 0) console.error(err);
      expect(code).toBe(0);
      expect(out).toContain('ORIGINAL_RECOVERY_CONFIRMED');
      const rows = readFileSync(network, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)) as {
        method: string;
        path: string;
        body?: { kind?: string; commandId?: string; runId?: string };
      }[];
      const mutations = rows.filter(
        (row) =>
          row.method === 'POST' && ['run.resume', 'session.recover'].includes(row.body?.kind ?? ''),
      );
      expect(mutations).toHaveLength(1);
      const id = mutations[0]!.body!.commandId!;
      expect(
        rows.filter((row) => row.path === `/v1/commands/${id}` && row.method === 'GET').length,
      ).toBeGreaterThanOrEqual(2);
      expect(rows.filter((row) => row.body?.kind === 'command.cancel')).toHaveLength(0);
      expect(f.rows('SELECT id,origin_command_id,status FROM run')).toEqual([
        {
          id: f.run.id,
          origin_command_id: 'work',
          status: mode === 'run' ? 'completed' : 'interrupted',
        },
      ]);
      if (mode === 'run') {
        expect(mutations[0]!.body!.runId).toBe(f.run.id);
        expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('ORIGINAL_EFFECT_ONCE');
        expect(readFileSync(f.ledger, 'utf8')).toBe('decision\ncompletion\n');
      } else {
        expect(f.calls()).toBe(1);
        expect(existsSync(join(f.workspace, 'effect'))).toBe(false);
      }
    } finally {
      if (python && python.exitCode === null) {
        python.kill('SIGKILL');
        await python.exited;
      }
      f.close();
    }
  }, 30000);

for (const kind of ['run', 'interrupt'] as const)
  test(`80x24 TUI host SIGKILL restores durable ${kind} unknown and performs only the original GET`, async () => {
    const f = await recoveryProfile();
    let python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    const transcript = `${f.root}-cold-${kind}.pty.log`;
    try {
      const runner = join(f.root, 'cold-runner.ts'),
        network = join(f.root, 'cold-network'),
        pidPath = join(f.root, 'service-pid');
      writeFileSync(
        runner,
        `import {appendFileSync,writeFileSync} from 'node:fs';import {runTUIHost} from ${JSON.stringify(join(repo, 'apps/cli/host/tui.tsx'))};const actual=globalThis.fetch;let saved,lost=false;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const options=args[1],path=new URL(String(args[0])).pathname,body=options?.body?JSON.parse(String(options.body)):null;appendFileSync(${JSON.stringify(network)},JSON.stringify({pid:process.pid,method:options?.method??'GET',path,body})+'\\n');const result=await actual(...args);if(options?.method==='POST'&&['run.resume','session.recover'].includes(body?.kind)){saved=body.commandId;await result.arrayBuffer();throw Error('committed recovery response lost');}if(saved&&!lost&&path==='/v1/commands/'+saved){lost=true;await result.arrayBuffer();throw Error('original GET lost');}return result;},{preconnect:actual.preconnect});await runTUIHost({dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',thread:'s',cwd:${JSON.stringify(f.workspace)},artifact:${JSON.stringify(f.artifact)},onLaunched:({pid})=>writeFileSync(${JSON.stringify(pidPath)},String(pid))});`,
      );
      const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct,json
master=None;p=None;buffer=b'';full=b'';owned=[]
def launch():
 global master,p,buffer
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(runner)}],stdin=slave,stdout=slave,stderr=slave,start_new_session=True);owned.append(p);os.close(slave);buffer=b''
def wait(text):
 global buffer,full
 deadline=time.monotonic()+10
 while text not in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace'))):
  if time.monotonic()>deadline:raise RuntimeError('expected '+text+' tail='+buffer[-5000:].decode(errors='replace'))
  if select.select([master],[],[],.05)[0]:
   data=os.read(master,65536);buffer+=data;full+=data
def key(value):
 global buffer
 buffer=b'';os.write(master,value)
try:
 launch();warm=p.pid;wait('Session s');key(b'/recovery');wait('/recovery');key(b'\\r');wait('Explicit recovery');key(${JSON.stringify(kind === 'run' ? `run ${f.run.id}` : 'interrupt confirm')}.encode());wait(${JSON.stringify(kind === 'run' ? `run ${f.run.id}` : 'interrupt confirm')});key(b'\\r');wait('outcome_unknown')
 saved=json.load(open(${JSON.stringify(join(f.profile.profilePath, 'ui/recovery.json'))}));assert len(saved['records'])==1;original=saved['records'][0]['intent'];assert original['sessionId']=='s';assert original['request']['expectedStoreId']==${JSON.stringify(f.storeId)};assert saved['records'][0]['phase'] in ['submitting','outcome_unknown']
 service=int(open(${JSON.stringify(pidPath)}).read());os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=3);assert p.returncode==-signal.SIGKILL;os.close(master);master=None
 deadline=time.monotonic()+6
 while True:
  try:os.kill(service,0)
  except ProcessLookupError:break
  if time.monotonic()>deadline:raise RuntimeError('owned paired Service failed to exit after killed host')
  time.sleep(.02)
 launch();cold=p.pid;assert cold!=warm;wait('Session s');key(b'/recovery');wait('/recovery');key(b'\\r');wait('outcome_unknown');wait(original['request']['commandId']);key(b'\\x03');time.sleep(.1);key(b'\\x0c');wait(${JSON.stringify(kind === 'run' ? 'run · resumed' : 'interrupt · interrupted')});wait(original['request']['commandId']);key(b'\\x11')
 deadline=time.monotonic()+6
 while p.poll() is None and time.monotonic()<deadline:
  if select.select([master],[],[],.05)[0]:
   try:os.read(master,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0
 rows=[json.loads(line) for line in open(${JSON.stringify(network)})];writes=[row for row in rows if row['method']=='POST' and row.get('body') and row['body'].get('kind') in ['run.resume','session.recover']];assert len(writes)==1;assert writes[0]['pid']==warm;assert not [row for row in rows if row['pid']==cold and row['method']=='POST'];assert [row for row in rows if row['pid']==cold and row['path']=='/v1/commands/'+original['request']['commandId']];print('COLD_ORIGINAL_JOURNAL_ONLY_GET')
finally:
 open(${JSON.stringify(transcript)},'wb').write(full)
 for owned_process in owned:
  if owned_process.poll() is None:os.killpg(owned_process.pid,signal.SIGKILL);owned_process.wait()
 if master is not None:os.close(master)
`;
      python = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([
        new Response(python.stdout).text(),
        new Response(python.stderr).text(),
        python.exited,
      ]);
      console.log('PTY transcript', transcript);
      if (code !== 0) console.error(err);
      expect(code).toBe(0);
      expect(out).toContain('COLD_ORIGINAL_JOURNAL_ONLY_GET');
      expect(f.rows('SELECT id,origin_command_id FROM run')).toEqual([
        { id: f.run.id, origin_command_id: 'work' },
      ]);
      expect(f.calls()).toBe(1);
      expect(existsSync(join(f.workspace, 'effect'))).toBe(false);
      expect(f.rows("SELECT kind FROM command WHERE kind='command.cancel'")).toEqual([]);
      const journal = JSON.parse(
        readFileSync(join(f.profile.profilePath, 'ui/recovery.json'), 'utf8'),
      );
      expect(journal.records).toHaveLength(1);
      expect(journal.records[0].phase).toBe(kind === 'run' ? 'resumed' : 'interrupted');
      expect(JSON.stringify(journal)).not.toMatch(/token|generation|lease/);
    } finally {
      if (python && python.exitCode === null) {
        python.kill('SIGKILL');
        await python.exited;
      }
      f.close();
    }
  }, 30000);

test('80x24 configured-host TUI original report ID creates one source-bound report Run after lost receipt and original GET', async () => {
  const { recoveryReportProfile } = await import('../fixtures/recovery-report-profile');
  const { mkdirSync } = await import('node:fs');
  const f = await recoveryReportProfile();
  let python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  const transcript = `${f.root}-report.pty.log`;
  try {
    mkdirSync(join(f.profile.profilePath, 'ui'), { recursive: true, mode: 0o700 });
    writeFileSync(join(f.profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    const runner = join(f.root, 'tui-report.ts'),
      network = join(f.root, 'report-network');
    writeFileSync(
      runner,
      `import {appendFileSync} from 'node:fs';import {runTUIHost} from ${JSON.stringify(join(repo, 'apps/cli/host/tui.tsx'))};const actual=globalThis.fetch;let saved,lost=false;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const options=args[1],path=new URL(String(args[0])).pathname,body=options?.body?JSON.parse(String(options.body)):null;appendFileSync(${JSON.stringify(network)},JSON.stringify({method:options?.method??'GET',path,body})+'\\n');const result=await actual(...args);if(options?.method==='POST'&&path===${JSON.stringify(`/v1/sessions/s/job-reports/${f.reportId}/resume`)}){saved=body.commandId;await result.arrayBuffer();throw Error('committed original report recovery response lost');}if(saved&&!lost&&path==='/v1/commands/'+saved){lost=true;await result.arrayBuffer();throw Error('first original report recovery GET lost');}return result;},{preconnect:actual.preconnect});await runTUIHost({dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',thread:'s',cwd:${JSON.stringify(f.workspace)},artifact:${JSON.stringify(f.artifact)}});`,
    );
    const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(runner)}],stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);buffer=b'';full=b''
def wait(text):
 global buffer,full
 deadline=time.monotonic()+10
 while text not in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace'))):
  if time.monotonic()>deadline:raise RuntimeError('expected '+text+' tail='+buffer[-5000:].decode(errors='replace'))
  if select.select([master],[],[],.05)[0]:
   data=os.read(master,65536);buffer+=data;full+=data
def key(value):
 global buffer
 buffer=b'';os.write(master,value)
try:
 wait('Session s');key(b'/recovery');wait('/recovery');key(b'\\r');wait('Explicit recovery');key(${JSON.stringify(`report ${f.reportId}`)}.encode());wait(${JSON.stringify(`report ${f.reportId}`)});key(b'\\r');wait('outcome_unknown');key(b'\\x03');time.sleep(.1);key(b'\\x0c');wait('report · resumed');key(b'\\x1b');wait('REPORT_ORIGINAL_CHILD_DONE');key(b'\\x11')
 deadline=time.monotonic()+6
 while p.poll() is None and time.monotonic()<deadline:
  if select.select([master],[],[],.05)[0]:
   try:os.read(master,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0;print('ORIGINAL_REPORT_RUN_CONFIRMED')
finally:
 open(${JSON.stringify(transcript)},'wb').write(full)
 if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(master)
`;
    python = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([
      new Response(python.stdout).text(),
      new Response(python.stderr).text(),
      python.exited,
    ]);
    console.log('PTY transcript', transcript);
    if (code !== 0) console.error(err);
    expect(code).toBe(0);
    expect(out).toContain('ORIGINAL_REPORT_RUN_CONFIRMED');
    const rows = readFileSync(network, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)) as {
      method: string;
      path: string;
      body?: { commandId?: string; kind?: string };
    }[];
    const posts = rows.filter(
      (row) =>
        row.method === 'POST' && row.path === `/v1/sessions/s/job-reports/${f.reportId}/resume`,
    );
    expect(posts).toHaveLength(1);
    const original = posts[0]!.body!.commandId!;
    expect(
      rows.filter((row) => row.method === 'GET' && row.path === `/v1/commands/${original}`).length,
    ).toBeGreaterThanOrEqual(2);
    expect(rows.filter((row) => row.body?.kind === 'command.cancel')).toHaveLength(0);
    expect(
      f.rows("SELECT origin_command_id,status FROM run WHERE session_id='s' ORDER BY started_at"),
    ).toEqual([
      { origin_command_id: 'work', status: 'completed' },
      { origin_command_id: f.reportId, status: 'completed' },
    ]);
    expect(f.calls()).toEqual({ parentCalls: 3, childCalls: 1, reviewCalls: 2 });
    expect(
      f.rows(
        `SELECT state,attempt,result_revision,delivery FROM execution WHERE id='${f.executionId}'`,
      ),
    ).toEqual([{ state: 'succeeded', attempt: 1, result_revision: 1, delivery: 'consumed' }]);
  } finally {
    if (python && python.exitCode === null) {
      python.kill('SIGKILL');
      await python.exited;
    }
    f.close();
  }
}, 30000);
