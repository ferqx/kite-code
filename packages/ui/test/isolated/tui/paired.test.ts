import { expect, test } from 'bun:test';
import { join } from 'node:path';

for (const mode of ['complete', 'cancel', 'eof'] as const) {
  test(`real POSIX PTY ${mode} keeps original paired authority and never guesses approval or completion`, async () => {
    const program = `import os,pty,subprocess,select,time,signal,json,tempfile,codecs
master,slave=pty.openpty()
eof_mode=${mode === 'eof' ? 'True' : 'False'}
temporary=tempfile.TemporaryDirectory(prefix='kite-tui-facts-')
facts=os.path.join(temporary.name,'facts.json')
env=dict(os.environ);env['KITE_TUI_FACTS']=facts
env['KITE_TUI_ROOT']=os.path.join(temporary.name,'runtime');os.mkdir(env['KITE_TUI_ROOT'],0o700)
p=subprocess.Popen(['bun',${JSON.stringify(join(import.meta.dir, 'paired.fixture.tsx'))}],stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True)
os.close(slave)
reader=master
chunks=[]
decoder=codecs.getincrementaldecoder('utf-8')(errors='replace')
matching='';tail='';ansi='text';spaced=False
expected='';found=False
bytes_read=0;reads=0;matching_seconds=0;cursor_up=0;erase_line=0
started=time.monotonic()
def receive(data):
 global matching,tail,ansi,spaced,bytes_read,reads,matching_seconds,cursor_up,erase_line,found
 chunks.append(data);bytes_read+=len(data);reads+=1
 before=time.process_time()
 decoded=decoder.decode(data);tail=(tail+decoded)[-2000:]
 plain=[]
 for char in decoded:
  if ansi=='esc':
   ansi='csi' if char=='[' else 'text'
   if char=='[': continue
  elif ansi=='csi':
   if '@'<=char<='~':
    if char=='A': cursor_up+=1
    if char=='K': erase_line+=1
    ansi='text'
   continue
  if char=='\\x1b': ansi='esc';continue
  if char.isspace():
   if not spaced: plain.append(' ')
   spaced=True
  else: plain.append(char);spaced=False
 next_text=matching+''.join(plain)
 if expected and expected in next_text: found=True
 matching=next_text[-4096:]
 matching_seconds+=time.process_time()-before
def wait(text):
 global expected,found
 expected=text;found=text in matching
 deadline=time.monotonic()+8
 while not found:
  if time.monotonic()>deadline: raise RuntimeError('PTY expected '+text+'; bytes='+str(bytes_read)+'; tail='+tail[-200:])
  if select.select([reader],[],[],.1)[0]:
   try: receive(os.read(reader,65536))
   except OSError: raise RuntimeError('PTY ended '+tail)
try:
 wait('New Run');matching='';os.write(master,b'work');wait('New Run > work');os.write(master,b'\\r');wait('approval [')
 ${mode === 'complete' ? `matching='';os.write(master,b'approve');wait('feedback / deny. approve');os.write(master,b'\\r');wait('Original choice ID');matching='';os.write(master,b'{"choiceId":"internal-choice"}');wait('feedback / deny. {"choiceId":"internal-choice"}');os.write(master,b'\\r');matching='';wait('Original completed Run / complete output preview ready');os.write(master,b'\\x0f');wait('VERIFIED TAIL')` : mode === 'cancel' ? `matching='';os.write(master,b'\\x03');time.sleep(.1);os.write(master,b'\\x03');wait('Idle')` : `os.close(master);master=-1;time.sleep(.3)`}
 os.kill(p.pid,signal.SIGTERM)
 deadline=time.monotonic()+5
 while not eof_mode and p.poll() is None and time.monotonic()<deadline:
  if select.select([reader],[],[],.1)[0]:
   try: receive(os.read(reader,65536))
   except OSError: break
 p.wait(timeout=3)
 print(b''.join(chunks).decode(errors='replace'))
 print('SAFE_FACTS '+open(facts).read())
 print('PTY_METRICS '+json.dumps(dict(bytes=bytes_read,reads=reads,matchingSeconds=matching_seconds,wallSeconds=time.monotonic()-started,cursorUp=cursor_up,eraseLine=erase_line)))
finally:
 if p.poll() is None: os.killpg(p.pid,signal.SIGKILL);p.wait()
 if master>=0: os.close(master)
 temporary.cleanup()
`;
    const child = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0) console.error(err);
    const metrics = out.match(/^PTY_METRICS (.+)$/m)?.[1];
    if (metrics) console.info(`PTY ${mode} ${metrics}`);
    expect(exit).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('SAFE_FACTS');
    if (mode === 'complete') {
      expect(out).toContain('VERIFIED TAIL');
      expect(out).toContain('"effects":1');
      expect(out).toContain('"runs":["completed"]');
      expect(out).toContain('internal-choice');
    } else {
      expect(out).toContain('"effects":0');
      expect(out).toContain(
        mode === 'cancel' ? '"runs":["cancelled"]' : '"runs":["waiting_interaction"]',
      );
      expect(out).toContain(mode === 'cancel' ? '"cancellations":1' : '"inputEnded":true');
    }
  }, 20000);
}
