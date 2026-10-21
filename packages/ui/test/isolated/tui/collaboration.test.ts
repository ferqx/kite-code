import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('actual 80x24 six-tool children keep parent input, exact approvals, stable follow-up and exact stop', async () => {
  const program = `import os,pty,subprocess,select,time,signal,json,re,tempfile,fcntl,termios,struct
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
temporary=tempfile.TemporaryDirectory(prefix='kite-tui-collaboration-');root=os.path.join(temporary.name,'runtime');os.mkdir(root,0o700);statefile=os.path.join(temporary.name,'state.json')
env=dict(os.environ);env.update(KITE_TUI_ROOT=root,KITE_TUI_STATE=statefile)
p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(join(import.meta.dir, 'collaboration.fixture.tsx'))}],stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave);buffer=b''
def pump():
 global buffer
 if select.select([master],[],[],.02)[0]:
  try:buffer+=os.read(master,65536)
  except OSError:pass
def state():
 try:return json.load(open(statefile))
 except:return {}
def frame():
 raw=buffer.decode(errors='replace');frames=re.findall(r'\\x1b\\[\\?2026h(.*?)\\x1b\\[\\?2026l',raw,re.S)
 return re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',frames[-1] if frames else raw)
def visible(text):return text in re.sub(r'\\s+',' ',frame())
def waitfor(test,label):
 end=time.monotonic()+8
 while not test():
  if time.monotonic()>end:raise RuntimeError(label+' state='+json.dumps(state())+' tail='+buffer[-4000:].decode(errors='replace'))
  pump()
def key(data):
 global buffer
 buffer=b'';os.write(master,data);end=time.monotonic()+.08
 while time.monotonic()<end:pump()
def send(text):key(text.encode());key(b'\\r')
def pending():return [c for c in state().get('interactions',[]) if c['state']=='pending']
def choose(id):
 cards=state()['snapshot'];index=next(i for i,c in enumerate(cards) if c['id']==id)
 key(b'\\x02');waitfor(lambda:visible('Pending cards'),'card chooser')
 for _ in range(len(cards)):key(b'\\x1b[A')
 for _ in range(index):key(b'\\x1b[B')
 key(b'\\r');waitfor(lambda:visible('approval ['+id+']'),'exact original approval')
def return_parent():key(b'\\x02');key(b'\\x1b');waitfor(lambda:visible('New Run >'),'parent composer returned')
try:
 waitfor(lambda:visible('New Run >'),'actual ordinary composer');send('six start')
 waitfor(lambda:len(pending())==2 and not any(r['isActive'] for r in state()['runs']),'ordinary parent ended with both children pending')
 s=state();a=next(c for c in s['carriers'] if c['input']['content']=='CHILD_A');b=next(c for c in s['carriers'] if c['input']['content']=='CHILD_B');old=next(c for c in pending() if c['sessionId']==a['childSessionId'])
 waitfor(lambda:visible('New Run >'),'child pending preserves parent input');assert s['effects']==[]
 choose(old['id']);waitfor(lambda:visible('Allow once'),'original A approve option');key(b'\\r')
 waitfor(lambda:state()['effects']==['A'],'only exact A effect');waitfor(lambda:next(c for c in state()['carriers'] if c['id']==a['id'])['status']=='succeeded','A carrier settled')
 return_parent();send('补充：six follow')
 waitfor(lambda:any(c['sessionId']==a['childSessionId'] and c['id']!=old['id'] for c in pending()),'same child new approval')
 new=next(c for c in pending() if c['sessionId']==a['childSessionId']);assert new['runId']!=old['runId'];assert new['executionId']!=old['executionId']
 assert all(c['id']!=old['id'] for c in state()['snapshot'])
 return_parent();send('/background');waitfor(lambda:state().get('panel')=='executions','old carrier directory')
 jobs=state()['jobs'];index=next(i for i,c in enumerate(jobs) if c['id']==a['id'])
 for _ in range(len(jobs)):key(b'\\x1b[A')
 for _ in range(index):key(b'\\x1b[B')
 key(b's');assert not visible('Confirm stop original Job');assert any(c['id']==new['id'] for c in pending());assert state()['effects']==['A']
 key(b'\\x03');waitfor(lambda:state().get('panel') is None,'close old carrier without retargeting');choose(new['id']);key(b'\\r');waitfor(lambda:state()['effects']==['A','A2'],'new exact A approval');return_parent()
 send('/background');waitfor(lambda:state().get('panel')=='executions','actual background directory')
 jobs=state()['jobs'];index=next(i for i,c in enumerate(jobs) if c['id']==b['id'])
 for _ in range(len(jobs)):key(b'\\x1b[A')
 for _ in range(index):key(b'\\x1b[B')
 key(b's');waitfor(lambda:visible('Confirm stop original Job ['+b['id']+']'),'accurate B stop confirmation');key(b'\\r')
 waitfor(lambda:next(c for c in state()['carriers'] if c['id']==b['id'])['status']=='cancelled','accurate B cancelled')
 assert state()['effects']==['A','A2'];assert not next(c for c in state()['carriers'] if c['id']==a['id'])['cancelRequestedAt']
 print('SIX_TOOL_PTY_FACTS '+json.dumps({'sameSession':a['childSessionId']==new['sessionId'],'oldRun':old['runId'],'newRun':new['runId'],'effects':state()['effects'],'stopped':b['id']}))
 os.kill(p.pid,signal.SIGTERM)
 end=time.monotonic()+5
 while p.poll() is None and time.monotonic()<end:pump()
 p.wait(timeout=3);assert p.returncode==0
finally:
 if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(master);temporary.cleanup()
`;
  const child = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) console.error(err);
  expect(code).toBe(0);
  expect(err).toBe('');
  const facts = JSON.parse(out.split('SIX_TOOL_PTY_FACTS ')[1]!.trim());
  expect(facts.sameSession).toBe(true);
  expect(facts.oldRun).not.toBe(facts.newRun);
  expect(facts.effects).toEqual(['A', 'A2']);
}, 30000);
