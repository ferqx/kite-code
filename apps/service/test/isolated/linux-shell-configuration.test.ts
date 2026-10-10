import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The subprocess isolates both platform selection and public factory spies.
// Actual Linux namespace/seccomp/FFI execution belongs to native qualification.
test('Linux Service Shell and Workflow bind verified assets, final policy and distinct Skill/Workspace scopes without group fallback', () => {
  const shell = fileURLToPath(new URL('../../src/shell-configuration.ts', import.meta.url));
  const workflow = fileURLToPath(
    new URL('../../src/skill-workflow-configuration.ts', import.meta.url),
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
const calls=[],starts=[]; let ffiCalls=0;
const factory=kind=>options=>{
 calls.push({kind,options});
 return {id:'shell.command',version:'1',inputSchema:{type:'object'},resources:{slot:'process'},
  async start(input,context){starts.push({kind,input,context});return {reference:{kind:'test-only-factory',executionId:context.executionId}};},
  async *observe(){yield {type:'terminal',result:{outcome:'succeeded',content:'pure assembly'},supervision:'ended'};},
  async cancel(){return {status:'already_finished'};},async dispose(){}};
};
mock.module('@kite-ai/agent/jobs/shell',()=>({...publicJobs,
 createLinuxHostShellJob:factory('linux-host'),createLinuxConfinedShellJob:factory('linux-confined'),
 createMacosHostShellJob:()=>{throw Error('unexpected_macos_host');},
 createMacosConfinedShellJob:()=>{throw Error('unexpected_macos_confined');},
 createShellJob:()=>{throw Error('unexpected_group_fallback');}}));
mock.module('bun:ffi',()=>({dlopen(){ffiCalls++;throw Error('unexpected_native_ffi');}}));
Object.defineProperty(process,'platform',{value:'linux'});
const {selectProfile}=await import('@kite-ai/agent/profile');
const {createShellConfiguration,inspectShellAssets,hostFilesystemScope}=await import(${JSON.stringify(shell)});
const {createWorkflowConfiguration}=await import(${JSON.stringify(workflow)});
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
 host:{controlBase:control,protectedRoots:[profile.dataRoot,profile.coordinationPath],readonlyAssets:[assetsRoot],runtimeReadOnlyRoots:[assetsRoot]}};
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
 assert.equal(binding.snapshot.qualification,'linux_owned_pid_namespace_bubblewrap');
 assert.equal(binding.snapshot.scope,'final_dispatch_authorization');
 assert.deepEqual(binding.snapshot.assets.bubblewrap,original[3]);
 assert.deepEqual(calls[0].options.linux,{bubblewrapPath:options.linux.bubblewrapPath,initExecutable:options.supervisorPath});
 assert.equal(calls[0].options.cwd,workspace);
 assert.deepEqual(calls[0].options.protectedRoots,options.host.protectedRoots);
 const scope=calls[0].options.filesystemScope;
 assert.equal(scope(context(leaf('full'))),'full_access');
 assert.equal(scope(context(intersection(leaf('full'),leaf('full')))),'full_access');
 assert.equal(scope(context(intersection(leaf('full'),leaf('ask')))),'workspace_write');
 assert.equal(scope(context(intersection(leaf('accept_edits'),leaf('full')))),'workspace_write');
 assert.throws(()=>scope(context(leaf('full','skill.workflow.verify'))),/shell_dispatch_scope_unavailable/);
 assert.throws(()=>hostFilesystemScope(context({...leaf('full'),data:{...leaf('full').data,workspaceTrust:false}})),/shell_dispatch_scope_unavailable/);
 const job=binding.extensions[0].jobs[0];
 const handle=await job.start({command:'printf complete'},context(leaf('full')));
 assert.equal(starts.length,1);assert.equal(starts[0].kind,'linux-host');await job.dispose(handle);
 const bwrapBytes=readFileSync(options.linux.bubblewrapPath);writeFileSync(options.linux.bubblewrapPath,'changed');
 await assert.rejects(job.start({command:'never'},context(leaf('full'))),/shell_asset_changed/);
 assert.equal(starts.length,1);writeFileSync(options.linux.bubblewrapPath,bwrapBytes);
 for(const missing of ['host','linux']){const value={...options};delete value[missing];await assert.rejects(createShellConfiguration({workspaceRoot:workspace,toolIds:['shell.launch'],options:value}),/shell_platform_unqualified/);}
 assert.equal(calls.length,1);
 const skill=join(workspace,'skill');mkdirSync(skill);
 const manifest={name:'fixture',version:'1.0.0',description:'Original declared Linux Workflow',
 invocation:{allow_manual:true,allow_implicit:false},context:{mode:'inline',agent:'code'},input_schema:{type:'object'},output_schema:{type:'object'},
 capabilities:{require:[],deny:[]},effects:{filesystem:'write',network:'none',external_state:'none'},approval:{minimum:'user'},
 execution:{timeout_ms:3000,max_attempts:1},verification:{mode:'required',strategy:'script',entrypoint:'check.ts',timeout_ms:3000},
 recovery:{retry:'never',compensation:'compensate.ts'}};
 writeFileSync(join(skill,'SKILL.md'),'---\\n'+JSON.stringify(manifest)+'\\n---\\nOriginal instructions\\n');
 writeFileSync(join(skill,'check.ts'),'// original verifier');writeFileSync(join(skill,'compensate.ts'),'// original compensation');
 writeFileSync(join(skill,'binary.bin'),Buffer.from([0,255,128,1]));
 const flags={skillActivation:true,skillWorkflow:true,verification:true};
 const workflowOptions={profile,workspaceRoot:workspace,skills:[{id:'configured',path:'skill'}],toolIds:[],allowedCapabilities:[],flags,shell:options,
 userDecisions:{version:'1',allowWaiver:false,allowReplan:false,allowCompensation:true},request:{},capabilities:[],forkConfigurations:[]};
 const configured=await createWorkflowConfiguration(workflowOptions);
 assert.equal(configured.entries.length,1);
 assert.equal(configured.snapshot.compensator.backend,'linux-bubblewrap-pid-namespace');
 assert.deepEqual(configured.snapshot.verifier.assets,original);
 const entry=configured.entries[0],output={},outputDigest=createHash('sha256').update('{}').digest('hex');
 const verification={skillId:entry.descriptor.capabilityId,revision:entry.descriptor.revision,activationId:'original',attempt:1,outputDigest,output};
 const verifier=configured.verifierExtension.jobs[0];
 const verifierHandle=await verifier.start(verification,context(leaf('ask','skill.workflow.verify'),'verify'));
 const verifyCall=calls.at(-1);assert.equal(verifyCall.kind,'linux-host');
 assert.equal(verifyCall.options.cwd,skill);assert.notEqual(verifyCall.options.cwd,workspace);
 assert.equal(verifyCall.options.workspaceRoot,workspace);
 assert.deepEqual(verifyCall.options.protectedRoots,options.host.protectedRoots);
 assert.equal(verifyCall.options.filesystemScope(context(intersection(leaf('full','skill.workflow.verify'),leaf('ask','skill.workflow.verify')))),'workspace_write');
 assert.equal(verifyCall.options.filesystemScope(context(leaf('full','skill.workflow.verify'))),'full_access');
 assert.throws(()=>verifyCall.options.filesystemScope(context(leaf('full'))),/shell_dispatch_scope_unavailable/);
 assert.ok(starts.at(-1).input.command.includes(options.bunExecutable));assert.ok(starts.at(-1).input.command.includes('check.ts'));
 await verifier.dispose(verifierHandle);
 const compensator=configured.compensatorExtension.jobs[0];
 const compensationHandle=await compensator.start({...verification,decisionKey:'original-decision',decisionDigest:'a'.repeat(64)},context(leaf('ask','skill.workflow.compensate'),'compensate'));
 const compensateCall=calls.at(-1);assert.equal(compensateCall.kind,'linux-confined');
 assert.equal(compensateCall.options.cwd,workspace);
 assert.deepEqual(compensateCall.options.protectedRoots,[profile.dataRoot,profile.coordinationPath]);
 assert.equal(compensateCall.options.bubblewrapPath,options.linux.bubblewrapPath);
 assert.deepEqual(compensateCall.options.linux,{bubblewrapPath:options.linux.bubblewrapPath,initExecutable:options.supervisorPath});
 const sealed=compensateCall.options.runtimeReadOnlyRoots[0];
 assert.notEqual(sealed,skill);assert.ok(sealed.startsWith(temporary+'/'));
 assert.deepEqual(readFileSync(join(sealed,'binary.bin')),readFileSync(join(skill,'binary.bin')));
 assert.equal(readFileSync(join(sealed,'compensate.ts'),'utf8'),'// original compensation');
 assert.deepEqual(compensateCall.options.env,{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'});
 await compensator.dispose(compensationHandle);assert.equal(existsSync(sealed),false);
 const count=starts.length;writeFileSync(options.supervisorPath,'changed init');
 const rejected=await verifier.start(verification,context(leaf('full','skill.workflow.verify'),'changed'));
 assert.equal(rejected.reference.kind,'startup_rejected');assert.equal(starts.length,count);
 const events=[];for await(const event of verifier.observe(rejected))events.push(event);
 assert.equal(events[0].result.details.code,'workflow_verifier_asset_changed');assert.equal(events[0].result.details.started,false);
 await verifier.dispose(rejected);
 await assert.rejects(createWorkflowConfiguration({...workflowOptions,request:{extensionInputs:[{extensionId:'foreign',definitionVersion:'1',input:{}}]}}),/workflow_extension_input_unavailable/);
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
    factoryKinds: ['linux-host', 'linux-host', 'linux-confined'],
    starts: 3,
    ffiCalls: 0,
  });
});
