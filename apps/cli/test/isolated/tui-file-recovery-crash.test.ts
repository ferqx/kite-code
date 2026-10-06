import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compileFileRecoveryTUI, fileRecoveryProfile } from '../fixtures/file-recovery-profile';

const repo = resolve(import.meta.dir, '../../../..');
for (const window of ['before_post', 'between_legs'] as const)
  test(`80x24 compiled TUI SIGKILL ${window} reopens original journal and cold only GET`, async () => {
    const f = await fileRecoveryProfile();
    try {
      const runner = join(f.root, 'tui.ts'),
        wire = join(f.root, 'wire'),
        marker = join(f.root, 'marker');
      writeFileSync(
        runner,
        `import {appendFileSync,writeFileSync} from 'node:fs';const actual=globalThis.fetch;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const opts=args[1],path=new URL(String(args[0])).pathname,body=opts?.body?JSON.parse(String(opts.body)):null;appendFileSync(${JSON.stringify(wire)},JSON.stringify({method:opts?.method??'GET',path,body})+'\\n');if(process.env.WINDOW==='before_post'&&opts?.method==='POST'&&body?.kind==='extension.invoke'){writeFileSync(${JSON.stringify(marker)},'durable-submitting');await new Promise(()=>{});}return actual(...args);},{preconnect:actual.preconnect});import {runTUIHost} from ${JSON.stringify(join(repo, 'apps/cli/host/tui.tsx'))};await runTUIHost({dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',thread:'s',cwd:${JSON.stringify(f.workspace)},artifact:${JSON.stringify(f.artifact)}});`,
      );
      expect((await compileFileRecoveryTUI(f.root, runner)).success).toBe(true);
      const transcript = `/private/tmp/kite-file-recovery-crash-${randomUUID()}.pty.log`;
      const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct,json
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(join(f.root, 'tui.js'))}],stdin=slave,stdout=slave,stderr=slave,cwd=${JSON.stringify(f.workspace)},env={**os.environ,'HOME':${JSON.stringify(f.home)},'WINDOW':${JSON.stringify(window)}},start_new_session=True);os.close(slave);buffer=b'';full=b''
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
 wait('Session s');key(b'/rewind');wait('/rewind');key(b'\\r');wait('Files recovery:');wait(${JSON.stringify(f.checkpointId.slice(0, 24))});key(b'\\r');wait('preimage');key(b'3');wait('Confirm both');key(b'\\r')
 ${
   window === 'before_post'
     ? `end=time.monotonic()+20
 while not os.path.exists(${JSON.stringify(marker)}):
  if time.monotonic()>end:raise RuntimeError('beforepost marker missing')
  if select.select([master],[],[],.05)[0]:full+=os.read(master,65536)`
     : `wait('pending approval panel');wait('none (Enter has no answer)');key(b'a');wait('none (Enter has no answer)',approval=True);key(b'\\x1b[B');wait('only this call',approval=True);key(b'\\r');wait('restored',material=True);wait('New Run >');key(b'/rewind');wait('/rewind');key(b'\\r');wait('Saved 1:');key(b'l');wait('"phase":"succeeded"},"fork"')`
}
 original=json.load(open(${JSON.stringify(join(f.profile.profilePath, 'ui/file-recovery-intents.json'))}))['records'][0]
 assert original['fork']['phase']=='not_started'
 os.killpg(p.pid,signal.SIGKILL);p.wait();os.close(master)
 before=len(open(${JSON.stringify(wire)}).readlines())
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(join(f.root, 'tui.js'))}],stdin=slave,stdout=slave,stderr=slave,cwd=${JSON.stringify(f.workspace)},env={**os.environ,'HOME':${JSON.stringify(f.home)}},start_new_session=True);os.close(slave);buffer=b''
 wait('Session s');key(b'/rewind');wait('/rewind');key(b'\\r');wait('Saved 1:');key(b'l');wait(${JSON.stringify(window === 'before_post' ? '"phase":"unknown"},"fork"' : '"phase":"succeeded"},"fork"')})
 cold=json.load(open(${JSON.stringify(join(f.profile.profilePath, 'ui/file-recovery-intents.json'))}))['records'][0]
 assert cold['code']['request']==original['code']['request'] and cold['fork']['request']==original['fork']['request'] and cold['fork']['phase']=='not_started'
 rows=[json.loads(line) for line in open(${JSON.stringify(wire)}).readlines()[before:]];assert not any(row['method']=='POST' for row in rows)
 key(b'\\x11');end=time.monotonic()+10
 while p.poll() is None and time.monotonic()<end:
  if select.select([master],[],[],.05)[0]:
   try:full+=os.read(master,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0;print('TUI_ORIGINAL_COLD_ONLY_GET')
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
      if (code !== 0) console.error(err, 'PTY_TRANSCRIPT', transcript);
      expect(code).toBe(0);
      expect(out).toContain('TUI_ORIGINAL_COLD_ONLY_GET');
      expect(readFileSync(f.file, 'utf8')).toBe(
        window === 'before_post' ? 'actual changed bytes\r\n' : 'original bytes\r\n',
      );
      expect(f.calls()).toBe(3);
    } finally {
      f.close();
    }
  }, 80000);
