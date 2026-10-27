import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('native browser transport binds its daemon, bounds NDJSON and retains namespace cancellation uncertainty', () => {
  const native = fileURLToPath(new URL('../../../src/tools/browser/native.ts', import.meta.url));
  const owned = fileURLToPath(
    new URL('../../../src/platform/process/linux-owned-program.ts', import.meta.url),
  );
  const source = `
import realAssert from 'node:assert/strict';
let assertions=0;
const assert=new Proxy(realAssert,{get(target,key){const value=target[key];return typeof value==='function'?(...args)=>{assertions++;return value(...args);}:value;}});
import { mock } from 'bun:test';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import * as actualFS from 'node:fs';
import * as actualNet from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, existsSync, statSync, symlinkSync, rmSync, truncateSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
Object.defineProperty(process, 'platform', { value: 'linux' });
Object.defineProperty(process, 'arch', { value: 'x64' });
const base = mkdtempSync(join(tmpdir(), 'ab-test-'));
process.env.AGENT_BROWSER_CDP = 'http://untrusted/';
process.env.AGENT_BROWSER_PLUGINS = 'untrusted';
process.env.AWS_SECRET_ACCESS_KEY = 'must not inherit';
let scenario = {}, current, starts = 0, connections = 0;
let sandboxMode='eligible';
const realTimeout=globalThis.setTimeout;
globalThis.setTimeout=(callback,ms,...args)=>realTimeout(callback,ms===600000&&scenario.expire?20:ms===1000&&scenario.monitor?5:ms,...args);
Object.defineProperty(process,'geteuid',{value:()=>sandboxMode==='root'?0:1000});
delete process.env.CI;
class FixtureStartError extends Error { constructor(cleanup) { super('startup_unknown'); this.cleanup=cleanup; } }
const endpoints = new Map();
const originalLstat = actualFS.lstatSync;
const originalOpen = actualFS.openSync, originalRead=actualFS.readSync, originalClose=actualFS.closeSync;
let cgroupPosition=0;
require('node:net');
mock.module('node:fs', () => ({ ...actualFS, lstatSync(path, ...args) {
  if(path==='/.dockerenv'||path==='/run/.containerenv'){
    if(sandboxMode==='marker')return {};
    throw Object.assign(Error('missing'),{code:sandboxMode==='unknown'?'EACCES':'ENOENT'});
  }
  if (endpoints.has(path)) return { isSocket:()=>true, uid:process.getuid() };
  return originalLstat(path, ...args);
},openSync(path,...args){
  if(path==='/proc/self/cgroup'||path==='/proc/1/cgroup'){cgroupPosition=0;return -10;}
  return originalOpen(path,...args);
},readSync(fd,buffer,offset,length,position){
  if(fd===-10){const data=Buffer.from(sandboxMode==='cgroup'?'0::/docker/fixture':sandboxMode==='longCgroup'?'x'.repeat(65538):'0::/user.slice');
    const count=data.copy(buffer,offset,cgroupPosition,cgroupPosition+length);cgroupPosition+=count;return count;}
  return originalRead(fd,buffer,offset,length,position);
},closeSync(fd){if(fd!==-10)return originalClose(fd);}}));
mock.module('node:net', () => ({ ...actualNet, createConnection(path) {
  connections++;
  const socket = new EventEmitter();
  let destroyed=false;
  socket.destroy=()=>{if(!destroyed){destroyed=true;queueMicrotask(()=>socket.emit('close'));}return socket;};
  socket.write=(bytes,callback)=>{
    if(destroyed){callback(Error('closed'));return false;}
    if(JSON.parse(bytes.toString()).action==='write_failed'){
      current.writeFailures=(current.writeFailures??0)+1;callback(Error('injected write failure'));return false;
    }
    callback();queueMicrotask(()=>endpoints.get(path)?.(socket,bytes));return true;
  };
  socket.end=(bytes)=>{if(bytes!==undefined)socket.emit('data',Buffer.from(bytes));socket.destroy();};
  const failConnect=current?.failNextConnect; if(failConnect)current.failNextConnect=false;
  queueMicrotask(()=>{if(!destroyed){if(endpoints.has(path)&&!failConnect)socket.emit('connect');else socket.emit('error',Error('missing'));}});
  return socket;
}}));
mock.module(${JSON.stringify(owned)}, () => ({
  LinuxOwnedProgramStartError: FixtureStartError,
  startLinuxOwnedProgram(options) {
    starts++;
    assert.deepEqual(options.argv, []);
    assert.equal(options.env.AGENT_BROWSER_DAEMON, '1');
    assert.equal(options.env.AGENT_BROWSER_CDP, undefined);
    assert.equal(options.env.AGENT_BROWSER_PLUGINS, undefined);
    assert.equal(options.env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(options.env.AGENT_BROWSER_NO_WEBMCP, '1');
    assert.equal(statSync(options.cwd).mode & 511, 448);
    const session = options.env.AGENT_BROWSER_SESSION;
    const evidence = {
      version:1,coverage:'linux-pid-namespace',ownerPid:process.pid,
      admission:{nonce:options.nonce,purpose:'stdio'},
      wrapper:{pid:100,birth:'1',parentPid:process.pid,exit:null,closed:false,stdoutEof:false,stderrEof:false},
      namespace:{dev:'1',ino:'2',init:{pid:101,birth:'2',parentPid:100,localPid:1,dead:false},
        root:{pid:102,birth:'3',parentPid:101,localPid:2,dead:false,waitReceipt:null},treeStopped:false},
      phase:'ready',fdClosed:false,closeUnknown:false,
    };
    let complete;
    const completion = new Promise(resolve => complete = resolve);
    let resolveReady;
    const ready = scenario.startUnknown ? Promise.reject(Error('startup_unknown')) : scenario.pendingReady ? new Promise(resolve=>resolveReady=resolve) : Promise.resolve();
    void ready.catch(()=>{});
    const connections = new Set();
    const mode = {...scenario};
    const requests = [];
    const endpoint = join(options.cwd,session+'.sock');
    endpoints.set(endpoint,(socket,bytes) => {
      connections.add(socket);socket.on('close',()=>connections.delete(socket));socket.on('error',()=>{});
        const command=JSON.parse(bytes.toString());requests.push(command);
        const send = data => socket.end(JSON.stringify({id:command.id,success:true,data})+'\\n');
        if(command.action==='session_info')return send({session,socketDir:options.cwd,backgroundPid:mode.wrongPid?102:2,browserLaunched:false});
        if(command.action==='snapshot')return send({snapshot:'完整🙂',refs:{e1:{role:'button',name:'Submit'}}});
        if(command.action==='url')return send({url:mode.navigationChanged&&requests.filter(x=>x.action==='url').length>1?'https://changed.example/':'https://example.test/'});
        if(command.action==='title')return send({title:'Example'});
        if(command.action==='fill')return send({value:command.value});
        if(command.action==='launch'){
          assert.equal(command.profile,join(options.cwd,'profile'));
          assert.equal(command.downloadPath,join(options.cwd,'downloads'));
          assert.deepEqual(command.args,['--disk-cache-size=33554432','--media-cache-size=8388608']);
          return send({launched:true});
        }
        if(command.action==='failed')return socket.end(JSON.stringify({id:command.id,success:false,error:'actual failure',code:'page_wedged'})+'\\n');
        if(command.action==='lost')return socket.end();
        if(command.action==='invalid')return socket.end('{not json}\\n');
        if(command.action==='mismatch')return socket.end(JSON.stringify({id:'wrong',success:true,data:{}})+'\\n');
        if(command.action==='large')return socket.end('x'.repeat(2049));
        if(command.action==='invalid_utf')return socket.end(Buffer.concat([Buffer.from('{"id":"'+command.id+'","success":true,"data":"'),Buffer.from([0xc3,0x28]),Buffer.from('"}\\n')]));
        if(command.action==='invalid_envelope')return socket.end(JSON.stringify({id:command.id,success:'true',data:{}})+'\\n');
        if(command.action==='trailing')return socket.end(JSON.stringify({id:command.id,success:true,data:{}})+'\\n{}\\n');
        if(command.action==='fragmented'){
          const bytes=Buffer.from(JSON.stringify({id:command.id,success:true,data:{text:'完整🙂'}})+'\\n');
          const split=bytes.indexOf(Buffer.from('🙂'))+2;
          socket.emit('data',bytes.subarray(0,split));queueMicrotask(()=>socket.end(bytes.subarray(split)));return;
        }
        if(command.action==='late_data'){
          send({first:true});queueMicrotask(()=>socket.emit('data',Buffer.from('{broken late response}\\n')));return;
        }
        if(command.action==='late_success'){
          current.replyLate=()=>send({executed:true});return;
        }
        if(command.action==='hold')return;
        if(command.action==='screenshot'){
          assert.equal(command.format,'jpeg');assert.equal(command.quality,35);assert.equal(command.annotate,true);
          assert.equal(command.fullPage,false);assert.ok(command.path.startsWith(options.cwd+'/capture-'));
          const image=Buffer.from([255,216,255,192,0,11,8,0,2,0,3,1,1,17,0,255,217]);
          writeFileSync(command.path,mode.largeImage?Buffer.alloc(96*1024+1):image);
          return send({path:command.path,annotations:[{ref:'e1',number:1,role:'button',name:'Submit',box:{x:0,y:0,width:3,height:2}}]});
        }
        send({});
    });
    writeFileSync(join(options.cwd,session+'.version'), mode.badVersion?'0.0.0':'0.39.4');
    let cancels=0;
    const owner={pid:100,stdout:new PassThrough(),stderr:new PassThrough(),ready,completion,
      readProcessEvidence:()=>structuredClone(evidence),
      writeStdin:async()=>{throw Error('not stdio RPC');},endStdin:async()=>{},
      cancel(){
        if(cancels++)return completion;
        for(const socket of connections)socket.destroy();
        endpoints.delete(endpoint);
        setTimeout(()=>{
          evidence.phase='terminal';evidence.fdClosed=true;
          evidence.wrapper.exit={code:0,signal:null,reaped:true};
          evidence.wrapper.closed=true;evidence.wrapper.stdoutEof=true;evidence.wrapper.stderrEof=true;
          evidence.namespace.init.dead=true;evidence.namespace.root.dead=true;
          evidence.namespace.treeStopped=!mode.unknown&&!mode.startUnknown;
          evidence.namespace.root.waitReceipt={localPid:2,code:0,signal:null,rawStatus:0,waitConfirmed:true,reaped:true};
          owner.stdout.end();owner.stderr.end();complete({confirmed:true,code:0,signal:null,reason:'cancel'});
        },mode.delay??5);
        return completion;
      },
    };
    current={owner,requests,resolveReady,directory:options.cwd,get cancels(){return cancels;}};
    if(mode.startUnknown)throw new FixtureStartError(owner);
    return owner;
  },
}));
const {createNativeBrowserTransport,BrowserTransportError,nativeBrowserUnavailableReason}=await import(${JSON.stringify(native)});
assert.equal(starts,0,'cold import must not spawn');
assert.equal(nativeBrowserUnavailableReason(),undefined,'eligible passive probe');
for(const platform of ['darwin','win32']){
  Object.defineProperty(process,'platform',{value:platform});
  assert.equal(nativeBrowserUnavailableReason(),'browser_native_platform_unavailable');
}
Object.defineProperty(process,'platform',{value:'linux'});
assert.equal(starts,0,'passive probe must not spawn');
const options={executable:process.execPath,browserPath:process.execPath,linux:{bubblewrapPath:process.execPath,initExecutable:process.execPath},runtimeDirectory:base,startupTimeoutMs:500,requestTimeoutMs:100,maximumResponseBytes:2048};
const context=()=>({sessionId:'session',executionId:'execution',signal:new AbortController().signal});
const signal=()=>new AbortController().signal;
async function start(mode={}){scenario=mode;const transport=createNativeBrowserTransport(options,context());await transport.ready;return transport;}
for(const platform of ['darwin','win32']){
  Object.defineProperty(process,'platform',{value:platform});
  assert.throws(()=>createNativeBrowserTransport(options,context()),/browser_native_platform_unavailable/);
}
Object.defineProperty(process,'platform',{value:'linux'});
Object.defineProperty(process,'arch',{value:'ia32'});
assert.throws(()=>createNativeBrowserTransport(options,context()),/browser_native_platform_unavailable/);
Object.defineProperty(process,'arch',{value:'x64'});
assert.equal(starts,0,'unsupported platforms never enter the native owner factory');
assert.equal(connections,0,'unsupported platforms never connect');
assert.deepEqual(readdirSync(base),[],'unsupported platforms never create private state');
for(const mode of ['root','marker','cgroup','unknown','longCgroup']){
  sandboxMode=mode;assert.match(nativeBrowserUnavailableReason(),/sandbox_(unavailable|unknown)/);
  assert.throws(()=>createNativeBrowserTransport(options,context()),/sandbox_(unavailable|unknown)/);
}
sandboxMode='eligible';process.env.CI='';
assert.throws(()=>createNativeBrowserTransport(options,context()),/sandbox_unavailable/);delete process.env.CI;
assert.equal(starts,0,'sandbox ineligibility or ambiguity must reject before execution');
const wide=join(base,'wide');mkdirSync(wide,{mode:493});
assert.throws(()=>createNativeBrowserTransport({...options,runtimeDirectory:wide},context()),/invalid_directory/);
assert.equal(statSync(wide).mode&511,493,'foreign existing permissions must not be repaired');
const alias=join(base,'alias');symlinkSync(base,alias);
assert.throws(()=>createNativeBrowserTransport({...options,runtimeDirectory:alias},context()),/invalid_directory/);
assert.equal(starts,0,'invalid root must fail before execution');
const created=join(base,'created');scenario={};
let createdTransport=createNativeBrowserTransport({...options,runtimeDirectory:created},context());
await createdTransport.ready;assert.equal(statSync(created).mode&511,448);await createdTransport.dispose();
let transport=await start();
assert.equal(current.requests.length,1);assert.equal(current.requests[0].action,'session_info');
await assert.rejects(transport.request({action:'launch',headless:true,engine:'chrome',webmcp:false,args:['--no-sandbox']},signal()),e=>!e.dispatched&&/launch_invalid/.test(e.message));
await transport.request({action:'launch',headless:true,engine:'chrome',webmcp:false},signal());
assert.equal((await transport.request({action:'snapshot'},signal())).data.snapshot,'完整🙂');
assert.equal((await transport.request({action:'fill',value:'--session'},signal())).data.value,'--session');
assert.equal((await transport.request({action:'fragmented'},signal())).data.text,'完整🙂','UTF-8 code points may span transport chunks');
assert.deepEqual((await transport.request({action:'late_data'},signal())).data,{first:true});
await Promise.resolve();assert.equal(current.cancels,0,'late data cannot replace a settled response or stop the owner');
assert.equal((await transport.request({action:'failed'},signal())).code,'page_wedged');
const capturing=transport.capture(signal());await assert.rejects(transport.capture(signal()),/capture_busy/);
const frame=await capturing;assert.equal(frame.frame.width,3);assert.equal(frame.frame.height,2);
assert.equal(frame.annotations[0].ref,'@e1');assert.equal(frame.path,undefined);
assert.equal(frame.url,'https://example.test/');assert.equal(frame.title,'Example');
assert.ok(!JSON.stringify(frame).includes(current.directory));
assert.equal(readdirSync(current.directory).filter(name=>name.startsWith('capture-')).length,0,'captures leave no screenshot history');
const already=new AbortController();already.abort();
await assert.rejects(transport.request({action:'fill',value:'not sent'},already.signal),e=>e instanceof BrowserTransportError&&!e.dispatched);
assert.equal(current.requests.filter(x=>x.value==='not sent').length,0);
assert.deepEqual(await transport.close(),{confirmed:true});await transport.dispose();
assert.equal(existsSync(current.directory),false);
for(const action of ['lost','invalid','mismatch','large','invalid_utf','invalid_envelope','trailing']){
  transport=await start();
  await assert.rejects(transport.request({action},signal()),e=>e instanceof BrowserTransportError&&e.dispatched);
  assert.equal(current.requests.filter(x=>x.action===action).length,1,'no replay');
  assert.deepEqual(await transport.close(),{confirmed:true});await transport.dispose();
}
transport=await start();current.failNextConnect=true;
const beforeConnectFailure=current.requests.length;
await assert.rejects(transport.request({action:'fill',value:'not connected'},signal()),e=>e instanceof BrowserTransportError&&!e.dispatched&&/connection_failed/.test(e.message));
assert.equal(current.requests.length,beforeConnectFailure,'connection refusal must not dispatch');
assert.equal(current.cancels,0,'a pre-dispatch refusal does not manufacture unknown execution');
await transport.request({action:'snapshot'},signal());await transport.dispose();
transport=await start();
await assert.rejects(transport.request({action:'write_failed'},signal()),e=>e.dispatched&&/write_failed/.test(e.message));
assert.equal(current.writeFailures,1,'ambiguous write failure is never replayed');
assert.deepEqual(await transport.close(),{confirmed:true});await transport.dispose();
transport=await start();
await assert.rejects(transport.request({action:'hold'},signal()),e=>e.dispatched&&/request_timeout/.test(e.message));
assert.equal(current.requests.filter(x=>x.action==='hold').length,1,'sent timeout is never replayed');
assert.deepEqual(await transport.close(),{confirmed:true});await transport.dispose();
transport=await start();
const lateAbort=new AbortController();const latePending=transport.request({action:'late_success'},lateAbort.signal);
await new Promise(resolve=>setTimeout(resolve,5));lateAbort.abort();
await assert.rejects(latePending,e=>e.dispatched&&/aborted/.test(e.message));
current.replyLate();
await assert.rejects(transport.request({action:'snapshot'},signal()),e=>!e.dispatched&&/closed/.test(e.message));
assert.equal(current.requests.filter(x=>x.action==='late_success').length,1,'late success after abort cannot replay or revive the session');
assert.deepEqual(await transport.close(),{confirmed:true});await transport.dispose();
scenario={pendingReady:true};const startupAbort=new AbortController();
transport=createNativeBrowserTransport(options,{...context(),signal:startupAbort.signal});
const waitingRequest=transport.request({action:'fill',value:'not ready'},signal());
startupAbort.abort();await assert.rejects(transport.ready,/closed/);await assert.rejects(waitingRequest);
assert.deepEqual(await transport.close(),{confirmed:true});current.resolveReady();await Promise.resolve();
assert.equal(current.requests.length,0,'late readiness after cancellation never dispatches the handshake or waiting command');
assert.equal(current.cancels,1);await transport.dispose();
scenario={pendingReady:true};transport=createNativeBrowserTransport({...options,startupTimeoutMs:20},context());
await assert.rejects(transport.ready,/start_timeout/);assert.deepEqual(await transport.close(),{confirmed:true});
current.resolveReady();await Promise.resolve();assert.equal(current.requests.length,0,'startup deadline prevents late readiness from dispatching');
await transport.dispose();
transport=await start({delay:50});
const aborter=new AbortController();
const pending=transport.request({action:'hold'},aborter.signal);
await new Promise(resolve=>setTimeout(resolve,15));
await assert.rejects(transport.request({action:'snapshot'},signal()),e=>!e.dispatched&&/busy/.test(e.message));
aborter.abort();await assert.rejects(pending,e=>e.dispatched);
let settled=false;const stopping=transport.close().then(result=>{settled=true;return result;});
await new Promise(resolve=>setTimeout(resolve,5));assert.equal(settled,false,'root/close request is not full-tree proof');
assert.deepEqual(await stopping,{confirmed:true});assert.equal(current.cancels,1);await transport.dispose();
scenario={delay:20};const lifetime=new AbortController();
transport=createNativeBrowserTransport(options,{...context(),signal:lifetime.signal});await transport.ready;
const held=transport.request({action:'hold'},signal());await new Promise(resolve=>setTimeout(resolve,5));
lifetime.abort();await assert.rejects(held,e=>e.dispatched);assert.deepEqual(await transport.close(),{confirmed:true});
assert.equal(current.cancels,1,'close re-entry from context abort uses the same owner cancellation');await transport.dispose();
transport=await start({largeImage:true});await assert.rejects(transport.capture(signal()),/capture_limit/);await transport.dispose();
transport=await start({navigationChanged:true});await assert.rejects(transport.capture(signal()),/navigation_changed/);await transport.dispose();
const first=await start(), second=await start();
assert.throws(()=>createNativeBrowserTransport(options,context()),/session_limit/);
await first.close();assert.throws(()=>createNativeBrowserTransport(options,context()),/session_limit/,'undisposed storage retains admission');
await first.dispose();await second.dispose();
transport=await start();
current.owner.stdout.write(Buffer.alloc(32*1024));current.owner.stderr.write(Buffer.alloc(32*1024));
assert.equal(current.cancels,0,'combined output at the exact budget does not stop the owner');
current.owner.stderr.write(Buffer.from('x'));
assert.deepEqual(await transport.completion,{confirmed:true});
assert.equal(current.cancels,1,'stdout and stderr share one output budget');await transport.dispose();
transport=await start();current.owner.stdout.emit('error',Error('injected pipe failure'));
assert.deepEqual(await transport.completion,{confirmed:true});
assert.equal(current.cancels,1,'owned pipe failure stops the owner rather than leaving it unobserved');await transport.dispose();
transport=await start({expire:true});assert.deepEqual(await transport.completion,{confirmed:true});
assert.equal(current.cancels,1,'fixed lifetime stops a session without client activity');await transport.dispose();
transport=await start({monitor:true});
const sparse=join(current.directory,'downloads','oversize');writeFileSync(sparse,'');truncateSync(sparse,256*1024*1024+1);
assert.deepEqual(await transport.completion,{confirmed:true});assert.equal(current.cancels,1,'sampled byte budget stops owner');await transport.dispose();
transport=await start({monitor:true});
let nested=current.directory;for(let i=0;i<34;i++){nested=join(nested,'nested');mkdirSync(nested);}
assert.deepEqual(await transport.completion,{confirmed:true});assert.equal(current.cancels,1,'scan depth is finite');await transport.dispose();
transport=await start({monitor:true});
for(let i=0;i<4100;i++)writeFileSync(join(current.directory,'downloads','empty-'+i),'');
assert.deepEqual(await transport.completion,{confirmed:true});assert.equal(current.cancels,1,'entry/work budget stops owner');await transport.dispose();
transport=await start({monitor:true});
const outside=join(base,'outside');mkdirSync(outside);const largeOutside=join(outside,'large');writeFileSync(largeOutside,'');truncateSync(largeOutside,256*1024*1024+1);
symlinkSync(outside,join(current.directory,'outside'));
await new Promise(resolve=>realTimeout(resolve,40));assert.equal(current.cancels,0,'storage scanner never traverses symlinks');await transport.dispose();
for(const mode of [{wrongPid:true},{badVersion:true}]){
  scenario=mode;transport=createNativeBrowserTransport(options,context());
  await assert.rejects(transport.ready);assert.deepEqual(await transport.close(),{confirmed:true});await transport.dispose();
}
transport=await start({unknown:true});assert.deepEqual(await transport.close(),{confirmed:false});
await assert.rejects(transport.dispose(),/cleanup_unknown/);assert.equal(existsSync(current.directory),true);
scenario={startUnknown:true};transport=createNativeBrowserTransport(options,context());
await assert.rejects(transport.ready);assert.deepEqual(await transport.close(),{confirmed:false});
await assert.rejects(transport.dispose(),/cleanup_unknown/);assert.equal(existsSync(current.directory),true);
assert.throws(()=>createNativeBrowserTransport(options,context()),/session_limit/,'unknown cleanup cannot accumulate new owners');
// This fixture owns no native processes. Its unknown proof intentionally leaves the private directory retained.
rmSync(base,{recursive:true,force:true});
console.log('browser-native-fixture-ok assertions='+assertions+' fake-daemon-starts='+starts);
`;
  const result = spawnSync(process.execPath, ['--eval', source], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  console.info(result.stdout.trim());
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain('browser-native-fixture-ok');
}, 20000);
