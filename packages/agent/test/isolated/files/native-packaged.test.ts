import { expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('relocated native companion loads in Bun and Node without a compiler/source fallback; missing or changed assets fail closed', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-files-package-')));
  try {
    if (process.platform === 'win32') {
      // Inspect the produced PE, rather than assuming the linker honored its input.
      const bytes = readFileSync(new URL('../../../src/native/files/files.node', import.meta.url));
      const pe = bytes.readUInt32LE(60),
        optional = pe + 24;
      expect(bytes.readUInt16LE(pe + 4)).toBe(0x8664);
      expect(bytes.readUInt16LE(optional)).toBe(0x20b);
      expect(bytes.readUInt32LE(optional + 112 + 13 * 8)).toBe(0);
      expect(bytes.readUInt32LE(optional + 116 + 13 * 8)).toBe(0);
      const rva = bytes.readUInt32LE(optional + 112 + 10 * 8);
      expect(rva).toBeGreaterThan(0);
      let loadConfig = -1;
      const sections = optional + bytes.readUInt16LE(pe + 20);
      for (let i = 0; i < bytes.readUInt16LE(pe + 6); i++) {
        const section = sections + i * 40;
        const address = bytes.readUInt32LE(section + 12),
          size = bytes.readUInt32LE(section + 16);
        if (rva >= address && rva - address + 80 <= size)
          loadConfig = bytes.readUInt32LE(section + 20) + rva - address;
      }
      expect(loadConfig).toBeGreaterThanOrEqual(0);
      expect(bytes.readUInt16LE(loadConfig + 78)).toBe(0x800);
    }
    const built = await Bun.build({
      entrypoints: [
        fileURLToPath(new URL('../../../src/files-native-binding.ts', import.meta.url)),
      ],
      outdir: root,
      target: 'node',
      format: 'esm',
      packages: 'bundle',
    });
    expect(built.success).toBe(true);
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    cpSync(
      fileURLToPath(new URL('../../../src/native/files', import.meta.url)),
      join(root, 'native/files'),
      { recursive: true },
    );
    expect(existsSync(join(root, 'src'))).toBe(false);
    const script = join(root, 'verify.mjs');
    writeFileSync(
      script,
      `
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createNativeWorkspaceFileIo} from './files-native-binding.js';
const root=join(import.meta.dirname,'work');mkdirSync(root,{recursive:true});
let io;
try{
 io=createNativeWorkspaceFileIo(root,[],false);
 const id=io.openAt(io.root,'temporary','temporary');
 const bytes=Buffer.from('完整 Node-API α\\r\\n'.repeat(90000));
 io.write(id,bytes);io.sync(id);const baseline=io.stat(id);
 io.publishAt(io.root,'temporary','actual',true);io.sync(io.root);io.closeHandle(id);
 if(io.createOnlyLeavesTemporary)io.unlinkAt(io.root,'temporary');
 const read=io.openAt(io.root,'actual','read');const actual=Buffer.alloc(bytes.length);let offset=0;
 for(;;){const chunk=Buffer.alloc(65536);const n=io.read(read,chunk);if(!n)break;chunk.copy(actual,offset,0,n);offset+=n;}
 assert.equal(offset,bytes.length);assert.deepEqual(actual,bytes);
 assert.equal(io.stat(read).ino,baseline.ino);io.closeHandle(read);
 assert.deepEqual(readFileSync(join(root,'actual')),bytes);io.close();
 rmSync(join(root,'actual'));console.log(JSON.stringify({outcome:'succeeded',bytes:offset}));
}catch(error){console.log(JSON.stringify({code:error.code,entries:readdirSync(root)}));}
finally{io?.close();}
`,
    );
    const node = Bun.which('node');
    expect(node).not.toBeNull();
    const runtimes = [process.execPath, node!];
    const run = async (runtime: string) => {
      const child = Bun.spawn([runtime, script], {
        cwd: root,
        env: { ...process.env, PATH: '', NODE_PATH: '', NODE_OPTIONS: '', BUN_OPTIONS: '' },
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });
      const [exit, out, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(error).toBe('');
      expect(exit).toBe(0);
      return JSON.parse(out);
    };
    for (const runtime of runtimes)
      expect(await run(runtime)).toMatchObject({ outcome: 'succeeded' });
    const metadata = join(root, 'native/files/manifest.json');
    const original = readFileSync(metadata, 'utf8');
    for (const changed of [
      { ...JSON.parse(original), sha256: '0'.repeat(64) },
      { ...JSON.parse(original), abi: 'kite-files:unknown' },
      { ...JSON.parse(original), platform: 'unqualified' },
    ]) {
      writeFileSync(metadata, JSON.stringify(changed));
      for (const runtime of runtimes)
        expect(await run(runtime)).toEqual({ code: 'file_native_identity_mismatch', entries: [] });
    }
    writeFileSync(metadata, original);
    const asset = join(root, 'native/files/files.node');
    renameSync(asset, `${asset}.retained`);
    for (const runtime of runtimes)
      expect(await run(runtime)).toEqual({ code: 'file_native_unavailable', entries: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
