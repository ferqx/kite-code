import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseScratch } from '../../fixtures/unified-agent/release-filesystem';

test.each([
  'success',
  'failed',
  'absent',
] as const)('smoke preserves the original resource lifetime when cleanup is %s', (scenario) => {
  const root = releaseScratch(join(tmpdir(), 'kite-smoke-owned-'));
  const source = (name: string) => fileURLToPath(new URL(`../../../${name}`, import.meta.url));
  try {
    const code = `
import {mock} from 'bun:test';import assert from 'node:assert/strict';
import {mkdirSync,existsSync} from 'node:fs';import {join,dirname} from 'node:path';
const root=${JSON.stringify(root)},scenario=${JSON.stringify(scenario)},bundle=join(root,'candidate');mkdirSync(bundle);
let releases=0,home,stopped=false;const lease={release(){assert(children.every(child=>child.exitCode!==null));releases++;}};
mock.module('@kite-ai/agent/artifact-access',()=>({acquireArtifactAccess:()=>lease}));
mock.module(${JSON.stringify(source('apps/cli/host/terminal-artifact.ts'))},()=>({verifyTerminalBundle:()=>({root:bundle,manifest:{entries:{runtime:'runtime/bun.exe',cli:'entrypoints/cli.js'}},candidateId:'a'.repeat(64),digest:'a'.repeat(64),buildId:'terminal-'+'a'.repeat(64)})}));
const original=Bun.spawn,children=[];
const server=scenario==='success'?Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('<main id="root"></main>')}):undefined;
Bun.spawn=(argv,options)=>{
 home=options.env.HOME;
 let body;
 if(argv.includes('--help'))body='console.log("kite run --workspace");';
 else if(argv.includes('--version'))body='console.log("kite unified-agent 0.1.0");';
 else if(scenario==='success'){
  if(argv.includes('web'))body='console.log('+JSON.stringify(server.url.origin)+');';
  else{if(argv.includes('stop'))stopped=true;body='console.log('+JSON.stringify(JSON.stringify(stopped?{state:'absent'}:{state:'accepting',instanceId:'fixed',runningBuildId:'terminal-'+'a'.repeat(64)}))+');';}
 }else body=argv.includes('start')?'console.error("PRIMARY_STARTUP_FAILURE");process.exitCode=1;':scenario==='failed'?'console.error("CLEANUP_STOP_FAILURE");process.exitCode=1;':'console.log(JSON.stringify({state:"absent"}));';
 const child=original([process.execPath,'--eval',body],options);children.push(child);return child;
};
try {
 const {smokeTerminalBundle}=await import(${JSON.stringify(source('scripts/release/release-smoke.ts'))});
 const error=await smokeTerminalBundle(bundle).catch(e=>e);
 if(scenario==='success'){
  assert.deepEqual(error,{candidateId:'a'.repeat(64),buildId:'terminal-'+'a'.repeat(64),entry:true,daemon:true,web:true,cleanup:true,modelInvoked:false});
  assert.equal(releases,1);assert(!existsSync(dirname(home)));assert.equal(children.length,7);
 }else if(scenario==='failed'){
  assert(error instanceof AggregateError);assert.equal(error.message,'release_smoke_cleanup_unknown');assert.equal(error.errors.length,2);
  assert.equal(error.errors[0].message,'release_smoke_child_failed');assert.match(error.errors[0].cause.message,/PRIMARY_STARTUP_FAILURE/);
  assert.equal(error.errors[1].message,'release_smoke_child_failed');assert.match(error.errors[1].cause.message,/CLEANUP_STOP_FAILURE/);
 }else{assert.equal(error.message,'release_smoke_child_failed');assert.match(error.cause.message,/PRIMARY_STARTUP_FAILURE/);}
 if(scenario!=='success'){assert.equal(releases,0);assert(existsSync(dirname(home)));assert.equal(children.length,4);}
 assert(children.every(child=>child.exitCode!==null));
 console.log('SMOKE_ORIGINAL_OWNERS_RETAINED');
}finally{Bun.spawn=original;await server?.stop(true);for(const child of children)if(child.exitCode===null){child.kill();await child.exited;}}
`;
    const child = spawnSync(process.execPath, ['--eval', code], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, TMP: root, TEMP: root, TMPDIR: root },
    });
    if (child.status !== 0) throw new Error(child.stderr, { cause: child.error });
    expect(child.stdout.trim()).toBe('SMOKE_ORIGINAL_OWNERS_RETAINED');
  } finally {
    // The isolated host and all its real subprocesses have exited; its mock lease has no native handles.
    rmSync(root, { recursive: true, force: true });
  }
});
