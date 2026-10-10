import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = (name: string) => fileURLToPath(new URL(`../../../${name}`, import.meta.url));
function run(scenario: string) {
  const code = `
import {mock} from 'bun:test';import assert from 'node:assert/strict';import * as fs from 'node:fs';
const scenario=${JSON.stringify(scenario)},t='/z-terminal',n='/a-native',a='a'.repeat(64),b='b'.repeat(64),tid='c'.repeat(64);
Object.defineProperty(process,'platform',{value:'win32'});Object.defineProperty(process,'arch',{value:'x64'});
for(const k of ['NODE_PATH','NODE_OPTIONS','BUN_OPTIONS','BUN_BE_BUN','ELECTRON_RUN_AS_NODE'])delete process.env[k];
let exe=t+'/bin/terminal-verifier.exe',nativeCurrent=a,reads=0,spawned=0,closedChild=false,terminalAlive=false,nativeAlive=false,next=0;
const events=[],held=new Map(),reg={version:1,terminalPrefix:t,nativePrefix:n,candidateId:a,nonce:'d'.repeat(32)};
const resource=(type,path)=>{const base=type+':'+path,key=base+'#'+(++next),nativeOwner=exe===n+'/bin/native-verifier.exe';held.set(key,base);let released=false;return {verify(){assert.ok(held.has(key));},release(){if(released)return;if(nativeOwner?nativeAlive:terminalAlive)assert.fail('resource closed before actual exit:'+key);released=true;held.delete(key);events.push('release:'+base);}};};
mock.module('node:fs',()=>({...fs,realpathSync:p=>p===process.execPath?exe:p}));
const registry={readManagedCLIActive:p=>p===t?tid:nativeCurrent,readCLIRegistration(p,owned=false){reads++;if(scenario==='normal')return undefined;if(scenario==='nonce'&&owned)return {...reg,nonce:'e'.repeat(32)};return reg;},sameCLIRegistration(x,y){return JSON.stringify(x)===JSON.stringify(y);}};
mock.module(${JSON.stringify(source('apps/cli/host/cli-registration.ts'))},()=>registry);
mock.module(${JSON.stringify(source('apps/cli/host/windows-terminal-installation.ts'))},()=>({readWindowsTerminalInstallation:p=>({root:p}),retainWindowsTerminalFrontdoor:m=>resource('file',m.root+'/bin')}));
mock.module(${JSON.stringify(source('apps/cli/host/windows-native-installation.ts'))},()=>({readWindowsNativeInstallation:p=>({version:2,root:p}),retainWindowsNativeFrontdoor:m=>resource('file',m.root+'/bin')}));
mock.module(${JSON.stringify(source('packages/agent/src/platform/windows-installation-coordination.ts'))},()=>({windowsInstallationCoordination:p=>({...resource('coord',p),selectionLockPath:p+'/selection'})}));
mock.module(${JSON.stringify(source('packages/agent/src/platform/locks.ts'))},()=>({acquireFileLock(p,mode){assert.equal(mode,'shared');events.push('select:'+p);return resource('selection',p);}}));
mock.module(${JSON.stringify(source('packages/agent/src/artifact-access.ts'))},()=>({acquireArtifactAccess:({root,mode})=>{assert.equal(mode,'shared');return resource('use',root);}}));
const terminal={retainWindowsTerminalRuntimeFiles:r=>resource('file',r),verifyTerminalRuntimeBundle:r=>{events.push('verify-terminal:'+r);return {digest:tid,manifest:{entries:{runtime:'runtime/bun.exe'}}};},windowsTerminalRuntimeArguments:r=>['--no-env-file','--no-install','--config',r+'/runtime/windows-bunfig.toml','--tsconfig-override',r+'/runtime/windows-tsconfig.json']};
mock.module(${JSON.stringify(source('apps/service/src/runtime-assets.ts'))},()=>terminal);mock.module('@kite-ai/service/runtime-assets',()=>terminal);
const native={retainWindowsNativeRuntimeFiles:r=>resource('file',r),verifyNativeRuntimeBundle:r=>{events.push('verify-native:'+r);return {digest:a,terminal:{manifest:{entries:{runtime:'runtime/bun.exe'}}},manifest:{entries:{electron:'electron/electron.exe'}}};}};
mock.module(${JSON.stringify(source('apps/service/src/native-runtime-assets.ts'))},()=>native);mock.module('@kite-ai/service/native-runtime-assets',()=>native);
mock.module('@kite-ai/service/windows-native-bootstrap',()=>({retainWindowsNativeLaunchCertificate:async()=>resource('certificate','creator'),createWindowsNativeMainHandoff(){assert.fail('not desktop');}}));
const {runWindowsNativeVerifier,parseWindowsNativeSelection}=await import(${JSON.stringify(source('scripts/release/entrypoints/windows-native-verifier.ts'))});
const originalSpawn=Bun.spawn;
Bun.spawn=(cmd,options)=>{
spawned++;assert.equal(options.stdin,'inherit');assert.equal(options.stdout,'inherit');assert.equal(options.stderr,'inherit');
if(cmd[0]===n+'/bin/kite.exe'||cmd[0]===n+'/bin/kite-tui.exe'){
 assert.deepEqual(cmd,[n+'/bin/'+(scenario==='tui'?'kite-tui.exe':'kite.exe'),'--kite-native-candidate='+a,'version']);
 assert.ok([...held.values()].includes('file:'+n+'/bin'));assert.ok([...held.values()].includes('file:'+n+'/releases/'+a));assert.ok([...held.values()].includes('file:'+n+'/releases/'+a+'/terminal'));assert.ok([...held.values()].includes('use:'+n+'/releases/'+a));
 assert.equal([...held.values()].some(k=>k.startsWith('selection:')),false);
 terminalAlive=true;const child={pid:123,exitCode:null};
 child.exited=(async()=>{if(scenario==='drift')nativeCurrent=b;exe=n+'/bin/native-verifier.exe';
 let code;try{const selected=parseWindowsNativeSelection(cmd.slice(1));assert.deepEqual(selected,{argv:['version'],expectedCandidateId:a});code=await runWindowsNativeVerifier(scenario==='tui'?'tui':'cli',n,'certified-pipe',selected.argv,selected.expectedCandidateId);}
 catch(e){assert.equal(scenario,'drift');assert.equal(e.message,'cli_registration_changed');code=1;}
 finally{exe=t+'/bin/terminal-verifier.exe';closedChild=true;terminalAlive=false;child.exitCode=code??1;}return child.exitCode;})();return child;
}
assert.ok(cmd[0].endsWith('/runtime/bun.exe'));assert.equal(cmd.at(-1),'version');
const nativeChild=exe===n+'/bin/native-verifier.exe';if(nativeChild)nativeAlive=true;else terminalAlive=true;const child={pid:456,exitCode:null};child.exited=new Promise(resolve=>setTimeout(()=>{closedChild=true;if(nativeChild)nativeAlive=false;else terminalAlive=false;child.exitCode=0;resolve(0);},5));return child;
};
const {runWindowsTerminalVerifier}=await import(${JSON.stringify(source('scripts/release/entrypoints/windows-terminal-verifier.ts'))});
try{
 if(scenario==='nonce'){await assert.rejects(runWindowsTerminalVerifier('cli',t,['version']),/owner_mismatch/);assert.equal(spawned,0);}
 else if(scenario==='reserved'){await assert.rejects(runWindowsTerminalVerifier('cli',t,['--kite-native-candidate='+a]),/frontdoor_invalid/);assert.equal(spawned,0);}
 else{const code=await runWindowsTerminalVerifier(scenario==='tui'?'tui':'cli',t,['version']);assert.equal(code,scenario==='drift'?1:0);assert.equal(spawned,scenario==='normal'||scenario==='drift'?1:2);}
 assert.equal(held.size,0);
 if(scenario!=='normal'&&scenario!=='reserved'){const selected=events.filter(e=>e.startsWith('select:'));assert.deepEqual(selected.slice(0,3),['select:'+t+'/selection','select:'+n+'/selection','select:'+t+'/selection']);}
 assert.ok(scenario==='reserved'||events.includes('verify-terminal:'+t+'/releases/'+tid));
}finally{Bun.spawn=originalSpawn;}
`;
  const child = spawnSync(process.execPath, ['--eval', code], { encoding: 'utf8', timeout: 4000 });
  if (child.status !== 0)
    throw Error(
      `Windows registered verifier ${scenario} failed: ${child.error?.message ?? ''}\n${child.stderr}`,
    );
  expect(child.status).toBe(0);
}

test('Windows Terminal retains its normal verified closure and rejects reserved overrides', () => {
  run('normal');
  run('reserved');
});
test('Windows registered CLI and TUI enter the Native C frontdoor with exact candidate admission', () => {
  run('cli');
  run('tui');
});
test('Windows registered invocation rejects nonce drift and post-forward active drift', () => {
  run('nonce');
  run('drift');
});
