import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  'ordinary Native follows real child Model prefixes through 100 main/child navigations with bounded retained renderer resources',
  async () => {
    const root = realpathSync(temporaryDirectory('kite-native-child-stream-'));
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'desktop' });
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const configuration = ownedUserConfiguration(root);
    const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    const storeId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'Child streams',
      rootUri: pathToFileURL(workspace).href,
    });
    await store.createSession({
      expectedStoreId: storeId,
      subjectId: 'local-user',
      commandId: 'create-parent',
      sessionId: 'parent',
      workspaceId: 'w',
      title: 'Stream Parent',
    });
    await store.close();
    const children = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    const calls: string[] = [];
    const frame = (delta: unknown, finish_reason: string | null = null) =>
      `data: ${JSON.stringify({ id: 'stream-fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const encode = (value: string) => new TextEncoder().encode(value);
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/count')
          return Response.json({ calls, children: [...children.keys()] });
        if (url.pathname === '/step') {
          const child = url.searchParams.get('child')!,
            marker = url.searchParams.get('marker')!;
          children.get(child)!.enqueue(encode(frame({ content: `\n\n${marker}\n\n` })));
          return Response.json({ sent: Date.now() });
        }
        if (url.pathname === '/finish') {
          for (const [child, controller] of children) {
            controller.enqueue(
              encode(`${frame({ content: `\n\n${child}_DONE` }, 'stop')}data: [DONE]\n\n`),
            );
            controller.close();
          }
          children.clear();
          return new Response('ok');
        }
        const body = (await request.json()) as {
          messages: {
            role: string;
            content: unknown;
            tool_calls?: { function: { name: string } }[];
          }[];
        };
        const message = [...body.messages]
          .reverse()
          .find(
            (row) =>
              row.role === 'user' &&
              typeof row.content === 'string' &&
              /^(STREAM_PARENT|CHILD_[AB])$/.test(row.content),
          );
        const marker = String(message?.content);
        const child = marker.includes('CHILD_A')
          ? 'CHILD_A'
          : marker.includes('CHILD_B')
            ? 'CHILD_B'
            : undefined;
        calls.push(child ?? 'PARENT');
        if (child)
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                children.set(child, controller);
                controller.enqueue(
                  encode(
                    frame({
                      content: `# ${child}\n\n${(`${'streamed paragraph 中文🙂 '.repeat(160)}\n\n`).repeat(36)}\n\n${child}_INITIAL_TAIL`,
                    }),
                  ),
                );
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        const tools = body.messages.filter((row) => row.role === 'tool').length;
        const hasWait = body.messages.some((row) =>
          row.tool_calls?.some((call) => call.function.name === 'wait_agent_events'),
        );
        const delta = tools
          ? hasWait
            ? { content: 'PARENT_DONE' }
            : {
                content: 'PARENT_WAITING',
                tool_calls: [
                  {
                    index: 0,
                    id: 'wait-for-children',
                    type: 'function',
                    function: {
                      name: 'wait_agent_events',
                      arguments: JSON.stringify({ after_seq: '0', wait_ms: 180000 }),
                    },
                  },
                ],
              }
          : {
              tool_calls: ['CHILD_A', 'CHILD_B'].map((content, index) => ({
                index,
                id: `task-${index}`,
                type: 'function',
                function: {
                  name: 'spawn_agent',
                  arguments: JSON.stringify({
                    prompt: content,
                    task_name: `child-${index}`,
                  }),
                },
              })),
            };
        return new Response(
          `${frame(delta) + frame({}, 'tool_calls' in delta ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
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
            },
          ],
          tools: [{ id: 'task.spawn', definitionVersion: '1' }],
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
          buildId: 'native-child-stream-fixture',
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
          resolve(import.meta.dir, '../native-child-stream-electron.fixture.ts'),
          'utf8',
        ).replace(
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
          ...(process.env.KITE_NATIVE_CHILD_STREAM_TEST_CAPTURE_ONLY === '1' ? ['capture'] : []),
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
          timer = setTimeout(() => reject(Error('child_stream_driver_timeout')), 110000);
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
      for (const controller of children.values()) {
        try {
          controller.close();
        } catch {}
      }
      provider.stop(true);
      owner?.capture();
      driver?.kill('SIGKILL');
      if (driver) await driver.exited;
      await owner?.settle(succeeded);
      if (owner?.confirmed && succeeded) rmSync(root, { recursive: true, force: true });
      else
        console.error(
          'native_child_stream_evidence_retained',
          root,
          owner?.metadata,
          owner?.errors,
        );
    }
    expect(owner?.confirmed).toBe(true);
    expect(owner?.errors).toHaveLength(0);
  },
  150000,
);
