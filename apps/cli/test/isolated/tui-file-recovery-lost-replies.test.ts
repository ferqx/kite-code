import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compileFileRecoveryTUI, fileRecoveryProfile } from '../fixtures/file-recovery-profile';

const repo = resolve(import.meta.dir, '../../../..');
test('compiled actual TUI lost Code and Fork receipts query only original IDs after independent Ask', async () => {
  const f = await fileRecoveryProfile();
  try {
    const runner = join(f.root, 'tui.ts');
    writeFileSync(
      runner,
      `import {appendFileSync} from 'node:fs';const actual=globalThis.fetch;let saved:string|undefined,lost=false;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const opts=args[1],path=new URL(String(args[0])).pathname,body=opts?.body?JSON.parse(String(opts.body)):null;appendFileSync(${JSON.stringify(join(f.root, 'wire'))},JSON.stringify({method:opts?.method??'GET',path,body})+'\\n');const response=await actual(...args);if(opts?.method==='POST'&&(body?.kind==='extension.invoke'||(path.endsWith('/fork')&&body?.newSessionId))){saved=body.commandId;lost=false;await response.arrayBuffer();throw Error('committed POST response physically lost');}if(saved&&!lost&&path==='/v1/commands/'+saved){lost=true;const text=await response.text();return new Response(text.slice(0,Math.max(1,Math.floor(text.length/2))),{status:response.status,headers:response.headers});}return response;},{preconnect:actual.preconnect});import {runTUIHost} from ${JSON.stringify(join(repo, 'apps/cli/host/tui.tsx'))};await runTUIHost({dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',thread:'s',cwd:${JSON.stringify(f.workspace)},artifact:${JSON.stringify(f.artifact)}});`,
    );
    expect((await compileFileRecoveryTUI(f.root, runner)).success).toBe(true);
    const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct,json
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(join(f.root, 'tui.js'))}],stdin=slave,stdout=slave,stderr=slave,cwd=${JSON.stringify(f.workspace)},env={**os.environ,'HOME':${JSON.stringify(f.home)}},start_new_session=True);os.close(slave);buffer=b'';full=b''
def wait(text):
 global buffer,full
 end=time.monotonic()+20
 while text.replace(' ','') not in re.sub(r'\\s+','',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace'))):
  if time.monotonic()>end:raise RuntimeError('expected '+text+' tail='+buffer[-8000:].decode(errors='replace'))
  if text in [${JSON.stringify(f.checkpointId.slice(0, 24))}] and 'server_reset' in buffer.decode(errors='replace'):
   buffer=b'';os.write(master,b'r')
   if text=='preimage':
    wait(${JSON.stringify(f.checkpointId.slice(0, 24))});key(b'\\r')
  if select.select([master],[],[],.05)[0]:
   chunk=os.read(master,65536);buffer+=chunk;full+=chunk
def key(value):
 global buffer
 buffer=b'';os.write(master,value)
try:
 wait('Session s');key(b'/rewind');wait('/rewind');key(b'\\r');wait('Files recovery:');wait(${JSON.stringify(f.checkpointId.slice(0, 24))});key(b'\\r');wait('preimage');key(b'3');wait('Confirm both');key(b'\\r');wait('pending approval panel');wait('none (Enter has no answer)');key(b'a');wait('none (Enter has no answer)');key(b'\\x1b[B');wait('only this call');key(b'\\r');wait('restored');wait('New Run >');key(b'/rewind');wait('/rewind');key(b'\\r');wait('Saved 1:');key(b'l');wait('"phase":"succeeded"},"fork"');key(b'c');wait('"phase":"unknown"}');key(b'r');
 end=time.monotonic()+20
 while time.monotonic()<end:
  rows=json.load(open(${JSON.stringify(join(f.profile.profilePath, 'ui/file-recovery-intents.json'))}))['records']
  if rows[0]['fork']['phase']=='succeeded':break
  if select.select([master],[],[],.05)[0]:
   chunk=os.read(master,65536);buffer+=chunk;full+=chunk
 else:raise RuntimeError('second leg not succeeded')
 wait(rows[0]['fork']['request']['newSessionId']);key(b'\\x11');
 deadline=time.monotonic()+10
 while p.poll() is None and time.monotonic()<deadline:
  if select.select([master],[],[],.05)[0]:
   try:full+=os.read(master,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0;print('FILE_BOTH_ORIGINAL_CONFIRMED')
finally:
 open(${JSON.stringify(join(f.root, 'pty-output'))},'wb').write(full)
 if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(master)
`;
    const python = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
    const [code, out, err] = await Promise.all([
      python.exited,
      new Response(python.stdout).text(),
      new Response(python.stderr).text(),
    ]);
    if (code !== 0) {
      console.error(err);
      console.error(readFileSync(join(f.root, 'wire'), 'utf8'));
    }
    expect(code).toBe(0);
    expect(out).toContain('FILE_BOTH_ORIGINAL_CONFIRMED');
    expect(readFileSync(f.file, 'utf8')).toBe('original bytes\r\n');
    expect(f.calls()).toBe(3);
    const journal = JSON.parse(
      readFileSync(join(f.profile.profilePath, 'ui/file-recovery-intents.json'), 'utf8'),
    );
    expect(journal.records).toHaveLength(1);
    expect(journal.records[0].code.phase).toBe('succeeded');
    expect(journal.records[0].fork.phase).toBe('succeeded');
    const wires = readFileSync(join(f.root, 'wire'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const codePosts = wires.filter(
      (r) => r.method === 'POST' && r.body?.kind === 'extension.invoke',
    );
    const forkPosts = wires.filter((r) => r.method === 'POST' && r.body?.newSessionId);
    expect(codePosts).toHaveLength(1);
    expect(forkPosts).toHaveLength(1);
    expect(codePosts[0].body.commandId).toBe(journal.records[0].code.request.commandId);
    expect(forkPosts[0].body.commandId).toBe(journal.records[0].fork.request.commandId);
  } finally {
    f.close();
  }
}, 70000);
