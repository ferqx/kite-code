import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { expect, test } from '#kite-test';
import { build as buildBundle } from '../../../../../scripts/tooling/build';
import { spawn as spawnProcess } from '../../../../../scripts/tooling/process';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import { nodeRuntimeFlags } from '../../../src/platform/runtime-flags';
import { imageAssets } from '../../../src/tools/images/processor';
import { fixtureNodeExecutable, fixtureRuntimeBuild } from '../../fixtures/node-runtime';

test('offline image codec and physical sharp/native closure run outside the source tree, and tampering recovers', async () => {
  const root = temporaryDirectory('kite-image-package-');
  try {
    const entry = join(root, 'reader.ts');
    writeFileSync(
      entry,
      `import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {processImage,imageAssets} from ${JSON.stringify(resolve(import.meta.dirname, '../../../src/tools/images/processor.ts').replaceAll('\\', '/'))};
const bytes=readFileSync(new URL('./input.png',import.meta.url));
process.env.NODE_OPTIONS = '--import=' + new URL('./tools/images/poison.js', import.meta.url).href;
process.env.NODE_PATH = new URL('./tools/images/', import.meta.url).pathname;
const read=()=>processImage(async()=>({bytes}),new AbortController().signal);
const first=await read(),assets=imageAssets();
for(const path of [assets.child,assets.checksum]) {
  const original=readFileSync(path); unlinkSync(path);
  try {await assert.rejects(read(),{code:'ENOENT'});} finally {writeFileSync(path,original);}
  assert.equal((await read()).metadata.width,80);
}
const digest=readFileSync(assets.checksum);writeFileSync(assets.checksum,'0'.repeat(64));
try {await assert.rejects(read(),{code:'image_assets_invalid'});} finally {writeFileSync(assets.checksum,digest);}
assert.equal((await read()).metadata.width,80);
console.log(JSON.stringify({metadata:first.metadata,signature:Buffer.from(first.png).subarray(0,8).toString('hex')}));`,
    );
    const built = await buildBundle({
      entrypoints: [entry],
      outdir: root,
      ...fixtureRuntimeBuild(root),
      packages: 'bundle',
      naming: 'reader.js',
    });
    expect(built.success).toBe(true);
    const assets = imageAssets();
    mkdirSync(join(root, 'tools/images'), { recursive: true });
    cpSync(assets.child, join(root, 'tools/images/image-child.js'));
    cpSync(assets.checksum, join(root, 'tools/images/image-child.sha256'));
    // The fixed codec must not use an ambient Node preload or remap its native dependency.
    writeFileSync(
      join(root, 'tools/images/poison.js'),
      'throw Error("fixture_config_was_executed");',
    );
    writeFileSync(
      join(root, 'tools/images/tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { sharp: ['./poison.js'] } } }),
    );
    for (const source of assets.dependencies) {
      const name = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).name;
      const target = join(root, 'node_modules', name);
      mkdirSync(target, { recursive: true });
      cpSync(source, target, { recursive: true, dereference: true });
    }
    writeFileSync(join(root, 'input.png'), await createCanvas(80, 40).encode('png'));
    const child = spawnProcess(
      [fixtureNodeExecutable(), ...nodeRuntimeFlags, join(root, 'reader.js')],
      {
        cwd: root,
        env: { PATH: '', NODE_PATH: '' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout)).toMatchObject({
      metadata: { width: 80, height: 40, mediaType: 'image/png' },
      signature: '89504e470d0a1a0a',
    });
  } finally {
    removeTemporaryDirectory(root);
  }
}, 30000);
