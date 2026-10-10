import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('Windows selected endpoint keeps the complete private discovery contract and original cleanup authority', () => {
  const modulePath = (name: string) => resolve(import.meta.dir, '../../src/daemon', name);
  const code = `
import assert from 'node:assert/strict';
import {mock} from 'bun:test';
import {existsSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
Object.defineProperty(process,'platform',{value:'win32'});
const files=new Map(),pipes=new Map(),events=[];
const fileId={dev:'1',ino:'42'};
let refuseClose=false,failNextRead=false,failReadAfterRequest=false;
mock.module(${JSON.stringify(modulePath('windows-security.ts'))},()=>({windowsDaemonSecurity:()=>({sidText:'S-1-5-21-42',recordBase:'C:\\\\Users\\\\owner\\\\AppData\\\\Local\\\\kite-daemon-fixed\\\\v1'})}));
mock.module(${JSON.stringify(modulePath('windows-process.ts'))},()=>({
 readWindowsProcessStartIdentity:()=> 'windows:filetime:123456789012345678',
 inspectWindowsProcess:()=> 'alive',retainWindowsProcess:()=>({inspect:()=> 'alive',close(){}})}));
mock.module(${JSON.stringify(modulePath('windows-record.ts'))},()=>({
 readWindowsDaemonRecord(path){if(failNextRead){failNextRead=false;throw Error('daemon_record_close_unknown');}return files.has(path)?{bytes:Buffer.from(files.get(path)),identity:fileId}:undefined;},
 removeWindowsDaemonRecord(){throw Error('unexpected_offline_remove');},
 reserveWindowsDaemonRecord(path,bytes){
  assert(!files.has(path)); files.set(path,Buffer.from(bytes));events.push('record');
  return {identity:fileId,read:()=>Buffer.from(files.get(path)),publish(bytes){files.set(path,Buffer.from(bytes));events.push('publish');},
   remove(expected){assert.deepEqual(files.get(path),Buffer.from(expected));assert.equal(pipes.size,0);files.delete(path);events.push('remove');},close(){events.push('record_close');}};
 }
}));
mock.module(${JSON.stringify(modulePath('windows-pipe.ts'))},()=>({
 windowsPipeExists:path=>pipes.has(path),
 createWindowsDaemonPipe(path){const item={respond:undefined};pipes.set(path,item);events.push('pipe');return {
  async listen(respond){item.respond=respond;events.push('listen');},
  async close(){events.push('pipe_close');if(refuseClose)throw Object.assign(Error('daemon_endpoint_close_unknown'),{code:'daemon_endpoint_close_unknown'});pipes.delete(path);}};},
 async requestWindowsDaemonPipe(path,expected,request){assert.equal(expected.pid,process.pid);assert.equal(expected.processStartIdentity,'windows:filetime:123456789012345678');if(failReadAfterRequest)failNextRead=true;return pipes.get(path).respond(request);}
}));
const {selectProfile}=await import('@kite-ai/agent/profile');
const {selectDaemonEndpoint,reserveDaemonEndpoint,readDaemonReservation,requestDaemonBootstrap}=await import(${JSON.stringify(modulePath('endpoint.ts'))});
const {DaemonEndpointCleanupError,removeExactEndpoint}=await import(${JSON.stringify(modulePath('reservation.ts'))});
const workspace=realpathSync(mkdtempSync(join(tmpdir(),'kite-windows-endpoint-contract-')));
try {
 const profile=selectProfile({dataRoot:join(workspace,'absent'),profile:'owned'});
 const identity={dataRoot:profile.dataRoot,name:profile.profile,accessKey:profile.profileAccessKey};
 const endpoint=selectDaemonEndpoint({profileAccessKey:identity.accessKey});
 assert.match(endpoint.socket,/^\\\\\\\\\\.\\\\pipe\\\\kite-daemon-v1-[a-f0-9]{64}-[a-f0-9]{64}$/);
 assert.equal(endpoint.transport,'windows-pipe');assert.equal(files.size,0);assert.equal(readDaemonReservation(endpoint),undefined);
 assert.equal(existsSync(profile.dataRoot),false);
 assert.deepEqual(selectDaemonEndpoint({profileAccessKey:identity.accessKey,explicitSocket:endpoint.socket}),endpoint);
 assert.throws(()=>selectDaemonEndpoint({profileAccessKey:identity.accessKey,explicitSocket:'http://127.0.0.1:1234'}),/invalid_endpoint/);
 assert.throws(()=>selectDaemonEndpoint({profileAccessKey:identity.accessKey,explicitSocket:'\\\\\\\\foreign\\\\pipe\\\\kite-daemon-owned'}),/invalid_endpoint/);
 const owner=await reserveDaemonEndpoint(endpoint,{profile:identity,instanceId:'original',buildId:'selected',workspace});
 assert.equal(readDaemonReservation(endpoint).pipe,undefined);
 await assert.rejects(()=>requestDaemonBootstrap(endpoint,identity),/not_ready/);
 assert.equal(existsSync(profile.dataRoot),false);
 await owner.listen({httpEndpoint:'http://127.0.0.1:1234',webOrigin:'http://127.0.0.1:1235',token:'x'.repeat(64)});
 assert.equal(readDaemonReservation(endpoint).pipe,endpoint.socket);
 assert.equal(events.indexOf('listen')<events.indexOf('publish'),true);
 assert.equal(Buffer.from(files.get(endpoint.record)).includes(Buffer.from('x'.repeat(64))),false);
 const bootstrap=await requestDaemonBootstrap(endpoint,identity);
 assert.equal(bootstrap.instanceId,'original');assert.equal(bootstrap.workspace,workspace);
 failReadAfterRequest=true;
 await assert.rejects(()=>requestDaemonBootstrap(endpoint,identity),error=>error instanceof DaemonEndpointCleanupError);
 failReadAfterRequest=false;
 const recordBeforeUnknown=readDaemonReservation(endpoint);failNextRead=true;
 assert.throws(()=>removeExactEndpoint(endpoint,recordBeforeUnknown,fileId),error=>error instanceof DaemonEndpointCleanupError);
 await assert.rejects(()=>requestDaemonBootstrap(endpoint,{...identity,name:'foreign'}),/identity_mismatch/);
 assert.equal(pipes.get(endpoint.socket).respond(Buffer.from('{"requestVersion":1,"requestId":"x","operation":"bootstrap","command":"run"}\\n')),null);
 const original=Buffer.from(files.get(endpoint.record));
 files.set(endpoint.record,Buffer.from(JSON.stringify({...JSON.parse(original),instanceId:'replacement'})+'\\n'));
 await assert.rejects(()=>requestDaemonBootstrap(endpoint,identity),/identity_mismatch/);
 files.set(endpoint.record,original);
 await owner.close();assert.equal(files.size,0);assert.equal(pipes.size,0);assert.equal(events.indexOf('pipe_close')<events.indexOf('remove'),true);
 const unknown=await reserveDaemonEndpoint(endpoint,{profile:identity,instanceId:'unknown',buildId:'selected',workspace});
 await unknown.listen({httpEndpoint:'http://127.0.0.1:1234',webOrigin:'http://127.0.0.1:1235',token:'y'.repeat(64)});
 refuseClose=true;const first=unknown.close();assert.equal(first,unknown.close());
 await assert.rejects(first,error=>error instanceof DaemonEndpointCleanupError);
 assert.equal(files.size,1);assert.equal(pipes.size,1);
 console.log('complete-windows-discovery-contract');
}finally {rmSync(workspace,{recursive:true,force:true});}
`;
  const result = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error));
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe('complete-windows-discovery-contract\n');
});

test('Windows daemon keeps an unconfirmed initial artifact admission before endpoint or Store access', () => {
  const source = (name: string) => resolve(import.meta.dir, '../../src', name);
  const code = `
import assert from 'node:assert/strict';
import {mock} from 'bun:test';
Object.defineProperty(process,'platform',{value:'win32'});
const original=new AggregateError([Error('original_native_close_failed')],'paired_artifact_close_unknown');
const retained=Error('retained_original_owner');let admissions=0,retentions=0;
mock.module(${JSON.stringify(source('windows-paired-artifact.ts'))},()=>({retainWindowsPairedArtifact(){admissions++;throw original;}}));
mock.module(${JSON.stringify(source('daemon/endpoint.ts'))},()=>({selectDaemonEndpoint(){throw Error('unexpected_endpoint_access');},reserveDaemonEndpoint(){throw Error('unexpected_endpoint_access');}}));
mock.module(${JSON.stringify(source('process-failure.ts'))},()=>({async retainFailedProcess(value){retentions++;assert.equal(value.code,'daemon_artifact_close_unknown');assert.equal(value.phase,'daemon_artifact');assert.equal(value.cause.error,original);throw retained;}}));
const {runDaemonProcess}=await import(${JSON.stringify(source('daemon-main.ts'))});
await assert.rejects(()=>runDaemonProcess(),error=>error===retained);
assert.equal(admissions,1);assert.equal(retentions,1);
console.log('initial-artifact-owner-retained');
`;
  const input = {
    operation: 'preflight',
    workspace: process.cwd(),
    web: { directory: process.cwd(), manifestSha256: 'a'.repeat(64) },
    startup: {
      profile: {
        dataRoot: process.cwd(),
        profile: 'default',
        profileAccessKey: 'b'.repeat(64),
      },
      instanceId: 'original-admission',
      buildId: 'selected',
      token: 'c'.repeat(64),
      runtimeProtection: {
        kind: 'terminal.candidate',
        root: process.cwd(),
        manifestSha256: 'd'.repeat(64),
      },
    },
  };
  const result = spawnSync(process.execPath, ['-e', code], {
    input: `${JSON.stringify(input)}\n`,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error));
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe('initial-artifact-owner-retained\n');
});
