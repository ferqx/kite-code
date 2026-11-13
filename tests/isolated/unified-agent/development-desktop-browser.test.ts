import { createHash } from 'node:crypto';
import {
  copyFileSync,
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
import { spawnNodePairedChild } from '@kite-ai/service/node-process';
import { launchPairedService } from '@kite-ai/service/paired';
import { expect, test } from '#kite-test';
import { fixtureNodeExecutable } from '../../../apps/service/test/fixtures/node-service-process';
import { ownedUserConfiguration } from '../../../apps/service/test/fixtures/user-configuration-fixture';
import { runtimeBuildOptions } from '../../../packages/agent/scripts/runtime-build-options';
import { mcpStdioGuardianAsset } from '../../../packages/agent/src/mcp/stdio-port';
import { buildDevelopmentService } from '../../../scripts/development/desktop-reload';
import { preparedDevelopmentNode } from '../../../scripts/release/node-inputs';
import { build as buildFixture } from '../../../scripts/tooling/bun-build';
import { spawnSync as runFixtureProcess } from '../../../scripts/tooling/process';

const repository = realpathSync(join(import.meta.dirname, '../../..'));
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function readBrowserLocators(executable: string, entrypoint: string) {
  const implementation = new URL('./implementation.js', pathToFileURL(entrypoint).href);
  const result = runFixtureProcess([
    executable,
    '--no-global-search-paths',
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(pathToFileURL(entrypoint).href)});const {locate,locateWorker,marker}=await import(${JSON.stringify(implementation.href)});console.log(JSON.stringify({guardian:locate(),worker:locateWorker(),marker}));`,
  ]);
  if (result.exitCode !== 0) throw Error(result.stderr.toString());
  return JSON.parse(result.stdout.toString());
}

test('development Browser guardian and executor assets share the fresh Service closure and failures cannot reuse an earlier build', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite dev browser \u96ea-')));
  try {
    expect(() => mcpStdioGuardianAsset()).toThrow('mcp_stdio_asset_unavailable');
    const dependency = join(root, 'node_modules/@kite-ai/agent');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(
      join(dependency, 'package.json'),
      JSON.stringify({
        type: 'module',
        exports: { './mcp': './mcp.js', './browser/executor': './executor.js' },
      }),
    );
    writeFileSync(join(dependency, 'mcp.js'), "export const marker = 'source-MCP';");
    writeFileSync(
      join(dependency, 'executor.js'),
      "export function browserExecutorWorkerAsset(){return 'stale-root-dist-worker';}",
    );
    const service = join(root, 'apps/service/src'),
      mcp = join(root, 'packages/agent/src/mcp'),
      executor = join(root, 'packages/agent/src/tools/browser/executor');
    mkdirSync(service, { recursive: true });
    mkdirSync(mcp, { recursive: true });
    mkdirSync(executor, { recursive: true });
    const native = join(root, 'packages/agent/dist');
    mkdirSync(native, { recursive: true });
    copyFileSync(
      join(repository, 'packages/agent/dist/runtime-native.node'),
      join(native, 'runtime-native.node'),
    );
    writeFileSync(
      join(service, 'main.ts'),
      "export {locate,locateWorker} from './browser-configuration'; export {marker} from '@kite-ai/agent/mcp';",
    );
    for (const entry of ['macos-model-keychain', 'linux-model-keyring'])
      writeFileSync(
        join(service, `${entry}.ts`),
        'export const modelKeyringOperation = () => null;',
      );
    writeFileSync(
      join(service, 'browser-configuration.ts'),
      "export {mcpStdioGuardianAsset as locate} from '@kite-ai/agent/mcp'; export {browserExecutorWorkerAsset as locateWorker} from '@kite-ai/agent/browser/executor';",
    );
    // This tiny locator isolates module-resolution behavior. The real locator and
    // real Service are exercised separately below; no native process is started.
    writeFileSync(
      join(mcp, 'stdio-port.ts'),
      "import {fileURLToPath} from 'node:url';export function mcpStdioGuardianAsset(){ return fileURLToPath(new URL('./stdio-guardian.js',import.meta.url)); }",
    );
    writeFileSync(join(mcp, 'stdio-guardian.ts'), 'export const revision = 1;');
    writeFileSync(join(mcp, 'windows-stdio-guardian.ts'), 'export const revision = 1;');
    writeFileSync(
      join(executor, 'assets.ts'),
      readFileSync(join(repository, 'packages/agent/src/tools/browser/executor/assets.ts')),
    );
    writeFileSync(
      join(executor, 'index.ts'),
      "export {browserExecutorWorkerAsset} from './assets';",
    );
    writeFileSync(join(executor, 'worker.ts'), 'export const revision = 1;');
    const executable = fixtureNodeExecutable();
    const output = join(root, 'output'),
      first = await buildDevelopmentService(root, output, executable);
    const firstGuardian = join(output, 'services', first.id, 'stdio-guardian.js'),
      original = readFileSync(firstGuardian);
    const firstEntry = join(output, 'services', first.id, 'main.js');
    const loaded = readBrowserLocators(executable, firstEntry);
    expect(loaded.guardian).toBe(firstGuardian);
    const firstWorker = join(output, 'services', first.id, 'tools/browser/executor/worker.mjs');
    expect(existsSync(firstWorker)).toBe(true);
    expect(loaded.worker).toBe(firstWorker);
    const originalWorker = readFileSync(firstWorker);
    expect(loaded.marker).toBe('source-MCP');
    expect(readFileSync(join(output, 'services', first.id, 'implementation.js'), 'utf8')).toContain(
      'node_modules/@kite-ai/agent/mcp.js',
    );
    writeFileSync(join(mcp, 'stdio-guardian.ts'), 'export const revision = 2;');
    writeFileSync(join(executor, 'worker.ts'), 'export const revision = 2;');
    const second = await buildDevelopmentService(root, output, executable),
      secondGuardian = join(output, 'services', second.id, 'stdio-guardian.js');
    expect(sha(secondGuardian)).not.toBe(sha(firstGuardian));
    const secondWorker = join(output, 'services', second.id, 'tools/browser/executor/worker.mjs');
    expect(sha(secondWorker)).not.toBe(sha(firstWorker));
    expect(readFileSync(firstWorker)).toEqual(originalWorker);
    const reloaded = readBrowserLocators(
      executable,
      join(output, 'services', second.id, 'main.js'),
    );
    expect(reloaded.worker).toBe(secondWorker);
    const currentWorker = readFileSync(secondWorker);
    writeFileSync(join(executor, 'worker.ts'), 'export const revision = ;');
    await expect(buildDevelopmentService(root, output, executable)).rejects.toThrow(
      'development_browser_assets_build_failed',
    );
    expect(readFileSync(firstWorker)).toEqual(originalWorker);
    expect(readFileSync(secondWorker)).toEqual(currentWorker);
    writeFileSync(join(executor, 'worker.ts'), 'export const revision = 2;');
    expect(second.sourceSha256).not.toBe(first.sourceSha256);
    expect(readFileSync(firstGuardian)).toEqual(original);
    writeFileSync(join(mcp, 'stdio-guardian.ts'), 'export const revision = ;');
    await expect(buildDevelopmentService(root, output, executable)).rejects.toThrow(
      'development_browser_assets_build_failed',
    );
    expect(readFileSync(firstGuardian)).toEqual(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('actual development Service builds the current browser executor worker beside its bundled locator', async () => {
  const output = realpathSync(mkdtempSync(join(repository, '.cache/development-browser-worker-')));
  try {
    const built = await buildDevelopmentService(repository, output);
    const directory = join(output, 'services', built.id),
      worker = join(directory, 'tools/browser/executor/worker.mjs');
    expect(readFileSync(worker).length).toBeGreaterThan(1000);
    // Independent same-source compilation proves this version did not copy the
    // checkout's pre-existing dist worker. Nothing executes the generated worker.
    const comparison = join(output, 'comparison');
    const expected = await buildFixture({
      entrypoints: [join(repository, 'packages/agent/src/tools/browser/executor/worker.ts')],
      ...runtimeBuildOptions(
        join(directory, 'tools/browser/executor'),
        join(repository, 'packages/agent/dist'),
      ),
      naming: 'worker.mjs',
      outdir: comparison,
      write: false,
    });
    expect(expected.success).toBe(true);
    expect(expected.outputs).toHaveLength(1);
    expect(existsSync(comparison)).toBe(false);
    expect(sha(worker)).toBe(
      createHash('sha256')
        .update(Buffer.from(await expected.outputs[0]!.arrayBuffer()))
        .digest('hex'),
    );
    const main = readFileSync(join(directory, 'implementation.js'), 'utf8');
    expect(main).toContain('./tools/browser/executor/worker.mjs');
    expect(main).not.toMatch(/from ["']@kite-ai\/agent\/browser\/executor["']/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 30000);

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
          executable: preparedDevelopmentNode(repository),
          buildId: `development-${built.sha256}`,
          instanceId: `development-browser-${label}`,
          apiMajor: 1,
          profile,
          spawnChild: (command, { env }) => {
            const isolated: Record<string, string> = { ...env, ...user.homeEnvironment };
            delete isolated.CODEX_HOME;
            return spawnNodePairedChild(command, { env: isolated });
          },
          requiredCapabilities: ['commands', 'extension_queries', 'trace_extensions'],
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
