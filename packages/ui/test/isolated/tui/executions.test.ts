import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('actual 80x24 original Job stop, complete paged output and completed-parent child logs stay independent', async () => {
  const program = `import os,pty,subprocess,select,time,signal,json,re,tempfile,fcntl,termios,struct,shutil
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));temporary=tempfile.TemporaryDirectory(prefix='kite-job-reader-');root=os.path.join(temporary.name,'runtime');os.mkdir(root,0o700);statefile=os.path.join(temporary.name,'state.json');facts=os.path.join(temporary.name,'facts.json');wire=os.path.join(temporary.name,'wire.jsonl');env=dict(os.environ);env.update(KITE_TUI_ROOT=root,KITE_TUI_STATE=statefile,KITE_TUI_FACTS=facts,KITE_TUI_WIRE=wire)
p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(join(import.meta.dir, 'executions.fixture.tsx'))}],stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave);buffer=b'';full=b''
def pump():
 global buffer,full
 if select.select([master],[],[],.05)[0]:
  try:data=os.read(master,65536);buffer+=data;full+=data
  except OSError:pass
def state():
 try:return json.load(open(statefile))
 except:return {}
def waitfor(condition,label):
 deadline=time.monotonic()+8
 while not condition():
  if time.monotonic()>deadline:raise RuntimeError('expected '+label+' state='+json.dumps({k:state().get(k) for k in ['sessionId','observation','childCalls','effects','outputProduced','starts','stops','jobStops','scopeProof']})+' read='+json.dumps({k:state().get('read',{}).get(k) for k in ['phase','error','target']})+' tail='+buffer[-3000:].decode(errors='replace'))
  pump()
def visible(text):return text in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace')))
def wait_selection(current,target):
 begin=(chr(27)+'[?2026h').encode();end=(chr(27)+'[?2026l').encode()
 def selected():
  start=buffer.rfind(begin);finish=buffer.find(end,start+len(begin)) if start>=0 else -1
  if finish<0:return False
  frame=buffer[start+len(begin):finish].decode(errors='replace')
  lines=re.sub(chr(27)+r'\\[[0-?]*[ -/]*[@-~]','',frame).splitlines()
  return any(line.startswith('Session '+current+' · ') for line in lines) and 'Select Session (arrows/Enter, Esc)' in lines and '> '+target in lines
 waitfor(selected,'current Session '+current+' chooser target '+target)
 print('EXECUTION_SELECTION_FRAME '+current+' -> '+target,flush=True)
def key(data):
 global buffer
 buffer=b'';os.write(master,data);end=time.monotonic()+.12
 while time.monotonic()<end:pump()
def last_frame_lines():
 begin=(chr(27)+'[?2026h').encode();end=(chr(27)+'[?2026l').encode()
 start=buffer.rfind(begin);finish=buffer.find(end,start+len(begin)) if start>=0 else -1
 if finish<0:return []
 return re.sub(chr(27)+r'\\[[0-?]*[ -/]*[@-~]','',buffer[start+len(begin):finish].decode(errors='replace')).splitlines()
def stop_confirmation(job,present):
 lines=last_frame_lines()
 target='› '+job['definitionId']+' ['+job['id']+'] '
 confirmation='Confirm stop original Job ['+job['id']+']'
 return state().get('panel')=='executions' and state().get('sessionId')=='a' and 'Original background Jobs · Session a' in lines and any(line.startswith(target) for line in lines) and any(line.startswith(confirmation) for line in lines)==present
def input_phase(name):
 value=state();lines=last_frame_lines()
 print('EXECUTION_INPUT_PHASE '+json.dumps({'phase':name,'monotonicMs':round(time.monotonic()*1000),'panel':value.get('panel'),'readPhase':value.get('read',{}).get('phase'),'mainPrompt':any(line.startswith('New Run >') for line in lines),'backgroundTitle':any(line.startswith('Original background Jobs') for line in lines)}),flush=True)
def main_ready():
 lines=last_frame_lines()
 return state().get('panel') is None and any(line.startswith('Session a · ') for line in lines) and any(line.startswith('New Run >') for line in lines)
def mark(name):open(os.path.join(root,name),'w').write('explicit owned fixture operation')
def posts():return [json.loads(line) for line in open(wire) if json.loads(line)['method']=='POST']
def route(text):key(text.encode());key(b'\\r')
def reopen():route('/background');waitfor(lambda:visible('Original background Jobs'),'background panel')
def pick(id):
 jobs=state()['panelJobs'];index=next(i for i,j in enumerate(jobs) if j['id']==id)
 for _ in range(5):key(b'\\x1b[A')
 for _ in range(index):key(b'\\x1b[B')
try:
 waitfor(lambda:visible('New Run'),'ready');route('work');waitfor(lambda:any(r['status']=='completed' for r in state().get('runs',[])),'actual parent done');waitfor(lambda:all(state().get('outputProduced',{}).get(id) for id in ['long-one','long-two']),'actual both output producers persisted')
 jobs=state()['jobs'];one=next(j for j in jobs if j['definitionId']=='long-one');two=next(j for j in jobs if j['definitionId']=='long-two');child=next(j for j in jobs if j.get('childSessionId'));assert one['id']!=two['id'];assert one['status']=='running' and two['status']=='running';assert child['status'] in ['running','succeeded'];assert len(posts())==1
 reopen();pick(one['id']);mark('hold-output');key(b'o');waitfor(lambda:os.path.exists(os.path.join(root,'output-held')),'actual first output page received');key(b'\\x03');key(b'\\x12');waitfor(lambda:visible('Other original root'),'Session chooser');wait_selection('a','PTY original [a]');key(b'\\x1b[B');wait_selection('a','Other original root [b]');key(b'\\r');waitfor(lambda:state().get('sessionId')=='b','explicit other scope');mark('release-output');time.sleep(.2);assert len(posts())==1;assert state().get('read') is None
 key(b'\\x12');wait_selection('b','Other original root [b]');key(b'\\x1b[A');wait_selection('b','PTY original [a]');key(b'\\r');waitfor(lambda:state().get('sessionId')=='a','return original scope');reopen();pick(one['id']);key(b'o');waitfor(lambda:state().get('read',{}).get('phase')=='ready' and state()['read']['target']['executionId']==one['id'],'one complete original output');assert len(state()['read']['output']['items'])==223;assert state()['read']['output']['highWaterSeq']=='223';assert any(item['droppedBytes']=='17' and item['content']=='' for item in state()['read']['output']['items']);assert any('AFTER_GAP_ORIGINAL_long-one' in item['content'] for item in state()['read']['output']['items'])
 pick(two['id']);key(b'o');waitfor(lambda:state().get('read',{}).get('phase')=='ready' and state()['read']['target']['executionId']==two['id'],'two distinct complete output');assert all('long-one' not in item['content'] for item in state()['read']['output']['items']);assert len(posts())==1
 waitfor(lambda:state().get('childCalls')==3 and state().get('effects')==200 and next(j for j in state()['jobs'] if j['id']==child['id'])['status']=='succeeded','original child completed after parent');pick(child['id']);key(b'c');waitfor(lambda:state().get('read',{}).get('phase')=='ready' and 'child' in state()['read'],'actual child full history');assert len(state()['read']['child']['messages'])>200;waitfor(lambda:'CHILD_MODEL_FULL_TAIL' in re.sub(r'\\s+','',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',full.decode(errors='replace'))),'full recorded original Model tail');assert len(posts())==1;assert 'step-200' in full.decode(errors='replace')
 mark('break-observer');waitfor(lambda:state().get('observation')=='unknown','real observer closed');pick(one['id']);key(b's');key(b'\\r');assert len(posts())==1;assert state().get('stops',{})=={}
 mark('resume-observer');waitfor(lambda:state().get('observation')=='ready','actual observer re-admitted');key(b's');key(b'\\r');waitfor(lambda:state().get('jobStops') and state()['jobStops'][0]['phase']=='unknown','stop receipt physically lost');waitfor(lambda:next(j for j in state()['jobs'] if j['id']==one['id'])['status']=='cancelled','actual selected Job cleaned');assert next(j for j in state()['jobs'] if j['id']==two['id'])['status']=='running';assert len(posts())==2
 pick(two['id']);key(b's');waitfor(lambda:stop_confirmation(two,True),'second original Job stop confirmation shown');input_phase('second_stop_confirmation_shown');key(b'\\r');waitfor(lambda:stop_confirmation(two,False),'second original Job stop confirmation consumed');input_phase('second_stop_confirmation_consumed');assert len(posts())==2;input_phase('before_stop_reader_close');key(b'\\x03');waitfor(main_ready,'closed stop reader and current main input');input_phase('stop_reader_closed');reopen();input_phase('stop_reader_reopened');key(b'\\x0c');waitfor(lambda:state()['jobStops'][0]['phase']=='unknown','first original GET response lost');key(b'\\x0c');waitfor(lambda:state()['jobStops'][0]['phase']=='applied','original stop receipt recovered');assert len(posts())==2
 mark('release-jobs');waitfor(lambda:next(j for j in state()['jobs'] if j['id']==two['id'])['status']=='succeeded','other Job original success');assert len(posts())==2
 os.kill(p.pid,signal.SIGTERM);deadline=time.monotonic()+5
 while p.poll() is None and time.monotonic()<deadline:pump()
 p.wait(timeout=3);assert p.returncode==0
 shutil.copyfile(facts,temporary.name+'-facts.json');shutil.copyfile(wire,temporary.name+'-wire.jsonl');open(temporary.name+'-pty.log','wb').write(full)
 print('SAFE_FACTS '+open(facts).read());print('WIRE_FACTS '+json.dumps([json.loads(line) for line in open(wire)]));print('PROOF_PATH '+temporary.name)
except BaseException:
 open(temporary.name+'-pty.log','wb').write(full)
 if os.path.exists(statefile):shutil.copyfile(statefile,temporary.name+'-failure-state.json')
 print('FAILURE_PROOF_PATH '+temporary.name,flush=True)
 raise
finally:
 if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(master);temporary.cleanup()
`;
  const processChild = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, exit] = await Promise.all([
    new Response(processChild.stdout).text(),
    new Response(processChild.stderr).text(),
    processChild.exited,
  ]);
  if (exit) console.error(err, out);
  expect(exit).toBe(0);
  expect(err).toBe('');
  const facts = JSON.parse(out.split('SAFE_FACTS ')[1]!.split('\n')[0]!);
  const wire = JSON.parse(out.split('WIRE_FACTS ')[1]!.split('\n')[0]!) as {
    method: string;
    path: string;
    body?: { kind?: string; executionId?: string; commandId?: string; expectedStoreId?: string };
  }[];
  console.log(out.split('PROOF_PATH ')[1]!.trim());
  expect(facts.starts).toEqual({ 'long-one': 1, 'long-two': 1 });
  expect(facts.stops).toEqual({ 'long-one': 1 });
  expect(facts.stopPosts).toBe(1);
  expect(facts.stopGets).toBe(2);
  expect(facts.modelCalls).toBe(2);
  expect(facts.childCalls).toBe(3);
  expect(facts.effects).toBe(200);
  expect(facts.cancellations).toBe(0);
  expect(facts.runs).toEqual(['completed']);
  expect(facts.childRuns).toEqual(['completed']);
  const one = facts.originalJobs.find(
      (job: { definitionId: string }) => job.definitionId === 'long-one',
    ),
    two = facts.originalJobs.find(
      (job: { definitionId: string }) => job.definitionId === 'long-two',
    );
  expect(one.status).toBe('cancelled');
  expect(two.status).toBe('succeeded');
  expect(two.cancelRequestedAt).toBeNull();
  const stops = wire.filter(
    (row) => row.method === 'POST' && row.body?.kind === 'execution.cancel',
  );
  expect(stops).toHaveLength(1);
  expect(stops[0]!.body!.executionId).toBe(one.id);
  expect(stops[0]!.path).toBe('/v1/sessions/a/commands');
  const gets = wire.filter(
    (row) => row.method === 'GET' && row.path.endsWith('/commands/' + facts.lostStop),
  );
  expect(gets).toHaveLength(2);
  expect(new Set(gets.map((row) => row.path)).size).toBe(1);
  const reads = facts.readFacts.filter((read: { kind: string }) => read.kind === 'output');
  expect(reads).toHaveLength(2);
  for (const read of reads) {
    expect(read.output.items).toHaveLength(223);
    expect(read.output.highWaterSeq).toBe('223');
    expect(
      read.output.items.filter((item: { droppedBytes: string }) => item.droppedBytes === '17'),
    ).toHaveLength(1);
    expect(read.output.items.at(-1).content).toContain('AFTER_GAP_ORIGINAL_');
    expect(
      read.output.items
        .slice(0, 220)
        .every((item: { content: string }) => item.content.includes('原UTF8🙂e\u0301正文')),
    ).toBe(true);
  }
  const child = facts.readFacts.find((read: { kind: string }) => read.kind === 'child');
  expect(child.messageCount).toBeGreaterThan(200);
  expect(child.outputBodyCount).toBe(1);
  expect(child.fullBodies).toHaveLength(child.outputBodyCount);
  expect(child.fullBodies.at(-1).content).toBe(facts.childBody);
  expect(child.fullBodies.at(-1).complete).toBe(true);
  expect(child.fullBodies.at(-1).contentBytes).toBe(String(Buffer.byteLength(facts.childBody)));
}, 30000);
