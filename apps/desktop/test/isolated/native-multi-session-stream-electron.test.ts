import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { ownedUserConfiguration } from '../../../service/test/fixtures/user-configuration-fixture';
import {
  buildMixedShellSupervisor,
  mixedShellConfiguration,
  writeMixedShellScript,
} from '../../../service/test/isolated/multi-session-shell-load.shared';
import { buildNativeDesktop } from '../../scripts/build-native';
import { NativeMemoryCensus } from '../native-memory-census.fixture';
import { NativeOwnedProcesses } from '../native-owned-processes.fixture';

const require = createRequire(import.meta.url);
// Test-host inputs only: neither value is forwarded to a normal desktop build.
const mixedShell = process.env.KITE_NATIVE_MULTI_SHELL === '1';
const workerProbeOnly = process.env.KITE_NATIVE_MULTI_PROBE === '1';
const memoryTag = process.env.KITE_NATIVE_MULTI_MEMORY_TAG;
if (memoryTag && (!mixedShell || !/^[a-z][a-z0-9-]{0,40}$/.test(memoryTag)))
  throw Error('invalid_native_memory_test_tag');
const mainInstrumentation = String.raw`
const originalFetch = globalThis.fetch;
const metrics = globalThis.multiStreamMetrics = {
  finite: { total: 0, active: 0, peak: 0, aborted: 0, bytes: 0, durations: [] },
  observe: { total: 0, active: 0, peak: 0 },
  holdNextModel: false, holdNextOutput: false, held: false,
};
globalThis.fetch = Object.assign(async (...args) => {
  const pathname = new URL(String(args[0])).pathname;
  const event = pathname === '/v1/events';
  const finite = /\/messages$|\/model-output$|\/background-executions$|\/output$/.test(pathname);
  const counters = event ? metrics.observe : finite ? metrics.finite : undefined;
  const signal = args[1]?.signal;
  const started = performance.now();
  let finished = false;
  const close = () => {
    if (!counters || finished) return;
    finished = true;
    counters.active--;
    signal?.removeEventListener('abort', onAbort);
    if (finite) { counters.durations.push(performance.now() - started); if(counters.durations.length > 4096) counters.durations.shift(); }
  };
  const onAbort = () => { if (finite && !finished) counters.aborted++; close(); };
  if (counters) {
    counters.total++; counters.active++; counters.peak = Math.max(counters.peak, counters.active);
    signal?.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await originalFetch(...args);
    if (!response.body || !counters) { close(); return response; }
    const body = response.body;
    const getReader = body.getReader.bind(body);
    const hold = (metrics.holdNextModel && pathname.endsWith('/model-output')) || (metrics.holdNextOutput && pathname.endsWith('/output'));
    if (hold) { metrics.holdNextModel = false; metrics.holdNextOutput = false; }
    Reflect.set(body, 'getReader', (...options) => {
      const reader = Reflect.apply(getReader, body, options);
      const read = reader.read.bind(reader), cancel = reader.cancel.bind(reader);
      let firstRead = true;
      Reflect.set(reader, 'read', async () => {
        try {
          if (hold && firstRead) {
            firstRead = false; metrics.held = true;
            try { await new Promise((resolve, reject) => {
              if (signal?.aborted) { reject(signal.reason); return; }
              const abortHold = () => { signal?.removeEventListener('abort', abortHold); reject(signal.reason); };
              metrics.release = () => { signal?.removeEventListener('abort', abortHold); resolve(); };
              signal?.addEventListener('abort', abortHold, { once: true });
            }); } finally { metrics.held = false; metrics.release = undefined; }
          }
          const result = await read();
          if (result.done) close();
          else if (finite) metrics.finite.bytes += result.value.byteLength;
          return result;
        } catch (error) { close(); throw error; }
      });
      Reflect.set(reader, 'cancel', async (reason) => { try { return await cancel(reason); } finally { close(); } });
      return reader;
    });
    return response;
  } catch(error) { close(); throw error; }
}, { preconnect: originalFetch.preconnect });
`;

test.skipIf(process.platform !== 'darwin')(
  workerProbeOnly
    ? 'ordinary Native packaged Markdown Worker asset probe'
    : `ordinary Native ${mixedShell ? 'mixed real Shell and Model load' : 'Model load'} switches among four live roots and twelve live children without replay, scope leakage or growing readers`,
  async () => {
    const root = realpathSync(temporaryDirectory('kite-native-multi-stream-'));
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'desktop' });
    const memoryDirectory = memoryTag
      ? resolve(
          import.meta.dir,
          '../../../../.cache/native-session-stream-evidence',
          `memory-${Date.now()}-${memoryTag}`,
        )
      : undefined;
    const memoryCensus = memoryDirectory
      ? new NativeMemoryCensus({
          databasePath: profile.databasePath,
          evidenceDir: memoryDirectory,
        })
      : undefined;
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const shell = mixedShell ? writeMixedShellScript(workspace) : undefined;
    const shellOptions = shell
      ? mixedShellConfiguration(profile, await buildMixedShellSupervisor(root))
      : undefined;
    const configuration = ownedUserConfiguration(root);
    const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    const storeId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'Multi-session streams',
      rootUri: pathToFileURL(workspace).href,
    });
    for (let index = 0; index < 4; index++)
      await store.createSession({
        expectedStoreId: storeId,
        subjectId: 'local-user',
        commandId: `create-root-${index}`,
        sessionId: `root-${index}`,
        workspaceId: 'w',
        title: `Live Root ${index}`,
      });
    await store.close();
    const streams = new Map<
      string,
      { controller: ReadableStreamDefaultController<Uint8Array>; tick: number }
    >();
    const calls: string[] = [],
      aborted: string[] = [];
    let finishing = false,
      shellProcessesCaptured = false;
    const frame = (delta: unknown, reason: string | null = null) =>
      `data: ${JSON.stringify({ id: 'multi-stream', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
    const encode = (value: string) => new TextEncoder().encode(value);
    const finishStreams = () => {
      for (const [marker, stream] of streams) {
        try {
          stream.controller.enqueue(
            encode(`${frame({ content: `\n${marker}_DONE` }, 'stop')}data: [DONE]\n\n`),
          );
          stream.controller.close();
        } catch {}
      }
      streams.clear();
    };
    const timer = setInterval(() => {
      for (const [marker, stream] of streams) {
        try {
          stream.controller.enqueue(
            encode(frame({ content: `\n\n${marker}_TICK_${++stream.tick}\n\n` })),
          );
        } catch {
          streams.delete(marker);
        }
      }
    }, 700);
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/gpu-memory-census' && memoryCensus) {
          const input = (await request.json()) as { stage: string; pid: number };
          try {
            return Response.json(await memoryCensus.collectGpu(input.stage, input.pid));
          } catch (cause) {
            return Response.json({ status: 'unknown', error: String(cause) }, { status: 500 });
          }
        }
        if (url.pathname === '/memory-census' && memoryCensus) {
          const input = (await request.json()) as {
            servicePid: number;
            electronPid: number;
            stage: string;
            physical: boolean;
          };
          const shells = Array.from({ length: 4 }, (_, index) => [
            `ROOT_${index}`,
            ...Array.from({ length: 3 }, (_, child) => `CHILD_${index}_${child}`),
          ])
            .flat()
            .map((label) => JSON.parse(readFileSync(shell!.ledgerPath(label), 'utf8')));
          try {
            return Response.json(await memoryCensus.collect({ ...input, shells }));
          } catch (cause) {
            return Response.json({ status: 'unknown', error: String(cause) }, { status: 500 });
          }
        }
        if (url.pathname === '/status') {
          const shells = shell
            ? Array.from({ length: 4 }, (_, index) => [
                `ROOT_${index}`,
                ...Array.from({ length: 3 }, (_, child) => `CHILD_${index}_${child}`),
              ])
                .flat()
                .flatMap((label) => {
                  try {
                    return [JSON.parse(readFileSync(shell.ledgerPath(label), 'utf8'))];
                  } catch {
                    return [];
                  }
                })
            : [];
          if (shells.length === 16 && !shellProcessesCaptured) {
            // One full launch receipt, outside navigation/cancellation timing.
            // Reading a 16-broker tree is test metadata work, not a Job timeout.
            owner?.capture(performance.now() + 3000);
            shellProcessesCaptured = true;
          }
          return Response.json({
            calls,
            active: [...streams].map(([marker, stream]) => ({ marker, tick: stream.tick })),
            aborted,
            shells,
          });
        }
        if (url.pathname === '/finish') {
          if (shell) writeFileSync(shell.finishPath, 'finish');
          finishing = true;
          finishStreams();
          return new Response('ok');
        }
        const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
        if (calls.length === 0) owner?.capture();
        const input = [...body.messages]
          .reverse()
          .find(
            (row) =>
              row.role === 'user' &&
              typeof row.content === 'string' &&
              /^MULTI_(ROOT_\d|CHILD_\d_\d)$/.test(row.content),
          );
        const original = String(input?.content).replace('MULTI_', '');
        if (!/^(ROOT_\d|CHILD_\d_\d)$/.test(original)) throw Error('provider_marker_missing');
        const tools = body.messages.filter((row) => row.role === 'tool').length;
        calls.push(`${original}:${tools ? 'after-tools' : 'initial'}`);
        if (finishing)
          return new Response(
            `${frame({ content: `${original}_FINAL` })}${frame({}, 'stop')}data: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          );
        if (!tools && (original.startsWith('ROOT_') || shell)) {
          const rootIndex = Number(original.slice(5));
          const delta = {
            tool_calls: [
              ...(shell
                ? [
                    {
                      index: 0,
                      id: `${original}-shell`,
                      type: 'function',
                      function: {
                        name: 'shell_launch',
                        arguments: JSON.stringify({
                          key: `shell-${original}`,
                          command: shell.shellCommand(original),
                          cancellation: 'attached',
                        }),
                      },
                    },
                  ]
                : []),
              ...Array.from({ length: original.startsWith('ROOT_') ? 3 : 0 }, (_, index) => ({
                index: index + (shell ? 1 : 0),
                id: `root-${rootIndex}-task-${index}`,
                type: 'function',
                function: {
                  name: 'spawn_agent',
                  arguments: JSON.stringify({
                    key: `child-${index}`,
                    role: 'worker',
                    input: { content: `MULTI_CHILD_${rootIndex}_${index}` },
                    cancellation: 'attached',
                    result_disposition: 'required',
                  }),
                },
              })),
            ],
          };
          return new Response(`${frame(delta)}${frame({}, 'tool_calls')}data: [DONE]\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        const padding = original.startsWith('ROOT_')
          ? 'Parent streaming sentence. '.repeat(35)
          : `${'Child streaming paragraph 中文🙂 '.repeat(120)}\n\n`.repeat(28);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.set(original, { controller, tick: 0 });
              controller.enqueue(
                encode(
                  frame({ content: `# ${original}\n\n${padding}\n\n${original}_INITIAL_TAIL` }),
                ),
              );
            },
            cancel() {
              streams.delete(original);
              aborted.push(original);
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    let owner: NativeOwnedProcesses | undefined;
    let succeeded = false;
    try {
      writeFileSync(
        configuration.path,
        JSON.stringify({
          modelId: 'fixture',
          models: [
            {
              id: 'fixture',
              provider: 'compatible',
              model: 'fixture',
              baseURL: `${provider.url.href}v1`,
              // This streaming Provider does not implement the summary algorithm.
              modelCapabilities: { contextWindowTokens: 1_000_000 },
            },
          ],
          tools: ['task', ...(shell ? ['shell.launch', 'shell.read', 'shell.stop'] : [])].map(
            (id) => ({ id, definitionVersion: '1' }),
          ),
        }),
      );
      const serviceOutdir = join(root, 'apps/service/dist');
      mkdirSync(serviceOutdir, { recursive: true });
      symlinkSync(
        resolve(import.meta.dir, '../../../service/node_modules'),
        join(root, 'apps/service/node_modules'),
        'dir',
      );
      const serviceEntrypoint = join(serviceOutdir, 'service.js'),
        bunExecutable = realpathSync(process.execPath);
      const serviceSource = join(root, 'multi-service.ts');
      writeFileSync(
        serviceSource,
        shellOptions
          ? `import { runServiceProcess } from ${JSON.stringify(resolve(import.meta.dir, '../../../service/src/main.ts'))};
import { createDefaultProcessConfiguration } from ${JSON.stringify(resolve(import.meta.dir, '../../../service/src/configuration.ts'))};
import { selectProfile } from '@kite-ai/agent/profile';
await runServiceProcess({ configure: (startup, host) => ({ ...createDefaultProcessConfiguration({ ordinaryHostTools: true, profile: selectProfile(startup.profile), observerSubjectId: host.subjectId, hostConfiguration: startup.hostConfiguration, shell: ${JSON.stringify(shellOptions)} }), modelConcurrency: 16, processConcurrency: 16 }) });`
          : `import { runServiceProcess } from ${JSON.stringify(resolve(import.meta.dir, '../../../service/src/main.ts'))}; await runServiceProcess({ decorateConfiguration: configuration => ({ ...configuration, modelConcurrency: 16 }) });`,
      );
      const built = await Bun.build({
        entrypoints: [serviceSource],
        target: 'bun',
        format: 'esm',
        packages: 'external',
        outdir: serviceOutdir,
        naming: 'service.js',
      });
      expect(built.success).toBe(true);
      const outdir = join(root, 'app');
      // Bun's test runner sets NODE_ENV=test. Qualify the production React
      // renderer explicitly; diagnostics remain build-time false throughout.
      const previousNodeEnvironment = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        await buildNativeDesktop(
          {
            serviceEntrypoint,
            bunExecutable,
            serviceSha256: createHash('sha256')
              .update(readFileSync(serviceEntrypoint))
              .digest('hex'),
            bunSha256: createHash('sha256').update(readFileSync(bunExecutable)).digest('hex'),
            buildId: 'native-multi-session-stream-fixture',
            apiMajor: 1,
            requiredCapabilities: ['sessions', 'history', 'commands', 'permission_controls'],
            profile: { dataRoot: profile.dataRoot, profile: profile.profile },
          },
          outdir,
        );
      } finally {
        if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnvironment;
      }
      // External test instrumentation precedes the real Main entry, so its one global
      // observe is measured from admission. It adds no UI, IPC or business authority.
      const mainPath = join(outdir, 'main.cjs');
      writeFileSync(join(outdir, 'runtime-main.cjs'), readFileSync(mainPath));
      writeFileSync(mainPath, `${mainInstrumentation}\nrequire('./runtime-main.cjs');\n`);
      const source = join(root, 'driver.ts'),
        driverPath = join(root, 'driver.js');
      writeFileSync(
        source,
        readFileSync(
          resolve(import.meta.dir, '../native-multi-session-stream-electron.fixture.ts'),
          'utf8',
        )
          .replace(
            "import { _electron } from 'playwright';",
            `import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dir, '../../package.json'))})('playwright');`,
          )
          .replace(
            "from './native-gpu-memory.fixture';",
            `from ${JSON.stringify(resolve(import.meta.dir, '../native-gpu-memory.fixture.ts'))};`,
          ),
      );
      expect(
        (
          await Bun.build({
            entrypoints: [source],
            target: 'node',
            format: 'esm',
            outdir: root,
            naming: 'driver.js',
            packages: 'external',
          })
        ).success,
      ).toBe(true);
      symlinkSync(
        resolve(import.meta.dir, '../../../../node_modules'),
        join(root, 'node_modules'),
        'dir',
      );
      driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          driverPath,
          outdir,
          root,
          require('electron') as string,
          provider.url.href.replace(/\/$/, ''),
          workerProbeOnly
            ? 'worker-probe'
            : process.env.KITE_NATIVE_MULTI_PROFILE === '1'
              ? 'profile'
              : 'normal',
          mixedShell ? 'mixed' : 'model',
          memoryDirectory ?? '',
        ],
        {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        },
      );
      owner = new NativeOwnedProcesses({
        pid: driver.pid,
        nodeExecutable: realpathSync(Bun.which('node')!),
        driverPath,
        root,
      });
      const stdout = new Response(driver.stdout).text(),
        stderr = new Response(driver.stderr).text();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exit = await Promise.race([
        driver.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('multi_stream_driver_timeout')), 160000);
        }),
      ]).finally(() => clearTimeout(timer));
      const output = await stdout,
        errors = await stderr;
      writeFileSync(join(root, 'driver.stdout.log'), output);
      writeFileSync(join(root, 'driver.stderr.log'), errors);
      if (exit !== 0) console.error(errors.slice(-8000), output.slice(-3000), root);
      expect(exit).toBe(0);
      if (memoryCensus) await memoryCensus.assertExited();
      console.log(output.trim());
      succeeded = true;
    } finally {
      clearInterval(timer);
      finishStreams();
      provider.stop(true);
      owner?.capture();
      driver?.kill('SIGKILL');
      if (driver) await driver.exited;
      await owner?.settle(succeeded);
      if (owner?.confirmed && succeeded) rmSync(root, { recursive: true, force: true });
      else
        console.error(
          'native_multi_stream_evidence_retained',
          root,
          owner?.metadata,
          owner?.errors,
        );
    }
    expect(owner?.confirmed).toBe(true);
    expect(owner?.errors).toHaveLength(0);
  },
  190000,
);
