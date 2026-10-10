import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Actual compiler-child lifetime; Windows policy and PE input do not claim native qualification.
test('Windows launcher compiler stream failure waits for actual child exit despite a failed signal before closing pins or output', () => {
  const path = (name: string) => fileURLToPath(new URL(`../../../${name}`, import.meta.url));
  const code = `
import {mock} from 'bun:test';import assert from 'node:assert/strict';
import * as actualFs from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
const fs={...actualFs};
const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'kite-launcher-owned-'))),outdir=join(root,'new-output'),verifierPath=join(root,'verifier.exe');
const pe=Buffer.alloc(2048);pe.write('MZ');pe.writeUInt32LE(128,60);pe.write('PE\\0\\0',128);pe.writeUInt16LE(0x8664,132);pe.writeUInt16LE(1,134);pe.writeUInt16LE(240,148);
const optional=152;pe.writeUInt16LE(0x20b,optional);pe.writeUInt16LE(3,optional+68);pe.writeUInt32LE(16,optional+108);pe.writeUInt32LE(4096,optional+120);pe.writeUInt32LE(40,optional+124);pe.writeUInt32LE(4352,optional+192);pe.writeUInt32LE(80,optional+196);
const section=optional+240;pe.writeUInt32LE(4096,section+12);pe.writeUInt32LE(1536,section+16);pe.writeUInt32LE(512,section+20);pe.writeUInt32LE(4480,512+12);pe.writeUInt32LE(4640,512+16);pe.write('kernel32.dll\\0',896);pe.writeUInt32LE(80,768);pe.writeUInt16LE(0x800,846);fs.writeFileSync(verifierPath,pe);
const streamFailure=Error('original_compiler_stream_failure'),signalFailure=Error('original_compiler_signal_failure');
let actual,signals=0,exitObserved=false,releases=0;const events=[];
Object.defineProperty(process,'platform',{value:'win32'});Object.defineProperty(process,'arch',{value:'x64'});
mock.module('node:fs',()=>({...fs,rmSync(p,options){assert.ok(actual);assert.equal(actual.exitCode,0);assert.equal(exitObserved,true);events.push('rm:'+p);fs.rmSync(p,options);}}));
mock.module(${JSON.stringify(path('packages/agent/src/platform/windows-path-security.ts'))},()=>({defaultWindowsPathSecurity:()=>({}),privateDirectory(p){assert.equal(p,outdir);assert.equal(fs.existsSync(p),false);fs.mkdirSync(p);}}));
mock.module(${JSON.stringify(path('packages/agent/src/platform/windows-candidate-files.ts'))},()=>({retainWindowsCandidateFiles(p,files){assert.equal(p,root);assert.deepEqual(files,['verifier.exe']);return {verify(){},release(){assert.equal(actual.exitCode,0);assert.equal(exitObserved,true);releases++;events.push('pin-release');}};}}));
const originalSpawn=Bun.spawn;
Bun.spawn=new Proxy(originalSpawn,{apply(target,receiver,args){
 assert.equal(args[1].cwd,outdir);assert.equal(args[1].stdout,'pipe');assert.equal(args[1].stderr,'pipe');
 actual=Reflect.apply(target,receiver,[[process.execPath,'-e','setTimeout(() => process.exit(0), 150);'],args[1]]);
 actual.exited.then(code=>{assert.equal(code,0);exitObserved=true;events.push('actual-exit:0');});
 return new Proxy(actual,{get(child,key){if(key==='stderr')return new ReadableStream({start(controller){controller.error(streamFailure);}});if(key==='kill')return ()=>{signals++;assert.equal(child.exitCode,null);throw signalFailure;};const value=Reflect.get(child,key,child);return typeof value==='function'?value.bind(child):value;}});
}});
try {
 const {buildWindowsTerminalLauncher}=await import(${JSON.stringify(path('scripts/release/build-windows-terminal-launcher.ts'))});
 const started=performance.now();
 const error=await buildWindowsTerminalLauncher({outdir,verifierPath,verifierSha256:createHash('sha256').update(pe).digest('hex'),verifierSize:pe.length},fs.realpathSync(process.execPath)).catch(e=>e);
 assert.equal(error,streamFailure);assert.equal(signals,1);assert.equal(await actual.exited,0);assert.equal(actual.exitCode,0);assert.ok(performance.now()-started>=100);
 assert.equal(releases,1);assert.equal(events[0],'actual-exit:0');assert.equal(events[1],'pin-release');assert.equal(events.filter(e=>e.startsWith('rm:')).length,4);assert.equal(events.at(-1),'rm:'+outdir);assert.equal(fs.existsSync(outdir),false);assert.deepEqual(fs.readFileSync(verifierPath),pe);
 assert.equal(await new Response(actual.stderr).text(),'');
}finally{
 Bun.spawn=originalSpawn;
 if(actual&&actual.exitCode===null){actual.kill('SIGKILL');await actual.exited;}
 if(!actual||actual.exitCode!==null)fs.rmSync(root,{recursive:true,force:true});
}
`;
  const child = spawnSync(process.execPath, ['--eval', code], { encoding: 'utf8', timeout: 4000 });
  if (child.status !== 0)
    throw Error(
      `Windows compiler ownership fixture failed: ${child.error?.message ?? ''}\n${child.stderr}`,
    );
  expect(child.status).toBe(0);
});
