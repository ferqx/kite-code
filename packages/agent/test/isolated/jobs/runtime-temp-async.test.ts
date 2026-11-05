import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import { launchIdentity, removeRuntimeTempAsync } from '../../../src/jobs/launch-identity';

test('async temp cleanup removes owned readonly descendants and junctions without touching external targets', async () => {
  const root = temporaryDirectory('kite-async-temp-'),
    owned = join(root, 'owned'),
    external = join(root, 'external');
  try {
    mkdirSync(owned);
    mkdirSync(external);
    mkdirSync(join(owned, 'nested'));
    writeFileSync(join(external, 'canary'), 'keep');
    const file = join(owned, 'nested', 'readonly');
    writeFileSync(file, 'owned');
    chmodSync(file, 0o400);
    symlinkSync(
      external,
      join(owned, 'redirect'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const fact = launchIdentity(owned);
    await removeRuntimeTempAsync(fact);
    expect(existsSync(owned)).toBe(false);
    expect(readFileSync(join(external, 'canary'), 'utf8')).toBe('keep');
    await removeRuntimeTempAsync(fact);
  } finally {
    removeTemporaryDirectory(root);
  }
});

test('async temp cleanup rejects a replaced original root and preserves both directories', async () => {
  const root = temporaryDirectory('kite-async-temp-replaced-'),
    owned = join(root, 'owned'),
    old = join(root, 'old');
  try {
    mkdirSync(owned);
    writeFileSync(join(owned, 'original'), 'keep');
    const fact = launchIdentity(owned);
    renameSync(owned, old);
    mkdirSync(owned);
    writeFileSync(join(owned, 'replacement'), 'keep');
    await expect(removeRuntimeTempAsync(fact)).rejects.toThrow('confined_runtime_changed');
    expect(readFileSync(join(old, 'original'), 'utf8')).toBe('keep');
    expect(readFileSync(join(owned, 'replacement'), 'utf8')).toBe('keep');
  } finally {
    removeTemporaryDirectory(root);
  }
});

for (const scenario of ['bounded', 'failure'] as const)
  test(`async cleanup settles all I/O before returning: ${scenario}`, async () => {
    const root = temporaryDirectory('kite-async-temp-slots-'),
      module = pathToFileURL(join(import.meta.dir, '../../../src/jobs/launch-identity.ts')).href;
    const code = `
 import assert from 'node:assert/strict';import * as fs from 'node:fs';import * as io from 'node:fs/promises';import {mock}from'bun:test';
 const root=${JSON.stringify(root)},scenario=${JSON.stringify(scenario)},original={...io};let active=0,peak=0,started=0,release;
 const held=new Promise(r=>release=r);const seen=[];
 mock.module('node:fs/promises',()=>({...original,async rmdir(path,...args){active++;peak=Math.max(peak,active);started++;seen.push(path);
 try{if(scenario==='bounded')await held;else throw Error('fixture_remove_failure');return await original.rmdir(path,...args);}finally{active--;}}}));
 const{launchIdentity,removeRuntimeTempAsync}=await import(${JSON.stringify(module)});
 const facts=Array.from({length:7},(_,i)=>{const p=root+'/'+i;fs.mkdirSync(p);return launchIdentity(p);});
 if(scenario==='bounded'){
  let completed=0;const all=facts.map(fact=>removeRuntimeTempAsync(fact).then(()=>completed++));
  const until=Date.now()+3000;while(started<4){assert.ok(Date.now()<until);await Bun.sleep(1);}
  await Bun.sleep(10);assert.equal(started,4);assert.equal(completed,0);assert.equal(active,4);
  release();await Promise.all(all);assert.equal(completed,7);assert.equal(active,0);assert.equal(peak,4);
 }else{
  await assert.rejects(removeRuntimeTempAsync(facts[0]),/fixture_remove_failure/);assert.equal(active,0);assert.equal(fs.existsSync(facts[0].canonical),true);
 }
 console.log('async_temp_passed');`;
    try {
      const child = Bun.spawn([process.execPath, '--eval', code], {
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
        timeout: 10000,
      });
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
      expect(stdout.trim()).toBe('async_temp_passed');
    } finally {
      removeTemporaryDirectory(root);
    }
  }, 15000);
for (const scenario of ['cancel-during-cleanup', 'cleanup-unknown'] as const)
  test.skipIf(process.platform !== 'win32')(
    `real Windows Job retains cleanup ownership: ${scenario}`,
    async () => {
      const root = temporaryDirectory('kite-native-async-cleanup-');
      const jobModule = pathToFileURL(
        join(import.meta.dir, '../../../src/jobs/windows-shell.ts'),
      ).href;
      const runtimeModule = pathToFileURL(
        join(import.meta.dir, '../../fixtures/windows-shell-runtime.ts'),
      ).href;
      const processModule = pathToFileURL(
        join(import.meta.dir, '../../../src/platform/process/windows-owned-child.ts'),
      ).href;
      const code = `
 import assert from 'node:assert/strict';import * as fs from'node:fs';import * as io from'node:fs/promises';import{dirname,join}from'node:path';import{mock}from'bun:test';
 const root=${JSON.stringify(root)},scenario=${JSON.stringify(scenario)},original={...io},control=join(root,'control'),cwd=join(root,'workspace'),stateRoot=join(root,'state');
 for(const path of[control,cwd,stateRoot])fs.mkdirSync(path);
 let armed=false,heldPath,release;const held=new Promise(r=>release=r);
 mock.module('node:fs/promises',()=>({...original,async rmdir(path,...args){
 if(armed&&!heldPath&&dirname(path)===control){heldPath=path;if(scenario==='cleanup-unknown')throw Error('fixture_cleanup_unknown');await held;}
 return await original.rmdir(path,...args);}}));
 const{createWindowsShellJob}=await import(${JSON.stringify(jobModule)}),{windowsShellFixture}=await import(${JSON.stringify(runtimeModule)}),{retainWindowsOwnedProcessObservation}=await import(${JSON.stringify(processModule)});
 const assets=await windowsShellFixture();const job=await createWindowsShellJob({cwd,controlBase:control,stateRoot,env:{SystemRoot:process.env.SystemRoot,PATH:''},supervisorPath:assets.runner,shellExecutable:assets.shell,fullShellExecutable:assets.fullShell,coreutilsPath:assets.coreutils,executionScope:()=>({filesystem:'workspace_write',network:'none'})});
 const abort=new AbortController();const handle=await job.start({command:'printf owned > "$TMPDIR/owned"; sleep 0.2; printf completed'},{executionId:crypto.randomUUID(),sessionId:'cleanup',signal:abort.signal});
 const observation=retainWindowsOwnedProcessObservation(handle.reference.supervisorPid);armed=true;
 const events=[];let terminal=false;const observing=(async()=>{for await(const event of job.observe(handle)){events.push(event);if(event.type==='terminal')terminal=true;}})();
 const until=async read=>{const deadline=Date.now()+10000;while(!read()){assert.ok(Date.now()<deadline,'cleanup deadline');await Bun.sleep(5);}};
 try{
 await until(()=>!!heldPath);assert.equal(observation.inspect(),'dead');assert.equal(fs.existsSync(heldPath),true);
 if(scenario==='cancel-during-cleanup'){
  assert.equal(terminal,false);let settled=false;abort.abort();const stopping=job.cancel(handle).then(value=>{settled=true;return value;});await Bun.sleep(20);assert.equal(settled,false);assert.equal(terminal,false);
  release();assert.equal((await stopping).status,'stopped');await observing;
  const result=events.find(event=>event.type==='terminal').result;assert.equal(result.details.cleanupConfirmed,true);assert.equal(result.details.ownedProcesses.closed,true);await job.dispose(handle);assert.equal(fs.existsSync(heldPath),false);
 }else{
  await observing;const terminal=events.find(event=>event.type==='terminal');assert.equal(terminal.result.outcome,'outcome_unknown');assert.equal(terminal.result.details.cleanupConfirmed,false);assert.equal(terminal.result.details.processTreeStopped,true);assert.equal(terminal.supervision,'unknown');await assert.rejects(job.dispose(handle),/windows_shell_cleanup_unconfirmed/);assert.equal(fs.existsSync(heldPath),true);await original.rmdir(heldPath);
 }
 assert.deepEqual(fs.readdirSync(control),[]);console.log('native_async_cleanup_passed');
 }finally{release();observation.close();}
 `;
      try {
        const child = Bun.spawn([process.execPath, '--eval', code], {
          stdout: 'pipe',
          stderr: 'pipe',
          windowsHide: true,
          timeout: 25000,
        });
        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
        expect(stdout.trim()).toBe('native_async_cleanup_passed');
      } finally {
        removeTemporaryDirectory(root);
      }
    },
    30000,
  );
