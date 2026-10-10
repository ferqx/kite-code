import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const modulePath = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
function subprocess(scenario: string) {
  const child = spawnSync(process.execPath, ['-e', script(scenario)], {
    encoding: 'utf8',
    timeout: 4000,
  });
  if (child.error || child.status !== 0)
    process.stderr.write(child.stderr || `${String(child.error ?? child.signal)}\n`);
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stderr).toBe('');
  expect(child.stdout).toBe('archive-owner-confirmed\n');
}
// These trusted-port cases exercise the actual archive consumer, not Windows kernel qualification.
test('Windows Native pack holds both manifests and complete file pins through async compression', () => {
  subprocess('pack');
});
test('Windows Native failed publication keeps all original source owners', () => {
  subprocess('unknown');
});
test('Windows Native unpack preserves large exact bytes and rejects links before materialization', () => {
  subprocess('unpack');
});
function script(scenario: string) {
  return `
import {mock} from 'bun:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
Object.defineProperty(process,'platform',{value:'win32'});
mock.module('node:path',()=>({...path,...path.posix}));
const scenario=${JSON.stringify(scenario)}, root='/source', dest='/output', payload=Buffer.alloc(9*1024*1024+17,97), events=[], retained=new Set();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const terminal={files:[{path:'main.js',size:3,sha256:hash(Buffer.from('end')),mode:420}],links:[]};
const terminalBytes=Buffer.from(JSON.stringify(terminal));
const manifest={files:[{path:'app/payload',size:payload.length,sha256:hash(payload),mode:420}],links:[],directories:['electron/empty'],terminalManifestSha256:hash(terminalBytes)};
const nativeBytes=Buffer.from(JSON.stringify(manifest));
const archiveFiles=new Map([['native-manifest.json',nativeBytes],['terminal/terminal-manifest.json',terminalBytes],['app/payload',payload],['terminal/main.js',Buffer.from('end')]]);
const files=new Map([...archiveFiles].map(([name,bytes])=>[root+'/'+name,bytes])), directories=new Set([root,'/','/source/app','/source/terminal','/archives']);
const primary=Error('original-publication-close-unknown');
mock.module('node:fs',()=>({...fs,
  lstatSync(p,options){if(files.has(p))return{isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false,nlink:1,size:files.get(p).length};if(directories.has(p))return{isDirectory:()=>true,isFile:()=>false,isSymbolicLink:()=>false};if(options?.throwIfNoEntry===false)return undefined;throw Error('unexpected path:'+p);},
  readFileSync:p=>{assert.ok(files.has(p));return files.get(p);},
  rmSync(){throw Error('Windows must not path-delete');},
  mkdirSync(){throw Error('Windows must create private directories');},
}));
const security={
  writePrivateFile(){throw Error('8MiB private writer cannot hold Native artifacts');},
  writePrivateArtifactFile(p,bytes){assert.equal(files.has(p),false);files.set(p,Buffer.from(bytes));events.push('write:'+p);if(scenario==='unknown')throw primary;},
  syncPrivateFile(p){assert.ok(files.has(p));events.push('flush:'+p);},
};
mock.module(${JSON.stringify(modulePath('packages/agent/src/platform/windows-path-security.ts'))},()=>({
  defaultWindowsPathSecurity:()=>security,
  privateDirectory(p){let current=p;while(!directories.has(current)){directories.add(current);current=path.posix.dirname(current);}events.push('directory:'+p);},
}));
const retain=name=>{assert.equal(retained.has(name),false);retained.add(name);return{verify(){assert.ok(retained.has(name));},release(){assert.ok(retained.delete(name));events.push('close:'+name);}}};
mock.module('@kite-ai/agent/artifact-access',()=>({acquireArtifactAccess:({root})=>retain('lease:'+root)}));
const verified=p=>({root:p,digest:hash(nativeBytes),manifest,terminal:{digest:hash(terminalBytes),manifest:terminal}});
mock.module('@kite-ai/service/native-runtime-assets',()=>({
  parseNativeBundleManifest:value=>value,
  retainWindowsNativeRuntimeFiles:p=>retain('files:'+p),
  verifyNativeRuntimeBundle:p=>{if(p===dest){assert.equal(files.get(dest+'/app/payload').length,payload.length);assert.ok(files.get(dest+'/app/payload').equals(payload));assert.ok(directories.has(dest+'/electron/empty'));}return verified(p);},
}));
mock.module('@kite-ai/service/runtime-assets',()=>({parseTerminalBundleManifest:value=>value,retainWindowsTerminalRuntimeFiles:p=>retain('files:'+p)}));
mock.module(${JSON.stringify(modulePath('scripts/release/terminal-archive.ts'))},()=>({readCandidateArchiveFiles:()=>archiveFiles}));
mock.module(${JSON.stringify(modulePath('scripts/release/terminal-paths.ts'))},()=>({rejectBundleOutput(){}}));
mock.module(${JSON.stringify(modulePath('packages/agent/src/platform/windows-installation-removal.ts'))},()=>({retainWindowsInstallationRemoval({root,inventory}){return{
  verify(){},remove(){assert.deepEqual(inventory.map(item=>root+'/'+item.path).sort(),[...files.keys(),...directories].filter(p=>p.startsWith(root+'/')).sort());for(const item of inventory){files.delete(root+'/'+item.path);directories.delete(root+'/'+item.path);}directories.delete(root);events.push('original-tree-delete');},release(){events.push('original-tree-close');}
};}}));
mock.module(${JSON.stringify(modulePath('packages/agent/src/platform/windows-private-file-removal.ts'))},()=>({retainWindowsPrivateFileRemoval(){throw Error('unexpected failed pack cleanup');}}));
const OriginalArchive=Bun.Archive;
Bun.Archive=class{
  constructor(values){this.values=values;}
  async bytes(){assert.deepEqual([...retained].sort(),['files:/source','files:/source/terminal','lease:/source','lease:/source/terminal']);await Promise.resolve();assert.equal(retained.size,4);events.push('compression-complete');return Buffer.from('compressed-original');}
};
const {packNativeBundle,unpackNativeBundle}=await import(${JSON.stringify(modulePath('scripts/release/native-archive.ts'))});
if(scenario==='unpack'){
  const result=unpackNativeBundle({archivePath:'/archive',sha256:'a'.repeat(64),destination:dest});
  assert.equal(result.root,dest);assert.equal(files.get(dest+'/app/payload').length,9*1024*1024+17);
  assert.equal(events.some(event=>event==='original-tree-delete'),false);
  const changed={...manifest,links:[{path:'app/link',target:'payload'}]};archiveFiles.set('native-manifest.json',Buffer.from(JSON.stringify(changed)));
  const before=events.length;
  assert.throws(()=>unpackNativeBundle({archivePath:'/archive',sha256:'a'.repeat(64),destination:'/rejected'}),/native_archive_invalid/);
  assert.equal(events.length,before);assert.equal(directories.has('/rejected'),false);
}else if(scenario==='unknown'){
  await assert.rejects(packNativeBundle({bundleRoot:root,archivePath:'/archives/native.tgz'}),error=>error===primary);
  assert.equal(retained.size,4);assert.equal(events.some(event=>event.startsWith('close:')),false);
}else{
  const result=await packNativeBundle({bundleRoot:root,archivePath:'/archives/native.tgz'});
  assert.equal(result.candidateId,hash(nativeBytes));assert.equal(retained.size,0);
  assert.ok(events.indexOf('compression-complete')<events.indexOf('close:files:/source/terminal'));
  assert.equal(files.get('/archives/native.tgz.sha256').toString(),hash(Buffer.from('compressed-original'))+'  native.tgz\\n');
}
Bun.Archive=OriginalArchive;
console.log('archive-owner-confirmed');
`;
}
