import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { createBrowserClient } from '@kite-ai/client/browser';
import { assetManifest, getTrustedAssets } from '@kite-ai/web/assets';
import {
  type DevelopmentWebSelection,
  launchDevelopmentWeb,
  selectDevelopmentWeb,
} from '../../../scripts/development/unified-web';

const fixtureEntrypoint = join(
  import.meta.dir,
  '../../fixtures/unified-agent/web-launcher-service.ts',
);
function selection(root: string): DevelopmentWebSelection {
  return {
    profile: selectProfile({ dataRoot: join(root, 'new-data'), profile: 'development' }),
    entrypoint: fixtureEntrypoint,
    buildId: 'fixed-web-launch-test',
    instanceId: crypto.randomUUID(),
    apiMajor: 1,
    requiredCapabilities: ['sessions', 'history'],
    hostConfiguration: { ledger: join(root, 'model-effects'), release: join(root, 'release') },
  };
}
async function until(check: () => Promise<boolean> | boolean) {
  const limit = Date.now() + 6000;
  while (!(await check())) {
    if (Date.now() > limit) throw new Error('fixture_deadline');
    await Bun.sleep(5);
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectClosed(endpoint: string) {
  // A proxy may turn ECONNREFUSED into HTTP 502; prove the actual listener is gone.
  const url = new URL(endpoint);
  const connected = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(true);
    });
  });
  expect(connected).toBe(false);
}

test('pure development selection is separate from old data, closed arguments, fixed entry digest and no fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-web-select-'));
  try {
    for (const args of [
      ['--token', 'secret'],
      ['--data-root', 'relative'],
      ['--profile', 'old'],
      ['--data-root', '/tmp/new', '--web'],
    ])
      expect(() => selectDevelopmentWeb(args, root)).toThrow('invalid_web_development_arguments');
    expect(() => selectDevelopmentWeb([], root)).toThrow('development_service_asset_unavailable');
    // Merely selecting an unavailable development artifact does not make a data directory.
    expect(existsSync(join(root, '.kite-code'))).toBe(false);
    const chosen = selectDevelopmentWeb([], join(import.meta.dir, '../../..'));
    expect(chosen.profile.profile).toBe('development');
    expect(chosen.profile.dataRoot.endsWith('/.kite-code/unified-development')).toBe(true);
    expect(chosen.buildId).toMatch(/^development-[a-f0-9]{64}$/);
    expect(chosen.requiredCapabilities).toEqual(['sessions', 'history']);
    expect(chosen.entrypoint.endsWith('/apps/service/dist/main.js')).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('actual paired Service/Gateway serves only verified assets; Browser close does not stop real active Model, host close owns EOF cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-web-launch-'));
  const chosen = selection(root);
  let host: Awaited<ReturnType<typeof launchDevelopmentWeb>> | undefined;
  try {
    const badAssets = new Map(getTrustedAssets());
    badAssets.set('/arbitrary', { content: 'private', mediaType: 'text/plain' });
    await expect(
      launchDevelopmentWeb({ selection: chosen, assets: badAssets, manifest: assetManifest }),
    ).rejects.toThrow('invalid_web_assets');
    expect(existsSync(chosen.profile.dataRoot)).toBe(false);
    host = await launchDevelopmentWeb({
      selection: chosen,
      assets: getTrustedAssets(),
      manifest: assetManifest,
    });
    expect(host.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const document = await fetch(`${host.endpoint}/sessions/a`);
    const html = await document.text();
    const identity = /name="kite-web-identity" content="([a-f0-9]{64})"/.exec(html)?.[1];
    expect(identity).toBeDefined();
    expect(html).not.toContain(host.paired.bootstrap.token);
    expect(html).not.toContain(root);
    const originalCookie = document.headers.get('set-cookie')!.split(';')[0]!;
    expect((await fetch(`${host.endpoint}/arbitrary`)).status).toBe(404);
    const browser = createBrowserClient({
      origin: host.endpoint,
      pageIdentity: identity!,
      fetch: Object.assign(
        async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          fetch(url, {
            ...init,
            headers: {
              ...Object.fromEntries(new Headers(init?.headers)),
              cookie: originalCookie,
              origin: host!.endpoint,
            },
          }),
        { preconnect: fetch.preconnect },
      ),
    });
    await browser.connect();
    expect(await browser.listWorkspaces()).toEqual([]);
    expect(existsSync(join(root, 'model-effects'))).toBe(false);
    const native = host.paired.client,
      storeId = host.paired.bootstrap.storeId!;
    await native.createWorkspace({
      expectedStoreId: storeId,
      id: 'workspace',
      name: 'isolated',
      rootUri: `file://${root}`,
    });
    await native.createSession({
      expectedStoreId: storeId,
      workspaceId: 'workspace',
      sessionId: 'a',
      commandId: 'create-a',
      title: 'Original',
    });
    await native.startRun('a', {
      expectedStoreId: storeId,
      commandId: 'run-a',
      kind: 'run.start',
      content: 'fixed local input',
    });
    await until(() => existsSync(join(root, 'model-effects')));
    expect(readFileSync(join(root, 'model-effects'), 'utf8')).toBe('started\n');
    expect((await browser.getView('a')).runs.some((run) => run.isActive)).toBe(true);
    await browser.closeBrowserSession();
    expect(alive(host.paired.pid)).toBe(true);
    expect((await native.getView('a')).runs.some((run) => run.isActive)).toBe(true);
    expect(readFileSync(join(root, 'model-effects'), 'utf8')).toBe('started\n');
    const pid = host.paired.pid;
    await host.close();
    expect(alive(pid)).toBe(false);
    expect(readFileSync(join(root, 'model-effects'), 'utf8')).toBe('started\nstopped\n');
    await expectClosed(host.endpoint);
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

for (const stop of ['eof', 'signal'] as const)
  test(`real launcher stdout contains only Browser endpoint, ${stop} closes only its paired child`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-web-launch-process-'));
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, '../../fixtures/unified-agent/web-launcher-host.ts'),
        root,
      ],
      {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' },
      },
    );
    const reader = child.stdout.getReader();
    let output = '';
    const errors = new Response(child.stderr).text();
    try {
      const deadline = Date.now() + 6000;
      while (!output.includes('\n')) {
        const part = await Promise.race([
          reader.read(),
          Bun.sleep(Math.max(1, deadline - Date.now())).then(() => {
            throw new Error('endpoint_deadline');
          }),
        ]);
        if (part.done) throw new Error('launcher_early_exit');
        output += new TextDecoder().decode(part.value);
      }
      const endpoint = output.trim();
      expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(output).not.toContain(root);
      const pid = Number(readFileSync(join(root, 'effect.pid'), 'utf8'));
      expect(alive(pid)).toBe(true);
      expect((await fetch(endpoint)).status).toBe(200);
      if (stop === 'eof') child.stdin.end();
      else child.kill('SIGTERM');
      expect(await child.exited).toBe(0);
      expect(alive(pid)).toBe(false);
      const rest: Uint8Array[] = [];
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        rest.push(item.value);
      }
      expect(rest.length).toBe(0);
      expect(await errors).toBe('');
      await expectClosed(endpoint);
    } finally {
      child.stdin.end();
      child.kill('SIGKILL');
      await child.exited;
      await reader.cancel().catch(() => {});
      await errors;
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
