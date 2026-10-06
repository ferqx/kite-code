import { expect, test } from 'bun:test';
import { join } from 'node:path';

for (const mode of ['complete', 'eof'] as readonly string[]) {
  test(`real child POSIX PTY ${mode} answers original child through presentation root without borrowing authority`, async () => {
    const program = `import os,pty,subprocess,select,time,signal,json,re,tempfile,fcntl,termios,struct,codecs
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
eof_mode=${mode === 'eof' ? 'True' : 'False'}
temporary=tempfile.TemporaryDirectory(prefix='kite-tui-facts-')
facts=os.path.join(temporary.name,'facts.json')
env=dict(os.environ);env['KITE_TUI_FACTS']=facts
env['KITE_TUI_ROOT']=os.path.join(temporary.name,'runtime');os.mkdir(env['KITE_TUI_ROOT'],0o700)
p=subprocess.Popen(['bun',${JSON.stringify(join(import.meta.dir, 'child-permissions.fixture.tsx'))}],stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True)
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
def current_frame():
 raw=b''.join(chunks).decode(errors='replace');frames=re.findall(r'\\x1b\\[\\?2026h(.*?)\\x1b\\[\\?2026l',raw,re.S)
 return re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',frames[-1] if frames else raw))
def wait(text,ready=False):
 global expected,found
 expected=text;found=text in matching
 deadline=time.monotonic()+8
 while not found or (ready and (text not in current_frame() or ' · Loading' in current_frame())):
  if time.monotonic()>deadline: raise RuntimeError('PTY expected '+text+'; bytes='+str(bytes_read)+'; tail='+tail[-200:])
  if select.select([reader],[],[],.1)[0]:
   try: receive(os.read(reader,65536))
   except OSError: raise RuntimeError('PTY ended '+tail)
try:
 wait('New Run');matching='';os.write(master,b'work');wait('New Run > work');matching='';os.write(master,b'\\r');wait('approval [')
 ${mode === 'complete' ? `matching='';os.write(master,b'approve');wait('feedback / deny. approve');matching='';os.write(master,b'\\r');wait('Original choice ID');matching='';os.write(master,b'\\x1b[B');wait('Question 1/1 · Selection: 1',ready=True);matching='';os.write(master,b'\\r');wait('Original completed Run / complete output preview ready');matching='';os.write(master,b'\\x0f');wait('VERIFIED TAIL')` : mode === 'cancel' ? `matching='';os.write(master,b'\\x03');time.sleep(.1);os.write(master,b'\\x03');wait('Idle')` : `os.close(master);master=-1;time.sleep(.3)`}
 os.kill(p.pid,signal.SIGTERM)
 deadline=time.monotonic()+5
 while not eof_mode and p.poll() is None and time.monotonic()<deadline:
  if select.select([reader],[],[],.1)[0]:
   try: receive(os.read(reader,65536))
   except OSError: break
 p.wait(timeout=3)
 print(b''.join(chunks).decode(errors='replace'))
 print('SAFE_FACTS '+open(facts).read())
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
    expect(exit).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('SAFE_FACTS');
    if (mode === 'complete') {
      expect(out).toContain('VERIFIED TAIL');
      expect(out).toContain('"effects":1');
      expect(out).toContain('"runs":["completed"]');
      expect(out).toContain('internal-choice');
      const facts = JSON.parse(out.split('SAFE_FACTS ').at(-1)!.trim());
      expect(facts.fullOutputExact).toBe(true);
      expect(facts.fullOutputBytes).toBeGreaterThan(100000);
      expect(facts.childCalls).toBe(2);
      expect(facts.interactions).toHaveLength(2);
      for (const card of facts.interactions) {
        expect(card.sessionId).not.toBe('a');
        expect(card.presentationSessionId).toBe('a');
      }
      expect(facts.interactions[0].answer.grant).toBe('approve_once');
      expect(
        facts.interactions.find((card: { kind: string }) => card.kind === 'question').answer,
      ).toEqual({ kind: 'question', answers: { choiceId: 'internal-choice' } });
    } else {
      expect(out).toContain('"effects":0');
      expect(out).toContain(mode === 'cancel' ? '"runs":["cancelled"]' : '"runs":["running"]');
      expect(out).toContain(mode === 'cancel' ? '"cancellations":1' : '"inputEnded":true');
      expect(out).toContain('"childRuns":["waiting_interaction"]');
      expect(out).toContain('"rootWaitingOnChild":true');
    }
  }, 20000);
}
