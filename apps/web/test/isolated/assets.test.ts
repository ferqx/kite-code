import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AssetManifest, type TrustedAsset, validateTrustedAssets } from '../../src/assets';

test('actual browser build produces only fixed verified assets and source-independent manifest/module', async () => {
  const build = Bun.spawn([process.execPath, 'run', 'build'], {
    cwd: join(import.meta.dir, '../..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [status, diagnostics] = await Promise.all([
    build.exited,
    new Response(build.stderr).text(),
    new Response(build.stdout).text(),
  ]);
  expect(diagnostics).not.toContain('error:');
  expect(status).toBe(0);
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'kite-web-assets-')));
  try {
    const dist = join(import.meta.dir, '../../dist');
    writeFileSync(join(temporary, 'assets.mjs'), readFileSync(join(dist, 'assets.js')));
    const module = (await import(join(temporary, 'assets.mjs'))) as {
      getTrustedAssets(): ReadonlyMap<string, TrustedAsset>;
      assetManifest: AssetManifest;
    };
    const assets = module.getTrustedAssets();
    expect([...assets.keys()]).toEqual(['/index.html', '/app.js', '/app.css']);
    await validateTrustedAssets(assets, module.assetManifest);
    expect(assets.get('/index.html')?.content).toContain('src="/app.js"');
    expect(assets.get('/app.js')?.content).not.toContain('from"react"');
    expect(JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))).toEqual(
      module.assetManifest,
    );
    expect(readFileSync(join(dist, 'assets.d.ts'), 'utf8')).toContain('getTrustedAssets');
    const extra = new Map(assets);
    extra.set('/arbitrary', { content: 'untrusted', mediaType: 'text/plain' });
    await expect(validateTrustedAssets(extra, module.assetManifest)).rejects.toThrow(
      'invalid_web_assets',
    );
    const corrupt = new Map(assets);
    corrupt.set('/app.js', { ...corrupt.get('/app.js')!, content: 'changed' });
    await expect(validateTrustedAssets(corrupt, module.assetManifest)).rejects.toThrow(
      'invalid_web_assets',
    );
    const duplicate = [
      module.assetManifest[0]!,
      module.assetManifest[0]!,
      module.assetManifest[2]!,
    ];
    await expect(validateTrustedAssets(assets, duplicate)).rejects.toThrow('invalid_web_assets');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}, 10000);
