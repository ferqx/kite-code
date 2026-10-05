import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { recoveryProfile } from '../../../../../apps/cli/test/fixtures/recovery-profile';

const repo = resolve(import.meta.dir, '../../../../..');
test('actual owned Service and 80x24 PTY accept new input in the original explicitly interrupted Session with exact cancelled history', async () => {
  const f = await recoveryProfile();
  let python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  const transcript = `${f.root}-original-session-history.pty.log`;
  try {
    const cold = await f.launch();
    try {
      const report = await cold.client.recoverSession('s', {
        kind: 'session.recover',
        expectedStoreId: f.storeId,
        commandId: 'interrupt',
        decision: 'interrupt',
      });
      if (report.receipt?.kind !== 'session_interrupted')
        throw Error('original_interrupt_not_applied');
      expect(report.receipt.unknownExecutionIds).toEqual([]);
      expect(report.receipt.cancelledExecutionIds).toEqual([f.card.executionId]);
    } finally {
      await cold.close();
    }
    expect(existsSync(join(f.workspace, 'effect'))).toBe(false);
    const network = join(f.root, 'followup-network');
    const runner = join(f.root, 'followup-runner.ts');
    writeFileSync(
      runner,
      `import{appendFileSync}from'node:fs';import{runTUIHost}from${JSON.stringify(join(repo, 'apps/cli/host/tui.tsx'))};const actual=globalThis.fetch;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{appendFileSync(${JSON.stringify(network)},JSON.stringify({method:args[1]?.method??'GET',path:new URL(String(args[0])).pathname,body:args[1]?.body?JSON.parse(String(args[1].body)):null})+'\\n');return actual(...args);},{preconnect:actual.preconnect});await runTUIHost({dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',thread:'s',cwd:${JSON.stringify(f.workspace)},artifact:${JSON.stringify(f.artifact)}});`,
    );
    const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(runner)}],stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);full=b'';buffer=b''
def pump():
 global full,buffer
 if select.select([master],[],[],.03)[0]:
  data=os.read(master,65536);full+=data;buffer+=data
def wait(text):
 end=time.monotonic()+10
 while text not in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace'))):
  if time.monotonic()>end:raise RuntimeError('expected '+text+' tail='+buffer[-5000:].decode(errors='replace'))
  pump()
def key(value):
 global buffer
 buffer=b'';os.write(master,value);pump()
try:
 wait('New Run');key(b'Follow after explicit recovery');wait('Follow after explicit recovery');key(b'\\r');wait('approval [');key(b'\\x1b[B');wait('only this call');key(b'\\r');wait('RECOVERED_ORIGINAL_DONE');key(b'\\x11');deadline=time.monotonic()+6
 while p.poll() is None and time.monotonic()<deadline:pump()
 p.wait(timeout=3);assert p.returncode==0;print('ORIGINAL_SESSION_HISTORY_PTY_OK')
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
    if (code !== 0)
      console.error(
        err,
        JSON.stringify({
          runs: f.rows('SELECT id,origin_command_id,status,reason FROM run'),
          executions: f.rows('SELECT id,call_id,kind,state,result_json FROM execution'),
          calls: f.calls(),
        }),
      );
    console.log('original Session PTY transcript', transcript);
    expect(code).toBe(0);
    expect(out).toContain('ORIGINAL_SESSION_HISTORY_PTY_OK');
    expect(f.calls()).toBe(3);
    expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('ORIGINAL_EFFECT_ONCE');
    expect(f.rows(`SELECT state FROM execution WHERE id='${f.card.executionId}'`)).toEqual([
      { state: 'cancelled' },
    ]);
    expect(f.rows('SELECT origin_command_id,status FROM run ORDER BY started_at')).toMatchObject([
      { origin_command_id: 'work', status: 'interrupted' },
      { status: 'completed' },
    ]);
    const rows = readFileSync(network, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      rows.filter((row) => row.method === 'POST' && row.body?.kind === 'run.start'),
    ).toHaveLength(1);
    expect(
      rows.filter((row) => row.method === 'POST' && row.path.includes('/interactions/')),
    ).toHaveLength(1);
  } finally {
    if (python?.exitCode === null) {
      python.kill('SIGKILL');
      await python.exited;
    }
    f.close();
  }
}, 30000);
