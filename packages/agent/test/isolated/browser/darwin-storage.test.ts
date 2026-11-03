import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scanDarwinBrowserDirectory } from '../../../src/tools/browser/darwin-storage';

const macTest = process.platform === 'darwin' ? test : test.skip;
macTest(
  'Darwin scanner holds real parent descriptors, skips symlinks and detects inode replacement and size budget',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-bscan-'));
    const owned = root + '/owned',
      outside = root + '/outside';
    mkdirSync(owned);
    mkdirSync(outside);
    writeFileSync(outside + '/huge', '');
    truncateSync(outside + '/huge', 256 * 1024 * 1024 + 1);
    symlinkSync(outside, owned + '/outside');
    mkdirSync(owned + '/nested');
    writeFileSync(owned + '/nested/hello', 'local');
    const identity = lstatSync(owned);
    let unknown = false;
    const scan = () =>
      scanDarwinBrowserDirectory({
        directory: owned,
        identity,
        closing: () => false,
        closeUnknown() {
          unknown = true;
        },
      });
    try {
      await scan();
      expect(unknown).toBe(false);
      writeFileSync(owned + '/large', '');
      truncateSync(owned + '/large', 256 * 1024 * 1024 + 1);
      await expect(scan()).rejects.toThrow('byte_limit');
      expect(unknown).toBe(false);
      rmSync(owned + '/large');
      renameSync(owned, root + '/original');
      mkdirSync(owned);
      await expect(scan()).rejects.toThrow('directory_changed');
      expect(unknown).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

macTest(
  'Darwin scanner close failure retains the exact library and sticky unknown across a later successful scan',
  () => {
    const module = fileURLToPath(
      new URL('../../../src/tools/browser/darwin-storage.ts', import.meta.url),
    );
    const source = `
 import assert from 'node:assert/strict';import {mock} from 'bun:test';import * as ffi from 'bun:ffi';
 import {mkdtempSync,lstatSync,rmSync} from 'node:fs';
 const original=ffi.dlopen;let fail=true,closed=0,unknown=false,retained=0;
 mock.module('bun:ffi',()=>({...ffi,dlopen(path,symbols){const library=original(path,symbols);const closeDirectory=library.symbols.closedir;return {...library,close(){closed++;library.close();},symbols:{...library.symbols,closedir(directory){const result=closeDirectory(directory);return fail?-1:result;}}};}}));
 const {scanDarwinBrowserDirectory}=await import(${JSON.stringify(module)});
 const directory=mkdtempSync('/private/tmp/kite-bscan-close-'),identity=lstatSync(directory);
 const scan=()=>scanDarwinBrowserDirectory({directory,identity,closing:()=>false,closeUnknown(){unknown=true;retained++;}});
 await scan();assert.equal(unknown,true);assert.equal(retained,1);assert.equal(closed,0);
 fail=false;await scan();assert.equal(unknown,true);assert.equal(retained,1);assert.equal(closed,1);
 rmSync(directory,{recursive:true});console.log('darwin-close-unknown-retained');
 `;
    const result = spawnSync(process.execPath, ['--eval', source], {
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('darwin-close-unknown-retained');
  },
);
