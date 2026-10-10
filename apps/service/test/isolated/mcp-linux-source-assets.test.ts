import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('Linux source asset seal closes confirmed original FDs and retains the first unknown per Profile without retry', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-linux-source-assets-')));
  const script = join(root, 'original.ts');
  writeFileSync(
    script,
    `
import assert from 'node:assert/strict';
import {mock} from 'bun:test';
import * as fs from 'node:fs';
const original = {...fs};
Object.defineProperty(process,'platform',{value:'linux'});
const init=${JSON.stringify(join(root, 'init'))}, bwrap=${JSON.stringify(join(root, 'bwrap'))};
for(const path of [init,bwrap]) { original.writeFileSync(path,'original complete executable bytes');original.chmodSync(path,0o755); }
let mode='confirmed', opens=0, closes=0, reads=0;
const held = new Set<number>();
const closeError=new Error('original_close_unknown'),readError=new Error('original_read_failed');
mock.module('node:fs',()=>({...original,
 openSync(path,flags){const fd=original.openSync(path,flags);opens++;held.add(fd);return fd;},
 readSync(...args){reads++;if(mode==='read-close-unknown')throw readError;return original.readSync(...args);},
 closeSync(fd){closes++;assert.ok(held.has(fd));if(mode!=='confirmed')throw closeError;original.closeSync(fd);held.delete(fd);},
}));
const {createMcpSourceConfiguration,assertMcpSourceStdioAssetsClosed}=await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, '../../src/mcp-source-configuration.ts')).href)});
const configure=(key)=>createMcpSourceConfiguration({
 profile:{profileAccessKey:key,profilePath:${JSON.stringify(join(root, 'profile'))},coordinationPath:${JSON.stringify(join(root, 'coordination'))}},
 runtime(){throw Error('source constructor must not read Runtime');},credentialVault:{async resolve(){throw Error('must not resolve credential');}},
 stdio:{guardianPath:${JSON.stringify(join(root, 'unused-guardian.js'))},bunExecutable:process.execPath,linux:{initExecutable:init,bubblewrapPath:bwrap}},
});
configure('confirmed');assert.equal(opens,2);assert.equal(closes,2);assert.ok(reads>=2);assert.equal(held.size,0);assertMcpSourceStdioAssetsClosed('confirmed');
for(const current of ['close-unknown','read-close-unknown']){
 mode=current;let first;try{configure(current);}catch(error){first=error;}
 assert.ok(first instanceof AggregateError);assert.equal(first.message,'mcp_stdio_asset_close_unknown');
 assert.deepEqual(first.errors,current==='close-unknown'?[closeError]:[readError,closeError]);
 const before={opens,closes,reads};
 for(let n=0;n<2;n++){assert.throws(()=>assertMcpSourceStdioAssetsClosed(current),error=>error===first);assert.throws(()=>configure(current),error=>error===first);}
 assert.deepEqual({opens,closes,reads},before);assertMcpSourceStdioAssetsClosed('different-profile');
}
assert.equal(held.size,2);console.log('original-linux-source-fd-ownership-confirmed');
`,
  );
  const child = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  let exited = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
  try {
    const code = await child.exited;
    exited = true;
    const [stdout, stderr] = await output;
    if (code !== 0) console.error(stderr);
    expect(code).toBe(0);
    expect(stdout).toContain('original-linux-source-fd-ownership-confirmed');
    expect(stderr).toBe('');
  } finally {
    clearTimeout(timer);
    if (!exited) {
      child.kill('SIGKILL');
      await child.exited;
    }
    await output;
    rmSync(root, { recursive: true, force: true });
  }
});
