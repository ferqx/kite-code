import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Linux direct program owner preserves private argv, bounded stdin and original namespace terminal proof', () => {
  const path = fileURLToPath(
    new URL('../../../src/platform/process/linux-owned-program.ts', import.meta.url),
  );
  const source = `
import assert from 'node:assert/strict';
import {mock} from 'bun:test';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import * as actualFFI from 'bun:ffi';
import * as actualFS from 'node:fs';
import * as actualChild from 'node:child_process';
assert.equal(typeof require('bun:ffi').dlopen,'function');
require('node:fs');require('node:child_process');
Object.defineProperty(process,'platform',{value:'linux'});
Object.defineProperty(process,'arch',{value:'x64'});
let loads=0, address=4096, scenario, errno=11;
const memory=new Map();
const ptr=value=>{const at=address;address+=4096;memory.set(at,value);return at;};
const bytes=at=>memory.get(Number(at));
const identity=(pid,parent)=>{const fields=Array(20).fill('0');fields[0]='S';fields[1]=String(parent);fields[19]=String(pid*10);return pid+' (trusted process) '+fields.join(' ');};
mock.module('node:fs',()=>({...actualFS,
 readFileSync(path,encoding){assert.equal(encoding,'utf8');
  if(path==='/proc/41001/stat')return identity(41001,process.pid);
  if(path==='/proc/41002/stat')return identity(41002,41001);
  if(path==='/proc/41003/stat')return identity(41003,41002);
  if(path==='/proc/self/fdinfo/30'||path==='/proc/self/fdinfo/12')return 'Pid:\\t41002\\nNSpid:\\t41002 1\\n';
  if(path==='/proc/self/fdinfo/32')return 'Pid:\\t41003\\nNSpid:\\t41003 2\\n';
  throw Error('unexpected read '+path);
 },
 statSync(path,options){assert.deepEqual(options,{bigint:true});if(path!=='/proc/self/ns/pid')throw Object.assign(Error('PTRACE_MODE_READ_FSCREDS denied'),{code:'EACCES'});return{dev:7n,ino:70n};},
 fstatSync(fd,options){assert.equal(fd,31);assert.deepEqual(options,{bigint:true});return{dev:7n,ino:71n};},
}));
mock.module('node:child_process',()=>({...actualChild,spawn(executable,args,options){
 assert.equal(executable,'/trusted/bwrap');assert.deepEqual(options.stdio,['pipe','pipe','pipe',12,'pipe']);assert.deepEqual(options.env,{});
 assert.deepEqual(args,['--unshare-user','--unshare-pid','--as-pid-1','--die-with-parent','--cap-drop','ALL','--bind','/','/','--proc','/proc','--dev-bind','/dev','/dev','--chdir','/work','--','/trusted/init','abcdefghijklmnop','20']);
 assert.ok(!args.includes('literal ; $() secret argument'));
 const child=new EventEmitter();child.pid=41001;child.stdout=new PassThrough();child.stderr=new PassThrough();
 child.stdin=new Writable({write(chunk,_encoding,callback){scenario.input=Buffer.from(chunk);if(scenario.holdWrite)scenario.releaseWrite=callback;else callback();}});
 const configuration=new Writable({write(chunk,_encoding,callback){scenario.configuration=Buffer.from(chunk);callback();}});
 configuration.on('finish',()=>configuration.destroy());
 child.stdio=[child.stdin,child.stdout,child.stderr,12,configuration];
 scenario.child=child;return child;
}}));
function packet(type){const nonce='abcdefghijklmnop';
 if(type===0)return {version:1,type:'namespace',nonce,initLocalPid:1,namespace:{dev:'7',ino:'71'}};
 if(type===1)return {version:1,type:'root',nonce,localPid:2};
 return {version:1,type:'terminal',nonce,reason:scenario.sent.includes('C')?'cancel':'natural',root:{localPid:2,code:23,signal:null,rawStatus:scenario.badReceipt?0:23*256,waitConfirmed:true,reaped:true},treeStopped:true,closed:true};
}
const functions={
 socketpair(domain,type,protocol,out){assert.equal(domain,1);assert.equal(type,0x805);assert.equal(protocol,0);bytes(out)[0]=11;bytes(out)[1]=12;return 0;},
 fcntl(fd,command,flags){assert.equal(fd,11);assert.equal(command,2);assert.equal(flags,1);return 0;},
 setsockopt(fd,level,opt,value,size){assert.equal(fd,11);assert.equal(level,1);assert.equal(opt,16);assert.equal(size,4);assert.equal(bytes(value)[0],1);return scenario.failPasscred?-1:0;},
 syscall(number,fd,signal,info,flags){assert.equal(number,424n);assert.equal(signal,9n);assert.equal(info,0n);assert.equal(flags,0n);assert.ok([12n,30n].includes(fd));scenario.signals.push(Number(fd));scenario.dead=true;return 0n;},
 __errno_location(){return ptr(new Int32Array([errno]));},
 recvmsg(fd,msgPointer,flags){assert.equal(fd,11);assert.equal(flags,0x40000040);const msg=bytes(msgPointer);
  if(scenario.step===0||scenario.step===1&&scenario.sent.includes('P')||scenario.step===2&&scenario.sent.includes('G')&&(!scenario.waitCancel||scenario.sent.includes('C'))){
   const step=scenario.step++;const body=Buffer.from(JSON.stringify(packet(step)));const iov=bytes(msg.readBigUInt64LE(16));body.copy(bytes(iov.readBigUInt64LE(0)));const control=bytes(msg.readBigUInt64LE(32));let offset=0;
   const fds=step===0?[scenario.reuseChild?12:30,31]:step===1?[32]:[];
   if(fds.includes(12))scenario.closed.delete(12); // New SCM_RIGHTS incarnation may reuse a successfully closed child-copy fd.
   if(fds.length){const length=16+4*fds.length;control.writeBigUInt64LE(BigInt(length),0);control.writeInt32LE(1,8);control.writeInt32LE(1,12);fds.forEach((fd,index)=>control.writeInt32LE(fd,16+index*4));offset=(length+7)&~7;}
   control.writeBigUInt64LE(28n,offset);control.writeInt32LE(1,offset+8);control.writeInt32LE(2,offset+12);control.writeInt32LE(41002,offset+16);control.writeUInt32LE(process.getuid(),offset+20);control.writeUInt32LE(process.getgid(),offset+24);
   msg.writeBigUInt64LE(BigInt(offset+32),40);msg.writeInt32LE(scenario.truncated?8:0,48);return body.length;
  }errno=11;return -1;
 },
 send(fd,data,length,flags){assert.equal(fd,11);assert.equal(length,1n);assert.equal(flags,0x4040);const command=bytes(data).toString();scenario.sent.push(command);
  if(command==='G')setTimeout(()=>{scenario.dead=true;scenario.child.stdout.end('完整 original stdout');scenario.child.stderr.end('original stderr');scenario.child.stdin.destroy();scenario.child.emit('exit',0,null);scenario.child.emit('close',0,null);},15);
  return 1n;
 },
 poll(poll,count,timeout){assert.equal(count,1n);assert.equal(timeout,0);const p=bytes(poll);assert.ok([12,30,32].includes(p.readInt32LE(0)));if(scenario.dead){p.writeInt16LE(1,6);return 1;}return 0;},
 close(fd){scenario.closes.push(fd);if(scenario.failClose===fd){errno=5;return -1;}assert.equal(scenario.closed.has(fd),false);scenario.closed.add(fd);return 0;},
};
mock.module('bun:ffi',()=>({...actualFFI,ptr,toArrayBuffer(at,offset,length){const value=bytes(at);return value.buffer.slice(value.byteOffset+offset,value.byteOffset+offset+length);},dlopen(name){assert.equal(name,'libc.so.6');loads++;return{symbols:functions,close(){scenario.libraryClosed++;}};}}));
const {startLinuxOwnedProgram,LinuxOwnedProgramStartError}=await import(${JSON.stringify(path)});
assert.equal(loads,0);
const options={bubblewrapPath:'/trusted/bwrap',initExecutable:'/trusted/init',executable:'/native/server',argv:['literal ; $() secret argument','中'.repeat(4000)],cwd:'/work',env:{ONLY_ORIGINAL:'original-value'},nonce:'abcdefghijklmnop',graceMs:20};
assert.throws(()=>startLinuxOwnedProgram({...options,graceMs:5001}),/options/);assert.equal(loads,0);
function start(extra={}){scenario={step:0,sent:[],closes:[],closed:new Set(),libraryClosed:0,dead:false,signals:[],...extra};const owner=startLinuxOwnedProgram(options);owner.stdout.resume();owner.stderr.resume();return owner;}
let owner=start();await owner.ready;
assert.deepEqual(scenario.sent,['P','G']);
const config=scenario.configuration;assert.equal(config.subarray(0,8).toString(),'KITEMCP1');assert.equal(config.readUInt32LE(8),2);assert.equal(config.readUInt32LE(12),1);
let at=16;const field=()=>{const size=config.readUInt32LE(at);at+=4;const text=config.subarray(at,at+size).toString();at+=size;return text;};
assert.deepEqual([field(),field(),field(),field(),field()],['/native/server','/work','literal ; $() secret argument','中'.repeat(4000),'ONLY_ORIGINAL=original-value']);assert.equal(at,config.length);
let originalFresh=true;const staleWrite=owner.writeStdin(Buffer.from('must never enter RPC'),()=>{if(!originalFresh)throw Error('original_source_stale');});originalFresh=false;await assert.rejects(staleWrite,/original_source_stale/);assert.equal(scenario.input,undefined);assert.equal(owner.readProcessEvidence().phase,'ready');
await owner.writeStdin(Buffer.from('original RPC\\n'));assert.equal(scenario.input.toString(),'original RPC\\n');
assert.deepEqual(await owner.completion,{confirmed:true,code:23,signal:null,reason:'natural'});
const evidence=owner.readProcessEvidence();assert.deepEqual(evidence.admission,{nonce:options.nonce,purpose:'stdio'});assert.equal(evidence.wrapper.closed,true);assert.equal(evidence.wrapper.stdoutEof,true);assert.equal(evidence.wrapper.stderrEof,true);assert.equal(evidence.namespace.treeStopped,true);assert.equal(evidence.namespace.root.waitReceipt.rawStatus,5888);assert.equal(evidence.fdClosed,true);
owner=start({holdWrite:true,waitCancel:true});await owner.ready;
const pending=owner.writeStdin(Buffer.from('held original request'));await new Promise(resolve=>setTimeout(resolve,1));
await assert.rejects(owner.writeStdin(Buffer.alloc(1024*1024+1)),/stdin_unavailable/);
const cancelled=owner.cancel();await new Promise(resolve=>setTimeout(resolve,1));assert.deepEqual(scenario.sent,['P','G','C']);const pipeError=Object.assign(Error('original_pipe_closed'),{code:'EPIPE'});scenario.child.stdin.emit('error',pipeError);scenario.releaseWrite(pipeError);await assert.rejects(pending,/original_pipe_closed/);assert.deepEqual(await cancelled,{confirmed:true,code:23,signal:null,reason:'cancel'});
owner=start({badReceipt:true});await owner.ready;assert.equal((await owner.completion).confirmed,false);assert.equal(owner.readProcessEvidence().phase,'unknown');await new Promise(resolve=>setTimeout(resolve,30));assert.equal(owner.readProcessEvidence().phase,'unknown');assert.equal(owner.readProcessEvidence().fdClosed,false);
let failure;try{start({failPasscred:true,failClose:11});}catch(error){failure=error;}
assert.ok(failure instanceof LinuxOwnedProgramStartError);await assert.rejects(failure.cleanup.ready,/passcred/);assert.equal((await failure.cleanup.completion).confirmed,false);assert.equal(failure.cleanup.readProcessEvidence().closeUnknown,true);assert.equal(scenario.libraryClosed,0);
process.exit(0);
`;
  const result = spawnSync(process.execPath, ['--eval', source], {
    timeout: 4000,
    encoding: 'utf8',
  });
  if (result.status !== 0) console.error(result.stderr);
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
});

const linuxTest = process.platform === 'linux' ? test : test.skip;
linuxTest(
  'actual Linux direct program preserves original RPC and closes its detached namespace descendants',
  async () => {
    const { qualifyLinuxOwnedProgram } = await import('./linux-owned-program-native.fixture');
    await qualifyLinuxOwnedProgram();
  },
  30000,
);
