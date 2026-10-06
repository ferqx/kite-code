import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compileFileRecoveryTUI, fileRecoveryProfile } from '../fixtures/file-recovery-profile';

const repo = resolve(import.meta.dir, '../../../..');
for (const scope of ['session', 'code'] as const)
  test(`compiled actual TUI ${scope}-only preserves the other recovery scope`, async () => {
    const f = await fileRecoveryProfile();
    try {
      const runner = join(f.root, 'tui.ts');
      writeFileSync(
        runner,
        `import {appendFileSync} from 'node:fs';const actual=globalThis.fetch;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const opts=args[1];appendFileSync(${JSON.stringify(join(f.root, 'wire'))},JSON.stringify({method:opts?.method??'GET',path:new URL(String(args[0])).pathname})+'\\n');const start=Date.now();try{const response=await actual(...args);appendFileSync(${JSON.stringify(join(f.root, 'wire'))},JSON.stringify({done:true,status:response.status,path:new URL(String(args[0])).pathname,ms:Date.now()-start})+'\\n');return response;}catch(error){appendFileSync(${JSON.stringify(join(f.root, 'wire'))},JSON.stringify({failed:String(error),path:new URL(String(args[0])).pathname})+'\\n');throw error;}},{preconnect:actual.preconnect});import {runTUIHost} from ${JSON.stringify(join(repo, 'apps/cli/host/tui.tsx'))};await runTUIHost({dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',thread:'s',cwd:${JSON.stringify(f.workspace)},artifact:${JSON.stringify(f.artifact)}});`,
      );
      expect((await compileFileRecoveryTUI(f.root, runner)).success).toBe(true);
      const transcript = `/private/tmp/kite-file-recovery-scopes-${randomUUID()}.pty.log`;
      const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct,json
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(join(f.root, 'tui.js'))}],stdin=slave,stdout=slave,stderr=slave,cwd=${JSON.stringify(f.workspace)},env={**os.environ,'HOME':${JSON.stringify(f.home)}},start_new_session=True);os.close(slave);buffer=b'';full=b''
def current_frame():
 text=buffer.decode(errors='replace');frames=re.findall(r'\\x1b\\[\\?2026h(.*?)\\x1b\\[\\?2026l',text,re.S)
 return frames[-1] if frames else text
def wait(text,approval=False,material=False):
 global buffer,full
 end=time.monotonic()+20
 while text.replace(' ','') not in re.sub(r'\\s+','',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',full.decode(errors='replace') if material else current_frame())) or (approval and 'Files recovery:' in current_frame()):
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
 wait('Session s');key(b'/rewind');wait('/rewind');key(b'\\r');wait('Files recovery:');wait(${JSON.stringify(f.checkpointId.slice(0, 24))});key(b'\\r');wait('preimage');${scope === 'session' ? "key(b'1');wait('Confirm session');key(b'\\r');" : "key(b'2');wait('Confirm code');key(b'\\r');wait('pending approval panel');wait('none (Enter has no answer)');key(b'a');wait('none (Enter has no answer)',approval=True);key(b'\\x1b[B');wait('only this call',approval=True);key(b'\\r');wait('restored',material=True);wait('New Run >');key(b'/rewind');wait('/rewind');key(b'\\r');wait('Saved 1:');key(b'l');wait('\"phase\":\"succeeded\"},\"fork\":null');"}
 end=time.monotonic()+20
 while time.monotonic()<end:
  if not os.path.exists(${JSON.stringify(join(f.profile.profilePath, 'ui/file-recovery-intents.json'))}):
   if select.select([master],[],[],.05)[0]:
    chunk=os.read(master,65536);buffer+=chunk;full+=chunk
   continue
  rows=json.load(open(${JSON.stringify(join(f.profile.profilePath, 'ui/file-recovery-intents.json'))}))['records']
  if rows[0][${JSON.stringify(scope === 'session' ? 'fork' : 'code')}]['phase']=='succeeded':break
  if select.select([master],[],[],.05)[0]:
   chunk=os.read(master,65536);buffer+=chunk;full+=chunk
 else:raise RuntimeError('second leg not succeeded')
 ${scope === 'session' ? "wait(rows[0]['fork']['request']['newSessionId']);" : "wait('Session s');"}key(b'\\x11');
 deadline=time.monotonic()+10
 while p.poll() is None and time.monotonic()<deadline:
  if select.select([master],[],[],.05)[0]:
   try:full+=os.read(master,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0;print('FILE_BOTH_ORIGINAL_CONFIRMED')
finally:
 open(${JSON.stringify(transcript)},'wb').write(full)
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
        console.error('PTY_TRANSCRIPT', transcript);
        console.error(readFileSync(join(f.root, 'wire'), 'utf8'));
      }
      expect(code).toBe(0);
      expect(out).toContain('FILE_BOTH_ORIGINAL_CONFIRMED');
      expect(readFileSync(f.file, 'utf8')).toBe(
        scope === 'code' ? 'original bytes\r\n' : 'actual changed bytes\r\n',
      );
      expect(f.calls()).toBe(3);
      const journal = JSON.parse(
        readFileSync(join(f.profile.profilePath, 'ui/file-recovery-intents.json'), 'utf8'),
      );
      expect(journal.records).toHaveLength(1);
      expect(journal.records[0][scope === 'session' ? 'fork' : 'code'].phase).toBe('succeeded');
      expect(journal.records[0][scope === 'session' ? 'code' : 'fork']).toBeNull();
    } finally {
      f.close();
    }
  }, 70000);
