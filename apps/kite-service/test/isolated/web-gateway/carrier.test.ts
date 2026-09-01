import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebGatewayCarrier, type WebGatewayCarrier } from '../../../src/web-gateway';

const carriers: WebGatewayCarrier[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(carriers.splice(0).map((carrier) => carrier.close()));
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Web Gateway static REST carrier', () => {
  test('serves fixed assets, creates root sessions and rejects retired BFF routes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kite-web-rest-carrier-'));
    roots.push(root);
    await mkdir(join(root, 'assets'));
    await mkdir(join(root, 'api-docs'));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>Kite</title>');
    await writeFile(join(root, 'assets', 'app.js'), 'globalThis.kite = true;');
    await writeFile(join(root, 'api-docs', 'openapi.json'), '{"openapi":"3.1.0"}\n');
    const carrier = createWebGatewayCarrier({ staticAssetRoot: root, instanceId: 'instance-one' });
    carriers.push(carrier);

    const docsIndex = await fetch(`${carrier.origin}/api-docs`);
    expect(docsIndex.status).toBe(200);
    expect(docsIndex.headers.get('set-cookie')).toContain('Path=/; HttpOnly; SameSite=Strict');
    const sessionIndex = await fetch(`${carrier.origin}/sessions/session-one`);
    expect(sessionIndex.status).toBe(200);
    expect(sessionIndex.headers.get('set-cookie')).toContain('Path=/; HttpOnly; SameSite=Strict');

    const index = await fetch(`${carrier.origin}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(index.headers.get('content-security-policy')).toContain(
      "style-src 'self' 'unsafe-inline'",
    );
    expect(index.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await index.text()).toContain('<title>Kite</title>');
    const openApi = await fetch(`${carrier.origin}/api-docs/openapi.json`);
    expect(openApi.status).toBe(200);
    expect(openApi.headers.get('set-cookie')).toBeNull();
    expect((await fetch(`${carrier.origin}/sessions/session-one/unknown`)).status).toBe(404);
    expect((await fetch(`${carrier.origin}/assets/app.js`)).status).toBe(200);

    for (const path of [
      '/_kite/web/bootstrap',
      '/_kite/web/tabs',
      '/_kite/web/directory',
      '/_kite/web/history',
      '/_kite/web/client',
    ]) {
      expect((await fetch(`${carrier.origin}${path}`)).status).toBe(404);
    }

    expect(index.headers.get('set-cookie')).toContain('Path=/; HttpOnly; SameSite=Strict');
  });
});
