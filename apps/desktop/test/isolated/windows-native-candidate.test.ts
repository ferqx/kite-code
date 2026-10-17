import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseWindowsNativeHandoff } from '../../electron/windows-native-candidate';

test('Main accepts one closed pair of private certificate addresses and rejects ambiguous or malformed admission', () => {
  const handoff = {
    launcherPipe: String.raw`\\.\pipe\kite-native-launch-${'a'.repeat(32)}`,
    mainPipe: String.raw`\\.\pipe\kite-native-main-${'b'.repeat(32)}`,
  };
  const parameter = `--kite-native-handoff=${JSON.stringify(handoff)}`;
  expect(parseWindowsNativeHandoff(['electron', 'app', parameter])).toEqual(handoff);
  expect(Object.isFrozen(parseWindowsNativeHandoff([parameter]))).toBe(true);
  for (const argv of [
    [],
    [parameter, parameter],
    ['--kite-native-handoff'],
    ['--kite-native-handoff={'],
    [`--kite-native-handoff=${JSON.stringify({ ...handoff, pid: 42 })}`],
    [`--kite-native-handoff=${JSON.stringify({ ...handoff, launcherPipe: handoff.mainPipe })}`],
    [`--kite-native-handoff=${JSON.stringify({ ...handoff, mainPipe: `${handoff.mainPipe}x` })}`],
  ])
    expect(() => parseWindowsNativeHandoff(argv)).toThrow('native_windows_bootstrap_unqualified');
});

test('same Main paired admission accepts only the original live native owner and blocks its close through every borrower', () => {
  const native = fileURLToPath(
    new URL('../../electron/windows-native-candidate.ts', import.meta.url),
  );
  const access = fileURLToPath(new URL('../../electron/windows-access.ts', import.meta.url));
  const code = `import {mock} from 'bun:test';import assert from 'node:assert/strict';import {resolve,join} from 'node:path';
let closes=0,verifies=0,fail=false;
mock.module(${JSON.stringify(access)},()=>({
  loadWindowsAccess(){return {
    candidateShared(){return {
      verify(){verifies++;},release(){if(fail)throw Error('original_close_unknown');closes++;}
    };}
  };}
}));
const {acquireWindowsNativeCandidate,retainWindowsNativePairedArtifact}=await import(${JSON.stringify(native)});
const id='a'.repeat(64),root=resolve('owned-prefix','releases',id);
const owner=acquireWindowsNativeCandidate({root,windowsAsset:{path:'fixed',sha256:id},files:[],handoff:{launcherPipe:'fixed',mainPipe:'fixed'}});
const proof={kind:'native.candidate',root,manifestSha256:id},actual={entrypoint:join(root,'terminal/node_modules/@kite-ai/service/main.js'),executable:join(root,'terminal/runtime/bun.exe'),buildId:'native-'+id};
for(const fake of [{...owner},{close(){},verify(){}}])assert.throws(()=>retainWindowsNativePairedArtifact(fake,proof,actual),/bootstrap_unqualified/);
for(const [p,a] of [[{...proof,root:root+'-other'},actual],[{...proof,manifestSha256:'b'.repeat(64)},actual],[{...proof,kind:'terminal.candidate'},actual],[proof,{...actual,buildId:'native-other'}],[proof,{...actual,entrypoint:join(root,'terminal/entrypoints/cli.js')}],[proof,{...actual,executable:join(root,'external-bun.exe')}]])assert.throws(()=>retainWindowsNativePairedArtifact(owner,p,a),/bootstrap_unqualified/);
assert.equal(verifies,0);
const first=retainWindowsNativePairedArtifact(owner,proof,actual),second=retainWindowsNativePairedArtifact(owner,proof,actual);
assert.deepEqual(first.arguments,['--no-env-file','--no-install','--config='+join(root,'terminal/runtime/windows-bunfig.toml'),'--tsconfig-override='+join(root,'terminal/runtime/windows-tsconfig.json')]);
assert.equal(verifies,2);assert.throws(()=>owner.close(),/candidate_in_use/);first.release();first.release();assert.throws(()=>owner.close(),/candidate_in_use/);assert.equal(closes,0);second.release();
fail=true;assert.throws(()=>owner.close(),/original_close_unknown/);assert.equal(closes,0);owner.verify();fail=false;owner.close();owner.close();assert.equal(closes,1);
assert.throws(()=>retainWindowsNativePairedArtifact(owner,proof,actual),/bootstrap_unqualified/);assert.throws(()=>owner.verify(),/bootstrap_unqualified/);
console.log('original-main-borrowers-confirmed');`;
  const child = spawnSync(process.execPath, ['--eval', code], { encoding: 'utf8', timeout: 5000 });
  if (child.status !== 0) throw Error(`native_owner_borrow_failed:${child.error}:${child.stderr}`);
  expect(child.stdout.trim()).toBe('original-main-borrowers-confirmed');
});
