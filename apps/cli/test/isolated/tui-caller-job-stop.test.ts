import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { callerJobProfile } from '../fixtures/caller-job-profile';

const repo = resolve(import.meta.dir, '../../../..');
(process.platform === 'darwin' ? test : test.skip)(
  '80x24 actual independent Shell Job stop survives caller SIGKILL; original cancel GET loss never stops sibling or repeats POST',
  async () => {
    const f = await callerJobProfile(),
      base = `${f.root}-job-stop`,
      journal = join(f.profile.profilePath, 'ui/caller-intents.json'),
      wire = `${base}.wire.jsonl`,
      marker = `${base}.killed`,
      getLost = `${base}.get-lost`,
      runner = join(f.root, 'runner.tsx');
    let python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    const source = (cold: boolean) =>
      `import{appendFileSync,readFileSync,writeFileSync}from'node:fs';import{createServer}from'node:http';import{createClient}from'@kite-ai/client';import{acquireProfileAccess,acquireProfileDataLock}from'@kite-ai/agent/profile-access';import{render}from'ink';import{TuiController,TuiSession}from'@kite-ai/ui/tui';import{openCallerJournal}from${JSON.stringify(join(repo, 'apps/cli/host/caller-journal.ts'))};import{createTuiCallerPort}from${JSON.stringify(join(repo, 'apps/cli/host/caller-port.ts'))};import{openTuiDraftFile}from${JSON.stringify(join(repo, 'apps/cli/host/tui-drafts.ts'))};import{createTuiDraftPort}from${JSON.stringify(join(repo, 'apps/cli/host/tui-draft-port.ts'))};const actual=fetch;let forwarding='',dropPost=${!cold},dropGet=${cold};const relay=createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;const headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(v&&!['host','connection','content-length'].includes(k))headers.set(k,Array.isArray(v)?v.join(','):v);const response=await actual(forwarding,{method:req.method,headers,...(req.method==='POST'?{body}:{})}),json=await response.json();appendFileSync(${JSON.stringify(wire)},JSON.stringify({event:'physical_loss',method:req.method,response:json})+'\\n');res.socket!.destroy();if(req.method==='POST'){writeFileSync(${JSON.stringify(marker)},'actual original execution.cancel response lost');process.kill(process.pid,'SIGKILL');}else writeFileSync(${JSON.stringify(getLost)},'original get lost');});await new Promise<void>(r=>relay.listen(0,'127.0.0.1',r));const addr=relay.address()as{port:number};globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const method=args[1]?.method??'GET',url=new URL(String(args[0]));appendFileSync(${JSON.stringify(wire)},JSON.stringify({cold:${cold},method,path:url.pathname,body:args[1]?.body?JSON.parse(String(args[1].body)):null})+'\\n');if(method==='POST'&&dropPost){dropPost=false;writeFileSync(${JSON.stringify(`${base}.prepared.json`)},readFileSync(${JSON.stringify(journal)}));forwarding=url.href;return actual('http://127.0.0.1:'+addr.port+url.pathname,args[1]);}if(method==='GET'&&url.pathname.startsWith('/v1/commands/')&&dropGet){dropGet=false;forwarding=url.href;return actual('http://127.0.0.1:'+addr.port+url.pathname,args[1]);}return actual(...args);},{preconnect:actual.preconnect});const client=createClient({endpoint:${JSON.stringify(f.endpoint)},token:process.env.KITE_CALLER_TEST_TOKEN!,expected:{profile:${JSON.stringify(f.serviceProfile)},apiMajor:1,requiredCapabilities:['commands','sessions']}});await client.connect();const access=acquireProfileAccess({dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned'}),lock=()=>acquireProfileDataLock(access,'tui_private'),j=openCallerJournal({access,acquireWriteLock:lock}),draft=createTuiDraftPort({file:openTuiDraftFile({access,acquireWriteLock:lock}),notify:code=>{throw Error(code)},association:async()=> 'current'}),callers=createTuiCallerPort({client,storeId:${JSON.stringify(f.storeId)},journal:j,drafts:draft.port});const c=new TuiController({storeId:${JSON.stringify(f.storeId)},nextCommandId:()=>crypto.randomUUID(),drafts:draft.port,callers,listSessions:async()=>[{id:'s',title:'Jobs'}],readSession:async(id,signal)=>({storeId:${JSON.stringify(f.storeId)},view:await client.getView(id,{signal}),messages:await client.listMessages(id,{signal}),interactions:[]}),submit:(id,r)=>r.kind==='run.start'?client.startRun(id,r):r.kind==='input.steer'?client.steer(id,r):client.followUp(id,r),answer:(id,card,r)=>client.answerInteraction(id,card,r),cancel:(id,r)=>client.cancelCommand(id,r),getCommand:(id)=>client.getCommand(id),executions:{getExecution:(id,signal)=>client.getExecution(id,{signal}),output:(id,q,signal)=>client.listExecutionOutput(id,{...q,signal}),getView:(id,signal)=>client.getView(id,{signal}),messages:(id,q,signal)=>client.listMessages(id,{...q,signal}),modelOutput:(id,e,signal)=>client.getModelOutput(id,e,{expectedStoreId:${JSON.stringify(f.storeId)},signal}),stop:(id,r)=>client.cancelExecution(id,r),getCommand:(id,signal)=>client.getCommand(id,{signal})}});await c.restoreCallers();await c.select('s');const ui=render(<TuiSession controller={c}/>,{exitOnCtrlC:false});process.stdin.on('data',(b)=>{if(b.toString().includes('\\u0011')){c.dispose();ui.unmount();draft.close();j.close();access.lock.release();client.disposeNetwork();relay.close();process.stdin.pause();}});await ui.waitUntilExit();`;
    const driver = (
      cold: boolean,
    ) => `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct
m,s=pty.openpty();fcntl.ioctl(s,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(runner)}],stdin=s,stdout=s,stderr=s,start_new_session=True);os.close(s);buf=b'';full=b''
def pump():
 global buf,full
 end=time.monotonic()+.1
 while time.monotonic()<end:
  if select.select([m],[],[],.02)[0]:
   try:v=os.read(m,65536)
   except OSError:return
   buf+=v;full+=v
def key(v):
 global buf
 buf=b'';os.write(m,v);pump()
def wait(t):
 end=time.monotonic()+10
 while t not in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buf.decode(errors='replace'))):
  if time.monotonic()>end:raise RuntimeError(t+' '+buf[-4000:].decode(errors='replace'))
  pump()
try:
 wait('Session s')
 ${
   cold
     ? `key(b'/recovery');key(b'\\r');wait('execution.cancel');key(b'\\x0c');end=time.monotonic()+5
 while not os.path.exists(${JSON.stringify(getLost)}):
  if time.monotonic()>end:raise RuntimeError('GET loss missing')
  pump()
 key(b'\\x03');pump();key(b'\\x0c');wait('execution.cancel · applied');key(b'\\x11');p.wait(timeout=6);assert p.returncode==0`
     : `key(${JSON.stringify(`/background stop ${f.jobs[0]!.id}`)}.encode());key(b'\\r');p.wait(timeout=10);assert p.returncode==-9;assert os.path.exists(${JSON.stringify(marker)})`
}
finally:
 open(${JSON.stringify(`${base}.pty.log`)},'ab').write(full)
 if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(m)
`;
    try {
      for (const cold of [false, true]) {
        writeFileSync(runner, source(cold));
        writeFileSync(base + (cold ? '.cold.py' : '.producer.py'), driver(cold));
        python = Bun.spawn(['python3', '-c', driver(cold)], {
          env: { ...process.env, KITE_CALLER_TEST_TOKEN: f.token },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [out, err, code] = await Promise.all([
          new Response(python.stdout).text(),
          new Response(python.stderr).text(),
          python.exited,
        ]);
        if (code) console.error(out, err);
        expect(code).toBe(0);
      }
      const records = JSON.parse(readFileSync(journal, 'utf8')).records,
        rows = readFileSync(wire, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l));
      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record.intent.request.kind).toBe('execution.cancel');
      expect(record.intent.request.executionId).toBe(f.jobs[0]!.id);
      expect(record.intent.scope).toEqual({ storeId: f.storeId, workspaceId: 'w', sessionId: 's' });
      expect(record.phase).toBe('applied');
      expect(rows.filter((r) => r.method === 'POST' && typeof r.path === 'string')).toHaveLength(1);
      expect(rows.filter((r) => r.cold && r.method === 'POST')).toEqual([]);
      expect(
        rows.filter((r) => r.cold && r.path?.startsWith('/v1/commands/')).map((r) => r.path),
      ).toEqual(Array(2).fill(`/v1/commands/${record.intent.request.commandId}`));
      const a = await f.client.getExecution(f.jobs[0]!.id),
        b = await f.client.getExecution(f.jobs[1]!.id);
      expect(a.cancelRequestedAt).not.toBeNull();
      expect(b.cancelRequestedAt).toBeNull();
      expect(b.status).toBe('running');
      expect(f.calls()).toBe(2);
      expect((await f.client.getView('s')).runs).toHaveLength(1);
      expect((await f.client.getCommand(record.intent.request.commandId)).receipt).toMatchObject({
        kind: 'execution.cancel',
        executionId: a.id,
        outcome: 'cancel_requested',
      });
      writeFileSync(`${base}.facts.json`, JSON.stringify({ a, b, record, rows, calls: f.calls() }));
      console.log('caller Job retained', base);
    } finally {
      if (python && python.exitCode === null) {
        python.kill('SIGKILL');
        await python.exited;
      }
      await f.close();
    }
  },
  30000,
);
