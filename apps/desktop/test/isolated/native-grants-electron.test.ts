import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { buildNativeDesktop } from '../../scripts/build-native';

const require = createRequire(import.meta.url);
async function bounded<T>(promise: Promise<T>, ms = 15000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('native_fixture_timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
test.skipIf(process.platform !== 'darwin')(
  'actual Electron grant directory/keyboard clear uses accepted Core facts, lost response only queries original ID, CAS conflict never retries and no Provider restarts',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-grants-')),
      profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'desktop' }),
      workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile }),
      storeId = (await store.getMetadata()).storeId;
    const finish: ModelEvent = {
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const responses: ModelEvent[][] = [];
    for (let i = 0; i < 2; i++) {
      responses.push(
        [
          {
            type: 'tool_call',
            id: `call-${i}`,
            name: 'fixture.command',
            arguments: '{"command":"harmless"}',
          },
          { ...finish, reason: 'tool_calls' },
        ],
        [finish],
      );
    }
    let effects = 0;
    const runtime = createRuntime({
      store,
      model: createFixedModel(responses),
      modelId: 'fixed',
      permissions: {
        async authorize(request) {
          return request.kind === 'model'
            ? { allowed: true, revision: 'policy' }
            : {
                allowed: false,
                revision: 'policy',
                approval: {
                  request: { title: 'Exact harmless command' },
                  grants: ['approve_once', 'same_command'],
                },
              };
        },
      },
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.command',
              version: '1',
              description: 'Harmless record',
              inputSchema: { type: 'object' },
              async execute() {
                effects++;
                return { outcome: 'succeeded', content: 'done' };
              },
            },
          ],
        },
      ],
    });
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'Native fixture',
      rootUri: `file://${workspace}`,
    });
    for (const id of ['s', 'other']) {
      await runtime.createSession({
        expectedStoreId: storeId,
        subjectId: 'local-user',
        commandId: `create-${id}`,
        sessionId: id,
        workspaceId: 'w',
        title: id === 's' ? 'Native A' : 'Native B',
      });
      await runtime.submitCommand({
        expectedStoreId: storeId,
        subjectId: 'local-user',
        commandId: `seed-${id}`,
        sessionId: id,
        request: { kind: 'run.start', content: 'harmless original' },
      });
      let card:
        | Awaited<ReturnType<typeof runtime.listInteractions>>['interactions'][number]
        | undefined;
      const deadline = Date.now() + 5000;
      while (!card) {
        card = (
          await runtime.listInteractions({
            expectedStoreId: storeId,
            sessionId: id,
            state: 'pending',
          })
        ).interactions[0];
        if (!card) {
          if (Date.now() > deadline) {
            console.error(
              'grant_seed_facts',
              JSON.stringify(await runtime.getView(id)),
              JSON.stringify(await runtime.getCommand(`seed-${id}`)),
            );
            await runtime.close();
            rmSync(root, { recursive: true, force: true });
            throw Error('grant_seed_timeout');
          }
          await Bun.sleep(10);
        }
      }
      await runtime.answerInteraction({
        expectedStoreId: storeId,
        subjectId: 'local-user',
        commandId: `answer-${id}`,
        presentationSessionId: id,
        interactionId: card.id,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve', grant: 'same_command' },
      });
      await runtime.waitForCommand(`seed-${id}`);
      expect(
        (
          await store.listPermissionGrants({
            expectedStoreId: storeId,
            subjectId: 'local-user',
            sessionId: id,
          })
        ).items,
      ).toHaveLength(1);
    }
    expect(effects).toBe(2);
    await runtime.close();
    let requests = 0;
    const control = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === '/count') return new Response(String(requests));
        requests++;
        return new Response('not configured', { status: 500 });
      },
    });
    const bunExecutable = realpathSync(process.execPath),
      serviceEntrypoint = join(root, 'service.js'),
      outdir = join(root, 'app');
    const service = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../../../service/src/main.ts')],
      target: 'bun',
      format: 'esm',
      packages: 'external',
      outdir: root,
      naming: 'service.js',
    });
    if (!service.success) throw new AggregateError(service.logs, 'private_service_build_failed');
    await buildNativeDesktop(
      {
        serviceEntrypoint,
        bunExecutable,
        serviceSha256: createHash('sha256').update(readFileSync(serviceEntrypoint)).digest('hex'),
        bunSha256: createHash('sha256').update(readFileSync(bunExecutable)).digest('hex'),
        buildId: 'native-grants-fixture',
        apiMajor: 1,
        requiredCapabilities: [
          'sessions',
          'history',
          'commands',
          'permission_controls',
          'permission_grants',
        ],
        profile: { dataRoot: profile.dataRoot, profile: profile.profile },
      },
      outdir,
    );
    const fixture = join(root, 'driver.ts');
    writeFileSync(
      fixture,
      readFileSync(
        resolve(import.meta.dir, '../native-grants-electron.fixture.ts'),
        'utf8',
      ).replace(
        "import { _electron } from 'playwright';",
        `import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dir, '../../package.json'))})('playwright');`,
      ),
    );
    const build = await Bun.build({
      entrypoints: [fixture],
      target: 'node',
      format: 'esm',
      packages: 'external',
      outdir: root,
      naming: 'driver.js',
    });
    if (!build.success) throw new AggregateError(build.logs, 'driver_build_failed');
    symlinkSync(
      resolve(import.meta.dir, '../../../../node_modules'),
      join(root, 'node_modules'),
      'dir',
    );
    const driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(root, 'driver.js'),
          outdir,
          root,
          storeId,
          require('electron') as string,
          `http://127.0.0.1:${control.port}`,
          bunExecutable,
        ],
        { stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } },
      ),
      stderr = new Response(driver.stderr).text(),
      stdout = new Response(driver.stdout).text();
    try {
      const exit = await bounded(driver.exited, 45000);
      const diagnostic = await stderr;
      if (exit !== 0) console.error(diagnostic.slice(0, 6000));
      expect(exit).toBe(0);
      const actualOutput = await stdout;
      expect(actualOutput).toContain('Native grants actual assertions: 13');
      console.info(actualOutput.trim());
      expect(requests).toBe(0);
      const reopened = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      try {
        for (const sessionId of ['s', 'other']) {
          const view = await reopened.getView(sessionId);
          expect(view.runs).toHaveLength(1);
          expect(view.executions.filter((execution) => execution.kind === 'model')).toHaveLength(2);
        }
      } finally {
        await reopened.close();
      }
    } finally {
      driver.kill('SIGKILL');
      await driver.exited;
      control.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
