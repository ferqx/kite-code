import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { ownedUserConfiguration } from '../../../apps/service/test/fixtures/user-configuration-fixture';
import { mcpStdioGuardianAsset } from '../../../packages/agent/src/mcp/stdio-port';
import { buildDevelopmentService } from '../../../scripts/development/desktop-reload';

const repository = realpathSync(join(import.meta.dir, '../../..'));
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('development Browser asset builds are fresh and failure cannot fall back to an earlier guardian', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite dev browser \u96ea-')));
  try {
    expect(() => mcpStdioGuardianAsset()).toThrow('mcp_stdio_asset_unavailable');
    const dependency = join(root, 'node_modules/@kite-ai/agent');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(
      join(dependency, 'package.json'),
      JSON.stringify({ type: 'module', exports: { './mcp': './mcp.ts' } }),
    );
    writeFileSync(join(dependency, 'mcp.ts'), "export const marker = 'source-MCP';");
    const service = join(root, 'apps/service/src'),
      mcp = join(root, 'packages/agent/src/mcp');
    mkdirSync(service, { recursive: true });
    mkdirSync(mcp, { recursive: true });
    writeFileSync(
      join(service, 'main.ts'),
      "export {locate} from './browser-configuration'; export {marker} from '@kite-ai/agent/mcp';",
    );
    writeFileSync(
      join(service, 'browser-configuration.ts'),
      "export {mcpStdioGuardianAsset as locate} from '@kite-ai/agent/mcp';",
    );
    // This tiny locator isolates module-resolution behavior. The real locator and
    // real Service are exercised separately below; no native process is started.
    writeFileSync(
      join(mcp, 'stdio-port.ts'),
      "import {fileURLToPath} from 'node:url';export function mcpStdioGuardianAsset(){ return fileURLToPath(new URL('./stdio-guardian.js',import.meta.url)); }",
    );
    writeFileSync(join(mcp, 'stdio-guardian.ts'), 'export const revision = 1;');
    writeFileSync(join(mcp, 'windows-stdio-guardian.ts'), 'export const revision = 1;');
    const output = join(root, 'output'),
      first = await buildDevelopmentService(root, output);
    const firstGuardian = join(output, 'services', first.id, 'stdio-guardian.js'),
      original = readFileSync(firstGuardian);
    const firstEntry = join(output, 'services', first.id, 'main.js');
    const loaded = await import(pathToFileURL(firstEntry).href);
    expect(loaded.locate()).toBe(firstGuardian);
    expect(loaded.marker).toBe('source-MCP');
    expect(readFileSync(firstEntry, 'utf8')).toContain('@kite-ai/agent/mcp');
    writeFileSync(join(mcp, 'stdio-guardian.ts'), 'export const revision = 2;');
    const second = await buildDevelopmentService(root, output),
      secondGuardian = join(output, 'services', second.id, 'stdio-guardian.js');
    expect(sha(secondGuardian)).not.toBe(sha(firstGuardian));
    expect(second.sourceSha256).not.toBe(first.sourceSha256);
    expect(readFileSync(firstGuardian)).toEqual(original);
    writeFileSync(join(mcp, 'stdio-guardian.ts'), 'export const revision = ;');
    await expect(buildDevelopmentService(root, output)).rejects.toThrow(
      'development_browser_assets_build_failed',
    );
    expect(readFileSync(firstGuardian)).toEqual(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(
  process.platform !== 'darwin' ||
    !existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
)(
  'actual development Service resolves Browser guardian without source guard bypass; missing compiled guardian fails closed without opening a browser',
  async () => {
    expect(() => mcpStdioGuardianAsset()).toThrow('mcp_stdio_asset_unavailable');
    const root = realpathSync(mkdtempSync(join(repository, '.cache/development-browser-service-')));
    const app = join(root, 'app');
    let service: Awaited<ReturnType<typeof launchPairedService>> | undefined;
    try {
      const built = await buildDevelopmentService(repository, app),
        entry = join(app, 'services', built.id, 'main.js');
      const guardian = join(app, 'services', built.id, 'stdio-guardian.js'),
        original = readFileSync(guardian);
      expect(original.length).toBeGreaterThan(1000);
      for (const missing of [false, true]) {
        const label = missing ? 'missing' : 'present',
          home = join(root, label, 'home');
        const user = ownedUserConfiguration(home);
        writeFileSync(user.path, '{}', { mode: 0o600 });
        if (missing) {
          renameSync(guardian, `${guardian}.saved`);
          writeFileSync(guardian.replace(/\.js$/, '.ts'), original);
        }
        const profile = selectProfile({
          dataRoot: join(root, label, 'data'),
          profile: 'development',
        });
        const workspace = join(root, label, 'workspace');
        mkdirSync(workspace, { recursive: true });
        service = await launchPairedService({
          entrypoint: entry,
          executable: realpathSync(process.execPath),
          buildId: `development-${built.sha256}`,
          instanceId: `development-browser-${label}`,
          apiMajor: 1,
          profile,
          spawnChild: (command, { env }) => {
            const isolated: NodeJS.ProcessEnv = { ...env, ...user.homeEnvironment };
            delete isolated.CODEX_HOME;
            return Bun.spawn([...command], {
              stdin: 'pipe',
              stdout: 'pipe',
              stderr: 'pipe',
              env: isolated,
            });
          },
          requiredCapabilities: ['commands', 'extension_queries'],
        });
        const client = service.client,
          expectedStoreId = service.bootstrap.storeId!;
        await client.createWorkspace({
          expectedStoreId,
          id: 'w',
          name: 'browser-read-only',
          rootUri: pathToFileURL(workspace).href,
        });
        await client.createSession({
          expectedStoreId,
          commandId: 'create',
          sessionId: 's',
          workspaceId: 'w',
          title: 'Browser configuration only',
        });
        const views = await client.queryExtension('s', 'builtin.browser', 'browser.view', {});
        if (missing)
          expect(views[0]?.payload).toMatchObject({
            state: 'unavailable',
            error: 'browser_runtime_unavailable',
          });
        else expect(views).toEqual([]); // Available inert controller; no Browser Job exists.
        expect((await client.getView('s')).executions).toHaveLength(0);
        await service.close();
        service = undefined;
        if (missing) renameSync(`${guardian}.saved`, guardian);
      }
      expect(readFileSync(guardian)).toEqual(original);
      expect(() => mcpStdioGuardianAsset()).toThrow('mcp_stdio_asset_unavailable');
    } finally {
      await service?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
