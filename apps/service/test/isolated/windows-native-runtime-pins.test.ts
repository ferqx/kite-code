import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Windows Native outer manifest, files and empty directories remain owned before consumer leases release', () => {
  const module = fileURLToPath(new URL('../../src/native-runtime-assets.ts', import.meta.url));
  const paired = fileURLToPath(new URL('../../src/windows-paired-artifact.ts', import.meta.url));
  const protection = fileURLToPath(new URL('../../src/runtime-protection.ts', import.meta.url));
  const terminal = fileURLToPath(new URL('../../src/runtime-assets.ts', import.meta.url));
  const sqlite = fileURLToPath(
    new URL('../../../../tests/fixtures/unified-agent/sqlite-engine-fixture.ts', import.meta.url),
  );
  const code = `
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureNativeSqlite } from ${JSON.stringify(sqlite)};
const root=mkdtempSync(join(tmpdir(),'kite-native-outer-pin-'));
const calls=[],live=new Set();let failRelease=false, innerAcquireUnknown=false;
// Initialize the CJS module cache before mocking the explicit lazy require boundary.
require('@kite-ai/agent/artifact-access');
mock.module('@kite-ai/agent/artifact-access',()=>({
 retainWindowsCandidateFiles(path,files){
  const pin={path,files:[...files],verify(){assert.ok(live.has(pin));},release(){if(failRelease && files.includes('native-manifest.json'))throw Error('close_unknown');live.delete(pin);calls.push(['close',path,files]);}};
  live.add(pin);calls.push(['pin',path,files]);
  return pin;
 },
 acquireArtifactAccess({root}){calls.push(['lease',root]);return {release(){calls.push(['lease-close',root]);}};}
}));
const {nativeBundleEntries,retainWindowsNativeRuntimeFiles}=await import(${JSON.stringify(module)});
const entries=nativeBundleEntries('win32');
const manifest={version:1,apiMajor:1,target:{platform:'win32',arch:'x64'},electronVersion:'44.3.0',sqlite:fixtureNativeSqlite,terminalRoot:'terminal',terminalManifestSha256:'a'.repeat(64),entries,
files:[...Object.values(entries),'electron/version','.use-terminal.lock','app/native-verifier.exe','app/kite.exe','app/kite-tui.exe','app/kite-desktop.exe'].map(path=>({path,size:0,sha256:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',mode:path==='.use-terminal.lock'?384:path===entries.electron?493:420})),links:[],directories:['electron/empty']};
mkdirSync(join(root,'electron/empty'),{recursive:true});mkdirSync(join(root,'terminal'));
const save=()=>writeFileSync(join(root,'native-manifest.json'),JSON.stringify(manifest));save();
Object.defineProperty(process,'platform',{value:'win32'});Object.defineProperty(process,'arch',{value:'x64'});
try {
 const original=retainWindowsNativeRuntimeFiles(root);assert.equal(live.size,3);
 assert.deepEqual(calls.filter(c=>c[0]==='pin').map(c=>[c[1],c[2]]),[[root,['native-manifest.json']],[root,manifest.files.map(f=>f.path)],[join(root,'electron/empty'),[]]]);
 original.verify();writeFileSync(join(root,'electron/empty/unexpected'),'x');assert.throws(()=>original.verify(),/identity_mismatch/);rmSync(join(root,'electron/empty/unexpected'));
 failRelease=true;assert.throws(()=>original.release(),/close_unknown/);assert.equal(live.size,1);
 failRelease=false;original.release();assert.equal(live.size,0);
 manifest.links=[{path:'electron/current',target:'version'}];save();assert.throws(()=>retainWindowsNativeRuntimeFiles(root),/link_invalid/);assert.equal(live.size,0);manifest.links=[];save();
 mock.module(${JSON.stringify(protection)},()=>({parseRuntimeProtection:value=>value,runtimeProtectionRoots:proof=>[proof.root,join(proof.root,'terminal')],verifyRuntimeProtection(){calls.push(['verified']);}}));
 mock.module(${JSON.stringify(terminal)},()=>({retainWindowsTerminalRuntimeFiles(path){if(innerAcquireUnknown)throw Error('artifact_scope_release_failed');calls.push(['inner',path]);return {verify(){},release(){calls.push(['inner-close',path]);}};},windowsTerminalRuntimeArguments:()=>['fixed']}));
 const {retainWindowsPairedArtifact}=await import(${JSON.stringify(paired)});
 const access=retainWindowsPairedArtifact({kind:'native.candidate',root,manifestSha256:'a'.repeat(64)},{entrypoint:'original',executable:'original',buildId:'original'});
 assert.equal(live.size,3);failRelease=true;assert.throws(()=>access.release(),/close_unknown/);
 assert.equal(calls.filter(c=>c[0]==='lease-close').length,0);assert.equal(live.size,1);
 failRelease=false;access.release();assert.equal(live.size,0);assert.equal(calls.filter(c=>c[0]==='lease-close').length,2);
 innerAcquireUnknown=true;assert.throws(()=>retainWindowsPairedArtifact({kind:'native.candidate',root,manifestSha256:'a'.repeat(64)},{entrypoint:'original',executable:'original',buildId:'original'}),/paired_artifact_close_unknown/);assert.equal(live.size,3);assert.equal(calls.filter(c=>c[0]==='lease-close').length,2);
} finally {rmSync(root,{recursive:true,force:true});}
`;
  const child = spawnSync(process.execPath, ['--eval', code], { encoding: 'utf8', timeout: 4000 });
  if (child.status !== 0)
    throw Error(`Native outer pin mock failed: ${child.error?.message ?? ''}\n${child.stderr}`);
  expect(child.status).toBe(0);
});

test('actual Node reads complete Windows outer and inner content without native ownership or Bun FFI', () => {
  const native = fileURLToPath(new URL('../../src/native-runtime-assets.ts', import.meta.url));
  const terminal = fileURLToPath(new URL('../../src/runtime-assets.ts', import.meta.url));
  const sqlite = fileURLToPath(
    new URL('../../../../tests/fixtures/unified-agent/sqlite-engine-fixture.ts', import.meta.url),
  );
  const code = `
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fixtureTerminalSqlite,fixtureNativeSqlite} from ${JSON.stringify(sqlite)};
import {terminalBundleEntries} from ${JSON.stringify(terminal)};
import {nativeBundleEntries} from ${JSON.stringify(native)};
const parent=realpathSync(mkdtempSync(join(tmpdir(),'kite-node-native-content-'))),root=join(parent,'candidate');mkdirSync(root);mkdirSync(join(root,'terminal'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
Object.defineProperty(process,'platform',{value:'win32'});Object.defineProperty(process,'arch',{value:'x64'});
try {
 const innerRoot=join(root,'terminal'),innerFiles=[],innerEntries=terminalBundleEntries('win32');
 for(const path of Object.values(innerEntries)){mkdirSync(dirname(join(innerRoot,path)),{recursive:true});const bytes=Buffer.from(path);writeFileSync(join(innerRoot,path),bytes);innerFiles.push({path,size:bytes.length,sha256:sha(bytes),mode:path===innerEntries.runtime?493:420});}
 const inner={version:1,apiMajor:1,target:{platform:'win32',arch:'x64'},bunVersion:'1.4.2',sqlite:fixtureTerminalSqlite(innerRoot,innerFiles),productVersion:'1.0.0',source:{commit:'a'.repeat(40),dirty:true},entries:innerEntries,files:innerFiles,links:[]};
 const innerBytes=Buffer.from(JSON.stringify(inner));writeFileSync(join(innerRoot,'terminal-manifest.json'),innerBytes);
 const outerEntries=nativeBundleEntries('win32'),files=[];
 for(const path of [...Object.values(outerEntries),'electron/version','.use-terminal.lock']){mkdirSync(dirname(join(root,path)),{recursive:true});const bytes=Buffer.from(path==='.use-terminal.lock'?'':path==='electron/version'?'44.3.0':path===outerEntries.package?JSON.stringify({name:'kite-native',version:'0.1.0',main:'main.cjs'}):path);writeFileSync(join(root,path),bytes);files.push({path,size:bytes.length,sha256:sha(bytes),mode:path==='.use-terminal.lock'?384:path===outerEntries.electron?493:420});}
 mkdirSync(join(root,'electron/empty'));const outer={version:1,apiMajor:1,target:{platform:'win32',arch:'x64'},electronVersion:'44.3.0',sqlite:fixtureNativeSqlite,terminalRoot:'terminal',terminalManifestSha256:sha(innerBytes),entries:outerEntries,files,links:[],directories:['electron/empty']};writeFileSync(join(root,'native-manifest.json'),JSON.stringify(outer));
 const entry=join(parent,'reader.ts');writeFileSync(entry,'export {readNativeRuntimeBundleContent,verifyNativeRuntimeBundle} from '+JSON.stringify(${JSON.stringify(native)})+';export {readTerminalRuntimeBundleContent} from '+JSON.stringify(${JSON.stringify(terminal)})+';');
 const built=await Bun.build({entrypoints:[entry],outdir:parent,target:'node',format:'cjs',external:['bun:ffi']});assert.equal(built.success,true);
 const nodeCode=\`const assert=require('node:assert/strict');const fs=require('node:fs');require('node:path');Object.defineProperty(process,'platform',{value:'win32'});Object.defineProperty(process,'arch',{value:'x64'});const api=require(process.argv[1]);const root=process.argv[2];const outer=api.readNativeRuntimeBundleContent(root);const inner=api.readTerminalRuntimeBundleContent(root+'/terminal');assert.equal(outer.terminal.digest,inner.digest);assert.equal(outer.manifest.files.length,Number(process.argv[3]));assert.deepEqual(outer.manifest.directories,['electron/empty']);const file=root+'/app/main.cjs',bytes=fs.readFileSync(file);bytes[0]^=1;fs.writeFileSync(file,bytes);assert.throws(()=>api.readNativeRuntimeBundleContent(root),/identity_mismatch/);\`;
 const node=spawnSync('node',['-e',nodeCode,built.outputs[0].path,root,String(files.length)],{encoding:'utf8',timeout:2000});assert.equal(node.status,0,node.stderr);
} finally {rmSync(parent,{recursive:true,force:true});}
`;
  const child = spawnSync(process.execPath, ['--eval', code], { encoding: 'utf8', timeout: 4000 });
  if (child.status !== 0)
    throw Error(`Node content reader failed: ${child.error?.message ?? ''}\n${child.stderr}`);
  expect(child.status).toBe(0);
});
