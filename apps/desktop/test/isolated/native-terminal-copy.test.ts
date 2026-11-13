import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '#kite-test';

test('Windows Native file-only terminal copy restores v1 empty worker assets before verification', () => {
  const modulePath = fileURLToPath(new URL('../../scripts/build-native.ts', import.meta.url));
  const fixturePath = fileURLToPath(
    new URL('../../../../tests/fixtures/unified-agent/sqlite-engine-fixture.ts', import.meta.url),
  );
  const source = `
import assert from 'node:assert/strict';
import {mock} from '#kite-test';
import {createHash} from 'node:crypto';
import {chmodSync,copyFileSync,existsSync,mkdirSync,mkdtempSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
const runtime=await import('@kite-ai/service/runtime-assets');
const verify=runtime.readTerminalRuntimeBundleContent;
const security=await import('@kite-ai/agent/windows-path-security');
let copied=0,missingRejected=0,failCopy=false;
mock.module('@kite-ai/agent/windows-path-security',()=>({...security,privateDirectory(path){mkdirSync(path,{recursive:true,mode:0o700});},defaultWindowsPathSecurity(){return {copyPrivateArtifactFiles(source,target,files){
 copied++;if(failCopy)throw Error('test_copy_rejected');
 for(const file of files){const destination=join(target,file);mkdirSync(dirname(destination),{recursive:true});copyFileSync(join(source,file),destination);}
 // Exercise the real verifier at the exact file-only copy boundary, before
 // the production helper restores its fixed empty directory.
 assert.throws(()=>verify(target));missingRejected++;
}};}}));
const {copyWindowsNativeTerminal}=await import(${JSON.stringify(modulePath)});
const {fixtureTerminalSqlite}=await import(${JSON.stringify(fixturePath)});
const root=realpathSync(mkdtempSync(join(tmpdir(),'kite-native-terminal-copy-')));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
 const source=join(root,'source'),target=join(root,'target');mkdirSync(source);
 const entries=runtime.terminalBundleEntries(process.platform),files=[];
 const directory='node_modules/@kite-ai/agent/tools/git-worktree';
 for(const path of [...Object.values(entries),...['worker.js','empty-bunfig.toml','manifest.json'].map(name=>directory+'/'+name)]){
  const absolute=join(source,path);mkdirSync(dirname(absolute),{recursive:true});const bytes=Buffer.from('integrity-only inert asset '+path);writeFileSync(absolute,bytes);const mode=path===entries.runtime?493:420;chmodSync(absolute,mode);files.push({path,size:bytes.length,sha256:hash(bytes),mode});
 }
 mkdirSync(join(source,directory,'empty-hooks'));
 const manifest={version:1,apiMajor:1,target:{platform:process.platform,arch:process.arch},bunVersion:"1.4.4",sqlite:fixtureTerminalSqlite(source,files),productVersion:'0.1.0',source:{commit:'a'.repeat(40),dirty:true},entries,files,links:[]};
 writeFileSync(join(source,'terminal-manifest.json'),JSON.stringify(manifest));
 const verified=verify(source);
 copyWindowsNativeTerminal(verified,target);
 assert.equal(copied,1);assert.equal(missingRejected,1);assert.deepEqual(readdirSync(join(target,directory,'empty-hooks')),[]);
 const actual=verify(target);assert.equal(actual.digest,verified.digest);assert.equal(actual.manifest.version,1);assert.equal(actual.manifest.files.some(file=>file.path.endsWith('/empty-hooks')),false);
 writeFileSync(join(target,directory,'empty-hooks','post-checkout'),'SHOULD_NEVER_EXECUTE');assert.throws(()=>verify(target),/terminal_bundle_identity_mismatch/);
 failCopy=true;const failedTarget=join(root,'failed');assert.throws(()=>copyWindowsNativeTerminal(verified,failedTarget),/test_copy_rejected/);assert.equal(existsSync(join(failedTarget,directory,'empty-hooks')),false);
}finally{rmSync(root,{recursive:true});}
`;
  const result = spawnSync(process.execPath, ['--eval', source], {
    encoding: 'utf8',
    timeout: 10000,
  });
  if (result.status !== 0) console.error(result.stderr);
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
});
