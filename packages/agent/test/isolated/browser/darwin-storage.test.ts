import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '#kite-test';
import { testRuntimeFlags } from '../../../../../scripts/tooling/test-command';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { scanDarwinBrowserDirectory } from '../../../src/tools/browser/darwin-storage';

const macTest = process.platform === 'darwin' ? test : test.skip;
macTest(
  'Darwin scanner holds real parent descriptors, skips symlinks and detects inode replacement and size budget',
  async () => {
    const root = temporaryDirectory('kite-bscan-');
    const owned = join(root, 'owned'),
      outside = join(root, 'outside');
    mkdirSync(owned);
    mkdirSync(outside);
    writeFileSync(join(outside, 'huge'), '');
    truncateSync(join(outside, 'huge'), 256 * 1024 * 1024 + 1);
    symlinkSync(outside, join(owned, 'outside'));
    mkdirSync(join(owned, 'nested'));
    writeFileSync(join(owned, 'nested', 'hello'), 'local');
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
      writeFileSync(join(owned, 'large'), '');
      truncateSync(join(owned, 'large'), 256 * 1024 * 1024 + 1);
      await expect(scan()).rejects.toThrow('byte_limit');
      expect(unknown).toBe(false);
      rmSync(join(owned, 'large'));
      renameSync(owned, join(root, 'original'));
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
    const filesystem = new URL('../../../../../tests/fixtures/test-filesystem.ts', import.meta.url)
      .href;
    const source = `
 import assert from 'node:assert/strict';import {mock} from '#kite-test';import * as ffi from ${JSON.stringify(new URL('../../../src/runtime-ffi.ts', import.meta.url).href)};
 import {lstatSync,rmSync} from 'node:fs';
 import {temporaryDirectory} from ${JSON.stringify(filesystem)};
 const original=ffi.dlopen;let fail=true,closed=0,unknown=false,retained=0;
 mock.module(${JSON.stringify(new URL('../../../src/runtime-ffi.ts', import.meta.url).href)},()=>({...ffi,dlopen(path,symbols){const library=original(path,symbols);const closeDirectory=library.symbols.closedir;return {...library,close(){closed++;library.close();},symbols:{...library.symbols,closedir(directory){const result=closeDirectory(directory);return fail?-1:result;}}};}}));
 const {scanDarwinBrowserDirectory}=await import(${JSON.stringify(module)});
 const directory=temporaryDirectory('kite-bscan-close-'),identity=lstatSync(directory);
 const scan=()=>scanDarwinBrowserDirectory({directory,identity,closing:()=>false,closeUnknown(){unknown=true;retained++;}});
 await scan();assert.equal(unknown,true);assert.equal(retained,1);assert.equal(closed,0);
 fail=false;await scan();assert.equal(unknown,true);assert.equal(retained,1);assert.equal(closed,1);
 rmSync(directory,{recursive:true});console.log('darwin-close-unknown-retained');
 `;
    const result = spawnSync(
      process.execPath,
      [...testRuntimeFlags, '--input-type=module-typescript', '--eval', source],
      {
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('darwin-close-unknown-retained');
  },
);
