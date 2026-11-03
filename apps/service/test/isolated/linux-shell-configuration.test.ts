import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The subprocess isolates both platform selection and public factory spies.
// Actual Linux namespace/seccomp/FFI execution belongs to native qualification.
test('Linux Service Shell binds verified assets and final policy without group fallback', () => {
  const shell = fileURLToPath(import.meta.resolve('@kite-ai/agent/permissions/shell'));
  const search = fileURLToPath(
    new URL('../../../../packages/agent/src/jobs/ripgrep.ts', import.meta.url),
  );
  const hostStatus = fileURLToPath(new URL('../../src/host-status.ts', import.meta.url));
  const code = `
import {mock} from 'bun:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,chmodSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const publicJobs=await import('@kite-ai/agent/jobs/shell');
const search=await import(${JSON.stringify(search)});
// This fixture simulates Linux assembly, not a Linux binary installation.
const searchAsset=search.ripgrepAsset();
mock.module(${JSON.stringify(search)},()=>({...search,ripgrepAsset:()=>searchAsset}));
const calls=[],starts=[]; let ffiCalls=0;
const factory=kind=>options=>{
 calls.push({kind,options});
 return {id:'shell.command',version:'1',inputSchema:{type:'object'},resources:{slot:'process'},
  async start(input,context){starts.push({kind,input,context});return {reference:{kind:'test-only-factory',executionId:context.executionId}};},
  async *observe(){yield {type:'terminal',result:{outcome:'succeeded',content:'pure assembly'},supervision:'ended'};},
  async cancel(){return {status:'already_finished'};},async dispose(){}};
};
mock.module('@kite-ai/agent/jobs/shell',()=>({...publicJobs,
 ripgrepAsset:()=>searchAsset,
 createLinuxHostShellJob:factory('linux-host'),createLinuxConfinedShellJob:factory('linux-confined'),
 createMacosHostShellJob:()=>{throw Error('unexpected_macos_host');},
 createMacosConfinedShellJob:()=>{throw Error('unexpected_macos_confined');},
 createShellJob:()=>{throw Error('unexpected_group_fallback');}}));
mock.module('bun:ffi',()=>({dlopen(){ffiCalls++;throw Error('unexpected_native_ffi');}}));
Object.defineProperty(process,'platform',{value:'linux'});
const {selectProfile}=await import('@kite-ai/agent/profile');
const {createShellConfiguration,inspectShellAssets,hostFilesystemScope}=await import(${JSON.stringify(shell)});
const {createDefaultHostStatusSource}=await import(${JSON.stringify(hostStatus)});
const root=realpathSync(mkdtempSync(join(tmpdir(),'kite-linux-service-assembly-')));
const workspace=join(root,'workspace'),assetsRoot=join(root,'assets'),control=join(root,'control'),temporary=join(root,'temporary');
const profile=selectProfile({dataRoot:join(root,'data'),profile:'fixture'});
for(const path of [workspace,assetsRoot,control,temporary,profile.profilePath,profile.coordinationPath])mkdirSync(path,{recursive:true,mode:0o700});
process.env.TMPDIR=temporary;
const makeAsset=name=>{const path=join(assetsRoot,name);writeFileSync(path,'original '+name);chmodSync(path,0o700);return path;};
const options={platform:'linux',configurationId:'linux-fixture',env:{PATH:'/usr/bin:/bin',FIXED_VALUE:'original'},
 supervisorPath:makeAsset('linux-shell-init'),bunExecutable:makeAsset('bun'),shellExecutable:makeAsset('sh'),
 linux:{bubblewrapPath:makeAsset('bwrap')},graceMs:20,maxQueuedBytes:4096,
 host:{controlBase:control,protectedRoots:[profile.dataRoot,profile.coordinationPath],protectedFiles:[join(root,'codex','auth.json')],readonlyAssets:[assetsRoot],runtimeReadOnlyRoots:[assetsRoot]}};
const leaf=(mode,id='shell.command')=>({namespace:'builtin.permissions',version:'1',data:{workspaceTrust:true,mode,capability:{kind:'job',definitionId:id,definitionVersion:'1',hardAllowed:true}}});
const intersection=(left,right)=>({namespace:'agent.permission-intersection',version:'1',data:{policies:[{scope:'parent',revision:'p',allowed:true,snapshot:left},{scope:'child',revision:'c',allowed:true,snapshot:right}]}});
const context=(snapshot,id='execution')=>({sessionId:'s',executionId:id,signal:new AbortController().signal,dispatchAuthorization:{revision:'accepted',snapshot}});
try {
 const original=await inspectShellAssets(options);
 assert.equal(original.length,4);
 assert.deepEqual(original.map(a=>a.path),[options.supervisorPath,options.bunExecutable,options.shellExecutable,options.linux.bubblewrapPath]);
 for(const asset of original)assert.equal(asset.digest,createHash('sha256').update(readFileSync(asset.path)).digest('hex'));
 const status=await createDefaultHostStatusSource({shell:options}).snapshot({subjectId:'owned',storeId:null});
 assert.deepEqual(status.execution.shell,{configured:true,available:true,supervision:'linux_pid_namespace',qualification:'linux_host_boundary_unqualified',reason:null});
 assert.deepEqual(status.execution.sandbox,{backend:'linux_bubblewrap',available:true,qualification:'host_scope_unqualified'});
 assert.equal(status.release.production,null);assert.equal(status.release.active,false);assert.equal(calls.length,0);assert.equal(starts.length,0);assert.equal(ffiCalls,0);
 const binding=await createShellConfiguration({workspaceRoot:workspace,toolIds:['shell.launch','shell.read'],options});
 assert.equal(calls.length,1);assert.equal(calls[0].kind,'linux-host');
 assert.equal(binding.snapshot.qualification,'linux_owned_pid_namespace_bubblewrap_private_directories');
 assert.equal(binding.snapshot.scope,'final_dispatch_authorization');
 assert.deepEqual(binding.snapshot.assets.bubblewrap,original[3]);
 assert.deepEqual(calls[0].options.linux,{bubblewrapPath:options.linux.bubblewrapPath,initExecutable:options.supervisorPath});
 assert.equal(calls[0].options.cwd,workspace);
 assert.deepEqual(calls[0].options.protectedRoots,options.host.protectedRoots);
 assert.deepEqual(calls[0].options.protectedFiles,options.host.protectedFiles);
 assert.deepEqual(binding.snapshot.host.protectedFiles,options.host.protectedFiles);
 const scope=calls[0].options.filesystemScope;
 assert.equal(scope(context(leaf('full'))),'full_access');
 assert.equal(scope(context(intersection(leaf('full'),leaf('full')))),'full_access');
 assert.equal(scope(context(intersection(leaf('full'),leaf('accept_edits')))),'workspace_write');
 assert.equal(scope(context(intersection(leaf('accept_edits'),leaf('full')))),'workspace_write');
 assert.throws(()=>scope(context(leaf('full','foreign.job'))),/shell_dispatch_scope_unavailable/);
 assert.throws(()=>hostFilesystemScope(context({...leaf('full'),data:{...leaf('full').data,workspaceTrust:false}})),/shell_dispatch_scope_unavailable/);
 const job=binding.extensions[0].jobs[0];
 const handle=await job.start({command:'printf complete'},context(leaf('full')));
 assert.equal(starts.length,1);assert.equal(starts[0].kind,'linux-host');await job.dispose(handle);
 const bwrapBytes=readFileSync(options.linux.bubblewrapPath);writeFileSync(options.linux.bubblewrapPath,'changed');
 await assert.rejects(job.start({command:'never'},context(leaf('full'))),/shell_asset_changed/);
 assert.equal(starts.length,1);writeFileSync(options.linux.bubblewrapPath,bwrapBytes);
 for(const missing of ['host','linux']){const value={...options};delete value[missing];await assert.rejects(createShellConfiguration({workspaceRoot:workspace,toolIds:['shell.launch'],options:value}),/shell_platform_unqualified/);}
 assert.equal(calls.length,1);
 assert.equal(ffiCalls,0);
 console.log(JSON.stringify({factoryKinds:calls.map(c=>c.kind),starts:starts.length,ffiCalls,scope:'pure Service factory assembly, not Linux native qualification'}));
} finally {rmSync(root,{recursive:true,force:true});}
`;
  const child = spawnSync(process.execPath, ['--eval', code], {
    encoding: 'utf8',
    timeout: 4000,
  });
  if (child.status !== 0)
    throw new Error(
      `Linux Service assembly failed: ${child.error?.message ?? ''}\n${child.stderr}`,
    );
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout.trim())).toMatchObject({
    factoryKinds: ['linux-host'],
    starts: 1,
    ffiCalls: 0,
  });
});
