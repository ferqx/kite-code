import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWindowsDaemonPipe, requestWindowsDaemonPipe } from '../../src/daemon/windows-pipe';
import { retainWindowsProcess } from '../../src/daemon/windows-process';

test('Windows pipe retains original overlapped operations, bounded frames and unknown HANDLE close', () => {
  const module = fileURLToPath(new URL('../../src/daemon/windows-pipe.ts', import.meta.url));
  const security = fileURLToPath(new URL('../../src/daemon/windows-security.ts', import.meta.url));
  const processes = fileURLToPath(new URL('../../src/daemon/windows-process.ts', import.meta.url));
  const code = `
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
assert.equal(typeof require('bun:ffi').dlopen, 'function');
Object.defineProperty(process, 'platform', {value:'win32'});
Object.defineProperty(process, 'arch', {value:'x64'});
let next=1n, errno=0, failClose, pipeExistsError=2, serverPid=123, processClosed=0;
const handles=new Map(), operations=new Map(), calls=[];let firstConnection=true, peerClosed=false;
const alloc=kind=>{const h=next++; handles.set(h,kind); return h;};
const symbols={
 GetLastError:()=>errno,
 CreateNamedPipeW(_name, flags, mode, cap, output, input, timeout, attributes){
  assert.equal(mode,8);assert.equal(cap,64);assert.equal(output,16384);assert.equal(input,16384);assert.equal(timeout,5000);assert.equal(attributes.length,24);
  const h=alloc('pipe');calls.push({kind:'pipe',h,flags});return h;
 },
 CreateEventW:()=>alloc('event'),
 ConnectNamedPipe(h,ov){if(firstConnection){firstConnection=false;errno=535;return false;}operations.set(ov,{h,cancelled:false});errno=997;return false;},
 GetOverlappedResult(h,ov){const op=operations.get(ov);assert.equal(op.h,h);if(op.cancelled){operations.delete(ov);errno=995;return false;}errno=996;return false;},
 CancelIoEx(h,ov){const op=operations.get(ov);assert.equal(op.h,h);op.cancelled=true;calls.push({kind:'cancel',h});return true;},
 CloseHandle(h){assert.ok(handles.has(h));if(h===failClose)return false;assert.ok(![...operations.values()].some(op=>op.h===h));handles.delete(h);calls.push({kind:'close',h});return true;},
 DisconnectNamedPipe(){assert.ok(peerClosed);calls.push({kind:'disconnect'});return true;},
 CreateFileW(_name,access,_share,_sa,_creation,flags){assert.equal(flags,0x40110000);assert.equal(access & 4,0);assert.equal(access,0x12019b);return alloc('client');},
 GetNamedPipeServerProcessId(_h,pid){pid[0]=serverPid;return true;},
 WriteFile(_h,bytes,length,count){assert.equal(length,bytes.length);count[0]=length;return true;},
 ReadFile(_h,bytes,_length,count){if(bytes.length===1){peerClosed=true;errno=109;return false;}if(handles.get(_h)==='pipe'){bytes.set(Buffer.from('request\\n'));count[0]=8;return true;}bytes.set(Buffer.from('reply\\n'));count[0]=6;return true;},
 WaitNamedPipeW(){errno=pipeExistsError;return false;}
};
mock.module('bun:ffi',()=>({ptr:value=>value,dlopen:()=>({symbols})}));
mock.module(${JSON.stringify(security)},()=>({windowsDaemonSecurity:()=>({descriptor:()=>({attributes:new Uint8Array(24),close(){}}),verifyPipe(h){assert.ok(handles.has(h));}})}));
mock.module(${JSON.stringify(processes)},()=>({retainWindowsProcess:(_pid,expected)=>({identity:expected,inspect:()=> 'alive',close(){processClosed++;}})}));
const {createWindowsDaemonPipe,requestWindowsDaemonPipe,windowsPipeExists}=await import(${JSON.stringify(module)});
const name=String.raw\`\\\\.\\pipe\\kite-daemon-v1-original\`;
assert.equal(windowsPipeExists(name),false);pipeExistsError=121;assert.equal(windowsPipeExists(name),true);pipeExistsError=5;assert.throws(()=>windowsPipeExists(name),/identity_unknown/);
const owner=createWindowsDaemonPipe(name);await owner.listen(request=>{assert.equal(Buffer.from(request).toString(),'request\\n');return Buffer.from('reply\\n');});
assert.equal(calls.filter(c=>c.kind==='pipe').length,64);
assert.equal(calls.filter(c=>c.kind==='pipe' && (c.flags&0x80000)).length,1);
await Bun.sleep(20);assert.ok(calls.some(c=>c.kind==='disconnect'));await owner.close();assert.equal(handles.size,0);assert.equal(operations.size,0);
const request=Buffer.from('request\\n');assert.deepEqual(await requestWindowsDaemonPipe(name,{pid:123,processStartIdentity:'original'},request),new Uint8Array(Buffer.from('reply\\n')));
assert.equal(processClosed,1);assert.equal(handles.size,0);
serverPid=124;await assert.rejects(requestWindowsDaemonPipe(name,{pid:123,processStartIdentity:'original'},request),/identity_mismatch/);assert.equal(handles.size,0);
await assert.rejects(requestWindowsDaemonPipe(name,{pid:123,processStartIdentity:'original'},Buffer.from('two\\nframes\\n')),/invalid_bootstrap/);
const unknown=createWindowsDaemonPipe(name);failClose=calls.filter(c=>c.kind==='pipe').at(-1).h;
await assert.rejects(unknown.close(),/close_unknown/);assert.ok(handles.has(failClose));assert.equal(handles.size,1);
`;
  const child = spawnSync(process.execPath, ['--eval', code], {
    encoding: 'utf8',
    timeout: 4000,
  });
  if (child.status !== 0)
    throw Error(`Windows pipe mock failed: ${child.error?.message ?? ''}\n${child.stderr}`);
  expect(child.status).toBe(0);
});

test.skipIf(process.platform !== 'win32')(
  'native current-user pipe binds actual server birth and preserves single-frame bytes',
  async () => {
    const name = `\\\\.\\pipe\\kite-daemon-v1-test-${process.pid}-${Date.now()}`;
    const processOwner = retainWindowsProcess(process.pid);
    let owner: ReturnType<typeof createWindowsDaemonPipe> | undefined;
    let failure: unknown;
    try {
      owner = createWindowsDaemonPipe(name);
      expect(processOwner.identity).toBeDefined();
      await owner.listen((request) => {
        expect(Buffer.from(request).toString()).toBe('original\n');
        return Buffer.from('完整原回复\n');
      });
      expect(
        Buffer.from(
          await requestWindowsDaemonPipe(
            name,
            {
              pid: process.pid,
              processStartIdentity: processOwner.identity!,
            },
            Buffer.from('original\n'),
          ),
        ).toString(),
      ).toBe('完整原回复\n');
    } catch (e) {
      failure = e;
    }
    try {
      await owner?.close();
    } catch (e) {
      failure = failure ? new AggregateError([failure, e]) : e;
    }
    try {
      processOwner.close();
    } catch (e) {
      failure = failure ? new AggregateError([failure, e]) : e;
    }
    if (failure) throw failure;
  },
);
