import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectWebGatewayStaticAssets,
  preflightWebGatewayStaticAssets,
  WebGatewayStaticAssetsError,
} from '../../src/web-gateway/static-assets';

test('requires the complete fixed Service Web asset surface', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-web-assets-')));
  try {
    expect(() => preflightWebGatewayStaticAssets(root)).toThrow(WebGatewayStaticAssetsError);
    mkdirSync(join(root, 'api-docs'));
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'index.html'), '<html></html>');
    writeFileSync(join(root, 'api-docs', 'openapi.json'), '{}');
    expect(() => preflightWebGatewayStaticAssets(root)).toThrow(WebGatewayStaticAssetsError);
    writeFileSync(join(root, 'assets', 'app.js'), 'export {};');
    expect(preflightWebGatewayStaticAssets(root)).toBe(root);
    const first = inspectWebGatewayStaticAssets(root);
    expect(first).toMatchObject({
      root,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    writeFileSync(join(root, 'assets', 'app.js'), 'export const revision = 2;');
    expect(inspectWebGatewayStaticAssets(root).digest).not.toBe(first.digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
