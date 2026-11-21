import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { accessSync, constants, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentBrowserExecutableAsset } from '@kite-ai/agent/browser';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { buildDevelopmentService } from '../../../scripts/development/desktop-reload';
import { directoryLink, temporaryDirectory } from '../../../tests/fixtures/test-filesystem';
import { ownedUserConfiguration } from '../../service/test/fixtures/user-configuration-fixture';
import { buildNativeDesktop } from '../scripts/build-native';
import { prepareMacosElectronRuntime } from '../scripts/macos-electron-runtime';
import { NativeOwnedProcesses } from './native-owned-processes.fixture';

/** Opt-in local Native acceptance. Does not configure a real provider, profile or CI lane. */
async function main() {
  assert.ok(process.platform === 'darwin' && process.arch === 'arm64', 'requires macOS arm64');
  const root = realpathSync(temporaryDirectory('kite-native-browser-background-'));
  console.log('browser_background_evidence_root', root);
  accessSync(agentBrowserExecutableAsset(), constants.X_OK);
  const ownerPackage = resolve(import.meta.dir, '../package.json');
  const require = createRequire(ownerPackage);
  const runtime = prepareMacosElectronRuntime({
    sourceDist: join(dirname(realpathSync(require.resolve('electron/package.json'))), 'dist'),
    outdir: join(root, 'electron-runtime'),
  });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'desktop' });
  const config = ownedUserConfiguration(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const store = await openSqliteStore(profile);
  try {
    const { storeId } = await store.getMetadata();
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'workspace',
      name: 'Owned browser acceptance',
      rootUri: pathToFileURL(workspace).href,
    });
    for (const [id, title] of [
      ['browser-a', 'Browser A'],
      ['browser-b', 'Browser B'],
    ] as const)
      await store.createSession({
        expectedStoreId: storeId,
        subjectId: 'local-user',
        commandId: `create-${id}`,
        workspaceId: 'workspace',
        sessionId: id,
        title,
      });
  } finally {
    await store.close();
  }
  const db = new Database(profile.databasePath, { readonly: true });
  const requests: string[] = [];
  const effects: { at: number; receipt: string }[] = [];
  let release!: () => void;
  const later = new Promise<void>((resolve) => {
    release = resolve;
  });
  const response = (delta: Record<string, unknown>, reason: 'tool_calls' | 'stop') => {
    const frame = (value: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({
        id: 'owned-browser-acceptance',
        object: 'chat.completion.chunk',
        model: 'fixture',
        choices: [{ index: 0, delta: value, finish_reason: finish }],
      })}\n\n`;
    return new Response(`${frame(delta, null)}${frame({}, reason)}data: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  const call = (index: number, code: string) =>
    response(
      {
        tool_calls: [
          {
            index: 0,
            id: `owned-browser-call-${index}`,
            type: 'function',
            function: { name: 'browser_execute', arguments: JSON.stringify({ code }) },
          },
        ],
      },
      'tool_calls',
    );
  const html = `<!doctype html><title>Owned Browser Acceptance</title>
    <button id="marker">Set local marker</button><p id="receipt" role="status">Not marked</p>
    <script>
      document.querySelector('#marker').addEventListener('click', async () => {
        const response = await fetch('/effect', { method: 'POST' });
        if (response.ok) document.querySelector('#receipt').textContent = 'Marked';
      });
    </script>`;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { pathname, origin } = new URL(request.url);
      if (pathname === '/page' && request.method === 'GET')
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      if (pathname === '/effect' && request.method === 'POST') {
        effects.push({ at: Date.now(), receipt: 'marked' });
        return new Response(null, { status: 204 });
      }
      if (pathname === '/release' && request.method === 'POST') {
        release();
        return new Response(null, { status: 204 });
      }
      if (pathname === '/facts' && request.method === 'GET')
        return Response.json({
          effects,
          requests,
          runs: db
            .query(`
            SELECT r.id, r.status, e.cursor AS completedCursor
            FROM run r LEFT JOIN change_event e
              ON e.object_id = r.id AND e.scope_session_id = r.session_id AND e.type = 'run.finished'
            WHERE r.session_id = 'browser-a'`)
            .all(),
          tools: db
            .query(`
            SELECT adapter_id AS adapterId, state, completed_cursor AS completedCursor
            FROM execution WHERE session_id = 'browser-a' AND adapter_id = 'browser.execute'
            ORDER BY completed_cursor`)
            .all(),
        });
      if (pathname !== '/v1/chat/completions' || request.method !== 'POST')
        return new Response(null, { status: 404 });
      const body = (await request.json()) as {
        messages: { role: string; content: unknown }[];
        tools?: { function?: { name?: string } }[];
      };
      if (!body.tools?.length) return response({ content: 'Browser acceptance' }, 'stop');
      if (!body.tools.some((tool) => tool.function?.name === 'browser_execute'))
        throw Error('model_browser_execute_unavailable');
      if (
        !body.messages.some(
          (row) =>
            row.role === 'user' && String(row.content).includes('BROWSER_BACKGROUND_ACCEPTANCE'),
        )
      )
        throw Error('unexpected_model_input');
      const receipts = body.messages.filter((row) => row.role === 'tool');
      if (!receipts.length) {
        requests.push('initial-tool');
        return call(
          1,
          `var page = await browser.open(${JSON.stringify(`${origin}/page`)});
var state = await page.snapshot();
console.log(state.snapshot);`,
        );
      }
      if (receipts.length === 1) {
        if (!String(receipts[0]!.content).includes('Set local marker'))
          throw Error(
            `first_browser_tool_unconfirmed: ${String(receipts[0]!.content).slice(0, 700)}`,
          );
        requests.push('later-tool-gated');
        await later;
        return call(
          2,
          `var observed = await page.snapshot();
var marker = observed.elements.find(element => element.name === 'Set local marker');
if (!marker) throw Error('local_marker_not_observed');
await page.click(marker.ref);
await page.wait('Marked', 5000);
var verified = await page.snapshot();
if (!verified.snapshot.includes('Marked')) throw Error('local_marker_not_verified');
console.log('MARKER_VERIFIED');
await page.close();`,
        );
      }
      if (receipts.length !== 2 || !String(receipts[1]!.content).includes('MARKER_VERIFIED'))
        throw Error(
          `later_browser_tool_unconfirmed: ${String(receipts.at(-1)?.content).slice(0, 700)}`,
        );
      requests.push('final');
      return response({ content: 'BACKGROUND MARKER COMPLETE' }, 'stop');
    },
    error(error) {
      console.error('browser_background_provider_failure', error.message);
      return new Response('owned fixture provider failed', { status: 400 });
    },
  });
  let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let processOwner: NativeOwnedProcesses | undefined;
  let completed = false,
    failure: unknown;
  try {
    writeFileSync(
      config.path,
      JSON.stringify({
        modelId: 'fixture',
        models: [
          {
            id: 'fixture',
            provider: 'compatible',
            model: 'fixture',
            baseURL: `${server.url.origin}/v1`,
            modelCapabilities: { contextWindowTokens: 1_000_000 },
          },
        ],
      }),
    );
    const repository = resolve(import.meta.dir, '../../..');
    directoryLink(join(repository, 'node_modules'), join(root, 'node_modules'));
    const service = await buildDevelopmentService(repository, root);
    const serviceEntrypoint = join(root, 'services', service.id, 'main.js');
    const outdir = join(root, 'app');
    const bunExecutable = realpathSync(process.execPath);
    const bunSha256 = new Bun.CryptoHasher('sha256')
      .update(await Bun.file(bunExecutable).bytes())
      .digest('hex');
    await buildNativeDesktop(
      {
        serviceEntrypoint,
        bunExecutable,
        serviceSha256: service.sha256,
        bunSha256,
        buildId: 'native-browser-background-fixture',
        apiMajor: 1,
        requiredCapabilities: ['sessions', 'history', 'commands', 'permission_controls'],
        profile: { dataRoot: profile.dataRoot, profile: profile.profile },
      },
      outdir,
      { macosResize: runtime.resize },
    );
    const driverPath = join(root, 'driver.mjs');
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, 'native-browser-background-driver.fixture.ts')],
      target: 'node',
      format: 'esm',
      outdir: root,
      naming: 'driver.mjs',
    });
    if (!built.success) throw new AggregateError(built.logs, 'browser_background_driver_build');
    const nodeExecutable = realpathSync(Bun.which('node')!);
    driver = Bun.spawn(
      [
        nodeExecutable,
        driverPath,
        root,
        outdir,
        runtime.executable,
        ownerPackage,
        server.url.origin,
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      },
    );
    const stdout = new Response(driver.stdout).text();
    const stderr = (async () => {
      const decoder = new TextDecoder();
      let tail = '';
      for await (const chunk of driver!.stderr) {
        const data = decoder.decode(chunk, { stream: true });
        process.stderr.write(data);
        tail += data;
        const lines = tail.split('\n');
        tail = (lines.pop() ?? '').slice(-2048);
        for (const line of lines) {
          if (!line.startsWith('browser_background_phase ')) continue;
          processOwner ??= new NativeOwnedProcesses({
            pid: driver!.pid,
            nodeExecutable,
            driverPath,
            root,
          });
          if (/^browser_background_phase (window_ready|sent_a|a_terminal_under_b)$/.test(line))
            processOwner.capture();
        }
      }
    })();
    const timer = setTimeout(() => {
      release();
      driver!.kill('SIGKILL');
    }, 75000);
    try {
      const [code, out] = await Promise.all([driver.exited, stdout, stderr]);
      if (out) process.stdout.write(out);
      assert.equal(code, 0, 'browser_background_driver_failed');
      completed = true;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    failure = error;
  } finally {
    release();
    if (driver?.exitCode === null) {
      processOwner?.capture();
      driver.kill('SIGKILL');
      await driver.exited;
    }
    server.stop(true);
    db.close();
    await processOwner?.settle(completed);
  }
  if (driver && (!processOwner?.confirmed || processOwner.errors.length))
    throw new AggregateError(
      [...(failure === undefined ? [] : [failure]), ...(processOwner?.errors ?? [])],
      'browser_background_cleanup_unconfirmed',
    );
  if (failure !== undefined) throw failure;
}
if (import.meta.main) await main();
