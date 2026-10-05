import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { recoveryProfile } from '../fixtures/recovery-profile';

const repo = resolve(import.meta.dir, '../../../..');
for (const crash of ['prepared', 'post-lost'] as const)
  test(`80x24 ${crash} SIGKILL preserves original caller; cold POST/first GET loss never retries original Work`, async () => {
    const f = await recoveryProfile();
    let python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    const base = `${f.root}-caller-${crash}`,
      wire = `${base}.wire.jsonl`,
      journal = join(f.profile.profilePath, 'ui/caller-intents.json'),
      marker = `${base}.crashed`,
      firstGet = `${base}.get-lost`,
      transcript = `${base}.pty.log`;
    try {
      const prep = await f.launch();
      try {
        await prep.client.recoverSession('s', {
          kind: 'session.recover',
          expectedStoreId: f.storeId,
          commandId: 'caller-preparation',
          decision: 'interrupt',
        });
        await prep.client.createSession({
          expectedStoreId: f.storeId,
          commandId: 'caller-session',
          sessionId: 'caller',
          workspaceId: 'w',
          title: 'Caller',
        });
      } finally {
        await prep.close();
      }
      const request = 'ORIGINAL_CALLER_UTF8 中🙂e\u0301\r\n尾部';
      const runner = join(f.root, 'caller-runner.ts');
      const source = (cold: boolean) =>
        `import{appendFileSync,readFileSync,writeFileSync}from'node:fs';import{createServer}from'node:http';import{runTUIHost}from${JSON.stringify(join(repo, 'apps/cli/host/tui.tsx'))};const actual=globalThis.fetch;let forwarding='';let dropPost=${JSON.stringify(!cold && crash === 'post-lost')},dropGet=${JSON.stringify(cold && crash === 'post-lost')};const relay=createServer(async(req,res)=>{const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));const headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(v&&!['host','connection','content-length'].includes(k))headers.set(k,Array.isArray(v)?v.join(','):v);const response=await actual(forwarding,{method:req.method,headers,...(req.method==='POST'?{body:Buffer.concat(parts)}:{})});const bytes=await response.arrayBuffer();appendFileSync(${JSON.stringify(wire)},JSON.stringify({event:'physical_response_dropped',method:req.method,path:new URL(forwarding).pathname,response:JSON.parse(Buffer.from(bytes).toString())})+'\\n');res.socket!.destroy();if(req.method==='POST'){writeFileSync(${JSON.stringify(marker)},'actual POST committed, physical response lost');const end=Date.now()+5000;while(true){const view=await(await actual(new URL('/v1/sessions/caller/view',forwarding),{headers})).json()as{executions:{kind:string,status:string}[]};if(view.executions.some(e=>e.kind==='model'&&e.status==='succeeded'))break;if(Date.now()>end)throw Error('original_model_before_crash_deadline');await Bun.sleep(5);}setTimeout(()=>process.kill(process.pid,'SIGKILL'),20);}else writeFileSync(${JSON.stringify(firstGet)},'actual original GET physically lost');});await new Promise<void>(r=>relay.listen(0,'127.0.0.1',r));const addr=relay.address()as{port:number};globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const callerLookup=new Error().stack?.includes('caller-port.ts')??false;const method=args[1]?.method??'GET',url=new URL(String(args[0]));appendFileSync(${JSON.stringify(wire)},JSON.stringify({event:'request',cold:${cold},callerLookup,method,path:url.pathname,body:args[1]?.body?JSON.parse(String(args[1].body)):null})+'\\n');if(method==='POST'&&url.pathname==='/v1/sessions/caller/commands'){const bytes=readFileSync(${JSON.stringify(journal)});writeFileSync(${JSON.stringify(`${base}.prepared.json`)},bytes);if(${JSON.stringify(!cold && crash === 'prepared')}){writeFileSync(${JSON.stringify(marker)},'durable prepared; zero network POST');process.kill(process.pid,'SIGKILL');await new Promise(()=>{});}if(dropPost){dropPost=false;forwarding=url.href;return actual('http://127.0.0.1:'+addr.port+url.pathname,args[1]);}}if(method==='GET'&&url.pathname.startsWith('/v1/commands/')&&dropGet&&callerLookup){const saved=JSON.parse(readFileSync(${JSON.stringify(journal)},'utf8')).records[0];if(url.pathname.endsWith(saved.intent.request.commandId)){dropGet=false;forwarding=url.href;return actual('http://127.0.0.1:'+addr.port+url.pathname,args[1]);}}return actual(...args);},{preconnect:actual.preconnect});try{await runTUIHost({dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',thread:'caller',cwd:${JSON.stringify(f.workspace)},artifact:${JSON.stringify(f.artifact)}});}finally{relay.close();}`;
      writeFileSync(runner, source(false));
      const driver = (
        cold: boolean,
      ) => `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct,json
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(runner)}],stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);buffer=b'';full=b''
def pump():
 global buffer,full
 end=time.monotonic()+.1
 while time.monotonic()<end:
  if select.select([master],[],[],.02)[0]:
   try:data=os.read(master,65536)
   except OSError:return
   buffer+=data;full+=data
def key(v):
 global buffer
 buffer=b'';os.write(master,v);pump()
def wait(t):
 deadline=time.monotonic()+10
 while t not in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace'))):
  if time.monotonic()>deadline:raise RuntimeError('expected '+t+' tail='+buffer[-6000:].decode(errors='replace'))
  pump()
try:
 ${cold ? `wait('Session caller');key(b'\\x7f'*${Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(request)).length});key(b'/recovery');key(b'\\r');wait('Saved caller intents 1');wait('unknown');${crash === 'post-lost' ? `key(b'\\x0c');deadline=time.monotonic()+5\n while not os.path.exists(${JSON.stringify(firstGet)}):\n  if time.monotonic()>deadline:raise RuntimeError('original GET was not dropped')\n  pump()\n key(b'\\x03');pump();key(b'\\x0c');wait('run.start · applied')` : `key(b'\\x0c');deadline=time.monotonic()+5\n while not any(x.get('cold') and x.get('path','').startswith('/v1/commands/') for x in [json.loads(l) for l in open(${JSON.stringify(wire)})]):\n  if time.monotonic()>deadline:raise RuntimeError('original GET was not sent')\n  pump()`}\n key(b'\\x03');key(b'\\x1b');wait('Session caller');key(b'\\x11');deadline=time.monotonic()+6\n while p.poll() is None and time.monotonic()<deadline:pump()\n p.wait(timeout=3);assert p.returncode==0;print('COLD_ORIGINAL_GET_ONLY')` : `wait('New Run');key(b'\\x1b[200~'+${JSON.stringify(request)}.encode()+b'\\x1b[201~');key(b'\\r');deadline=time.monotonic()+10\n while p.poll() is None and time.monotonic()<deadline:pump()\n p.wait(timeout=3);assert p.returncode==-9;assert os.path.exists(${JSON.stringify(marker)});print('ACTUAL_CALLER_SIGKILL')`}
finally:
 open(${JSON.stringify(transcript)},'ab').write(full)
 if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(master)
`;
      const run = async (cold: boolean) => {
        writeFileSync(`${base}.${cold ? 'cold' : 'producer'}.py`, driver(cold));
        python = Bun.spawn(['python3', '-c', driver(cold)], { stdout: 'pipe', stderr: 'pipe' });
        const [out, err, code] = await Promise.all([
          new Response(python.stdout).text(),
          new Response(python.stderr).text(),
          python.exited,
        ]);
        if (code !== 0) console.error(err);
        expect(code).toBe(0);
        expect(out).toContain(cold ? 'COLD_ORIGINAL_GET_ONLY' : 'ACTUAL_CALLER_SIGKILL');
      };
      await run(false);
      expect(existsSync(marker)).toBe(true);
      const original = JSON.parse(readFileSync(journal, 'utf8')).records[0];
      expect(original.intent.request.content).toBe(request);
      expect(original.intent.scope).toEqual({
        storeId: f.storeId,
        workspaceId: 'w',
        sessionId: 'caller',
      });
      expect(original.intent.subjectId).toBe('local-user');
      expect(original.phase).toMatch(/submitting|unknown/);
      const entered = f.calls();
      writeFileSync(runner, source(true));
      await run(true);
      expect(f.calls()).toBe(entered);
      const rows = readFileSync(wire, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(rows.filter((r) => r.cold && r.method === 'POST')).toEqual([]);
      const gets = rows.filter(
        (r) =>
          r.cold &&
          r.callerLookup &&
          r.method === 'GET' &&
          r.path === `/v1/commands/${original.intent.request.commandId}`,
      );
      expect(gets.length).toBe(crash === 'post-lost' ? 2 : 1);
      expect(
        f.rows("SELECT count(*) AS n FROM command WHERE session_id='caller' AND kind='run.start'"),
      ).toEqual([{ n: crash === 'prepared' ? 0 : 1 }]);
      writeFileSync(`${base}.final.json`, readFileSync(journal));
      writeFileSync(
        `${base}.facts.json`,
        JSON.stringify({
          rows,
          commands: f.rows(
            'SELECT id,kind,status,subject_id,request_digest,receipt_json FROM command',
          ),
          runs: f.rows('SELECT id,origin_command_id,status FROM run'),
          calls: f.calls(),
        }),
      );
      console.log('caller retained', base);
    } finally {
      if (python && python.exitCode === null) {
        python.kill('SIGKILL');
        await python.exited;
      }
      f.close();
    }
  }, 30000);
