import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { directoryLink, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { ownedUserConfiguration } from '../../../service/test/fixtures/user-configuration-fixture';
import { buildNativeDesktop } from '../../scripts/build-native';
import { NativeOwnedProcesses } from '../native-owned-processes.fixture';

const require = createRequire(import.meta.url);
test.skipIf(process.platform !== 'darwin')(
  'ordinary Native separates reasoning from stage prose across three Models, real reads, delayed tool facts, and reopened history',
  async () => {
    const root = realpathSync(temporaryDirectory('kite-native-reasoning-render-'));
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'desktop' });
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'read-only.txt'), 'ACTUAL_READ_ONLY_TOOL_RESULT\n');
    const configuration = ownedUserConfiguration(root);
    const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    const storeId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'Reasoning stream',
      rootUri: pathToFileURL(workspace).href,
    });
    await store.createSession({
      expectedStoreId: storeId,
      subjectId: 'local-user',
      commandId: 'create-parent',
      sessionId: 'parent',
      workspaceId: 'w',
      title: 'Reasoning Stream',
    });
    await store.createSession({
      expectedStoreId: storeId,
      subjectId: 'local-user',
      commandId: 'create-other',
      sessionId: 'other',
      workspaceId: 'w',
      title: 'Other Stream',
    });
    await store.close();
    let active: ReadableStreamDefaultController<Uint8Array> | undefined;
    let calls = 0;
    let toolObserved = false;
    const frame = (delta: unknown, finish_reason: string | null = null) =>
      `data: ${JSON.stringify({ id: 'reasoning-fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const send = (delta: unknown, finish?: string) =>
      active!.enqueue(new TextEncoder().encode(frame(delta, finish ?? null)));
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/count')
          return Response.json({ calls, active: !!active, toolObserved });
        if (url.pathname === '/step') {
          const stage = url.searchParams.get('stage');
          if (stage === 'long')
            send({ reasoning_content: 'PRIVATE_REASONING_SENTINEL '.repeat(20000) });
          else if (stage === 'stage-prose')
            send({ content: 'PUBLIC_STAGE_PROSE: I will read the isolated file.' });
          else if (stage === 'tool' || stage === 'pure-tool') {
            send(
              {
                tool_calls: Array.from({ length: stage === 'tool' ? 2 : 1 }, (_, index) => ({
                  index,
                  id: `read-only-call-${calls}-${index}`,
                  type: 'function',
                  function: {
                    name: 'read_file',
                    arguments: JSON.stringify({ path: 'read-only.txt' }),
                  },
                })),
              },
              'tool_calls',
            );
            active!.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            active!.close();
            active = undefined;
          } else if (stage === 'body') send({ content: 'PUBLIC_LIVE_PREFIX' });
          else if (stage === 'later-reasoning')
            send({ reasoning_content: ' PRIVATE_REASONING_SENTINEL_AFTER_BODY' });
          else if (stage === 'finish') {
            send({ content: '\n\nPUBLIC_FINAL_REPLY' }, 'stop');
            active!.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            active!.close();
            active = undefined;
          } else return new Response('invalid_stage', { status: 400 });
          return Response.json({ stage, sent: Date.now() });
        }
        const body = (await request.json()) as { messages: { role: string; content: string }[] };
        calls++;
        if (calls >= 2) {
          const tool = body.messages.find((message) => message.role === 'tool');
          toolObserved = !!tool?.content.includes('ACTUAL_READ_ONLY_TOOL_RESULT');
        }
        if (calls > 3) return new Response('unexpected_extra_model', { status: 500 });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              active = controller;
              if (calls !== 2)
                send({
                  reasoning_content:
                    calls === 1
                      ? 'PRIVATE_REASONING_SENTINEL_INITIAL'
                      : 'PRIVATE_REASONING_SENTINEL_SECOND_MODEL',
                });
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    let owner: NativeOwnedProcesses | undefined;
    let outputReads: Promise<string>[] = [];
    let readFailures: unknown[] = [];
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
            },
          ],
          tools: [{ id: 'files.read', definitionVersion: '5' }],
        }),
      );
      const serviceOutdir = join(root, 'apps/service/dist');
      mkdirSync(serviceOutdir, { recursive: true });
      directoryLink(
        resolve(import.meta.dir, '../../../service/node_modules'),
        join(root, 'apps/service/node_modules'),
      );
      const serviceEntrypoint = join(serviceOutdir, 'service.js'),
        bunExecutable = realpathSync(process.execPath);
      const built = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../../../service/src/main.ts')],
        target: 'bun',
        format: 'esm',
        packages: 'external',
        outdir: serviceOutdir,
        naming: 'service.js',
      });
      expect(built.success).toBe(true);
      const outdir = join(root, 'app');
      await buildNativeDesktop(
        {
          serviceEntrypoint,
          bunExecutable,
          serviceSha256: createHash('sha256').update(readFileSync(serviceEntrypoint)).digest('hex'),
          bunSha256: createHash('sha256').update(readFileSync(bunExecutable)).digest('hex'),
          buildId: 'native-reasoning-render-fixture',
          apiMajor: 1,
          requiredCapabilities: ['sessions', 'history', 'commands', 'permission_controls'],
          profile: { dataRoot: profile.dataRoot, profile: profile.profile },
        },
        outdir,
      );
      const source = join(root, 'driver.ts'),
        driverPath = join(root, 'driver.js');
      writeFileSync(
        source,
        readFileSync(
          resolve(import.meta.dir, '../native-reasoning-render-electron.fixture.ts'),
          'utf8',
        )
          .replace(
            "'./native-model-selection.fixture'",
            JSON.stringify(resolve(import.meta.dir, '../native-model-selection.fixture.ts')),
          )
          .replace(
            "import { _electron } from 'playwright';",
            `import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dir, '../../package.json'))})('playwright');`,
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
      directoryLink(
        resolve(import.meta.dir, '../../../../node_modules'),
        join(root, 'node_modules'),
      );
      driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          driverPath,
          outdir,
          root,
          require('electron') as string,
          provider.url.href.replace(/\/$/, ''),
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
      const capture = (stream: ReadableStream<Uint8Array>, path: string) =>
        new Response(
          stream.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, target) {
                appendFileSync(path, chunk);
                target.enqueue(chunk);
              },
            }),
          ),
        ).text();
      const stdout = capture(driver.stdout, join(root, 'driver.stdout.log')),
        stderr = capture(driver.stderr, join(root, 'driver.stderr.log'));
      outputReads = [stdout, stderr];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exit = await Promise.race([
        driver.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('reasoning_render_driver_timeout')), 110000);
        }),
      ]).finally(() => clearTimeout(timer));
      const output = await stdout,
        errors = await stderr;
      writeFileSync(join(root, 'driver.stdout.log'), output);
      writeFileSync(join(root, 'driver.stderr.log'), errors);
      if (exit !== 0) console.error(errors.slice(-8000), output.slice(-3000), root);
      expect(exit).toBe(0);
      console.log(output.trim());
      succeeded = true;
    } finally {
      try {
        active?.close();
      } catch {}
      provider.stop(true);
      owner?.capture();
      driver?.kill('SIGKILL');
      if (driver) await driver.exited;
      await owner?.settle(succeeded);
      const drained = await Promise.allSettled(outputReads);
      readFailures = drained.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (owner?.confirmed && succeeded) rmSync(root, { recursive: true, force: true });
      else
        console.error(
          'native_reasoning_render_evidence_retained',
          root,
          owner?.metadata,
          owner?.errors,
        );
    }
    expect(readFailures).toHaveLength(0);
    expect(owner?.confirmed).toBe(true);
    expect(owner?.errors).toHaveLength(0);
  },
  150000,
);
