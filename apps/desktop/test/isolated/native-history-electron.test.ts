import { Database } from 'bun:sqlite';
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
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { buildNativeDesktop } from '../../scripts/build-native';

const require = createRequire(import.meta.url);
function gate() {
  let release!: () => void, enter!: () => void;
  return {
    promise: new Promise<void>((r) => {
      release = r;
    }),
    entered: new Promise<void>((r) => {
      enter = r;
    }),
    release: () => release(),
    enter: () => enter(),
  };
}
async function bounded<T>(promise: Promise<T>, milliseconds = 15000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('native_fixture_timeout')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
test.skipIf(process.platform !== 'darwin')(
  'actual Electron automatically reads 5001 stored short messages and >8MiB multi-message history; failed/late pages retain original text with zero Model',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-history-')),
      barrier = gate(),
      compressionBarrier = gate();
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'desktop' }),
      workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    const storeId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'Native fixture',
      rootUri: new URL(`file://${workspace}`).href,
    });
    for (const id of ['s', 'other'])
      await store.createSession({
        expectedStoreId: storeId,
        subjectId: 'local-user',
        commandId: `create-${id}`,
        sessionId: id,
        workspaceId: 'w',
        title: id === 's' ? 'Native A' : 'Native B',
      });
    await store.close();
    // Explicit disposable historical records, not 5001 Provider calls or fabricated execution facts.
    const db = new Database(profile.databasePath);
    db.transaction(() => {
      const initial = Number(
        (db.query('SELECT next_seq FROM session WHERE id=?').get('s') as { next_seq: number })
          .next_seq,
      );
      // One completed fixture history Run provides an explicit original association; no execution/Provider was dispatched.
      db.query(
        "INSERT INTO run(id,session_id,origin_command_id,origin_store_id,root_work_command_id,root_work_seq,status,is_active,config_json,started_at,finished_at,context_selection_id,initialization_state) VALUES('stored-history-run','s','create-s',?,'create-s',1,'completed',0,'{}','0','1',(SELECT context_selection_id FROM session WHERE id='s'),'completed')",
      ).run(storeId);
      const insert = db.query(
        "INSERT INTO message(id,session_id,run_id,seq,role,status,source_json) VALUES(?,?,'stored-history-run',?,?,?,?)",
      );
      const part = db.query(
        'INSERT INTO message_part(message_id,ordinal,kind,content_version,revision,json) VALUES(?,0,?,1,0,?)',
      );
      for (let i = 1; i <= 5051; i++) {
        const content =
          i <= 5001
            ? `STORED_SHORT_${i}`
            : `${`${'Historical paragraph with original text. '.repeat(20)}\n`.repeat(250)}LARGE_HISTORY_TAIL_${i}`;
        const json = JSON.stringify({ content });
        insert.run(`stored-${i}`, 's', initial + i, 'assistant', 'complete', json);
        part.run(`stored-${i}`, 'text', json);
      }
      db.query('UPDATE session SET next_seq=? WHERE id=?').run(initial + 5051, 's');
    })();
    expect(
      Number(
        (db.query('SELECT sum(length(source_json)) AS size FROM message').get() as { size: number })
          .size,
      ),
    ).toBeGreaterThan(8 * 1048576);
    db.close();

    let requests = 0;
    const bodies: Record<string, unknown>[] = [];
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/expire-history-cursor') {
          const owned = new Database(profile.databasePath);
          try {
            owned
              .query('UPDATE storage_meta SET replay_floor=last_change_cursor WHERE singleton=1')
              .run();
            return Response.json(
              owned
                .query('SELECT store_id,last_change_cursor,replay_floor FROM storage_meta')
                .get(),
            );
          } finally {
            owned.close();
          }
        }
        if (path === '/release') {
          barrier.release();
          return new Response('ok');
        }
        if (path === '/release-compression') {
          compressionBarrier.release();
          return new Response('ok');
        }
        if (path === '/compression-entered') {
          await compressionBarrier.entered;
          return new Response('ok');
        }
        if (path === '/requests') return Response.json(bodies);
        if (path === '/count') return new Response(String(requests));
        if (path === '/entered') {
          await barrier.entered;
          return new Response('ok');
        }
        bodies.push((await request.json()) as Record<string, unknown>);
        requests++;
        const ordinal = requests;
        barrier.enter();
        if (ordinal === 2) compressionBarrier.enter();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: ' +
                    JSON.stringify({
                      id: 'native',
                      object: 'chat.completion.chunk',
                      choices: [
                        {
                          index: 0,
                          delta: { role: 'assistant', content: 'NATIVE STREAM START' },
                          finish_reason: null,
                        },
                      ],
                    }) +
                    '\n\n',
                ),
              );
              await barrier.promise;
              if (ordinal === 2) await compressionBarrier.promise;
              controller.enqueue(
                new TextEncoder().encode(
                  'data: ' +
                    JSON.stringify({
                      id: 'native',
                      object: 'chat.completion.chunk',
                      choices: [
                        {
                          index: 0,
                          delta: {
                            content:
                              ordinal === 1
                                ? 'Original actual answer with preserved source'
                                : ordinal === 2
                                  ? 'Factual recorded summary of original user and answer'
                                  : 'Next actual answer',
                          },
                          finish_reason: 'stop',
                        },
                      ],
                      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                    }) +
                    '\n\ndata: [DONE]\n\n',
                ),
              );
              controller.close();
            } catch {
              /* A canceled client owns its socket; no success is fabricated. */
            }
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'local',
        models: [
          {
            id: 'local',
            provider: 'compatible',
            model: 'local',
            baseURL: `http://127.0.0.1:${provider.port}/v1`,
          },
        ],
      }),
    );
    const serviceEntrypoint = join(root, 'service.js'),
      bunExecutable = realpathSync(process.execPath),
      outdir = join(root, 'app');
    const serviceBuild = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../../../service/src/main.ts')],
      target: 'bun',
      format: 'esm',
      packages: 'external',
      outdir: root,
      naming: 'service.js',
    });
    if (!serviceBuild.success)
      throw new AggregateError(serviceBuild.logs, 'private_service_build_failed');
    await buildNativeDesktop(
      {
        serviceEntrypoint,
        bunExecutable,
        serviceSha256: createHash('sha256').update(readFileSync(serviceEntrypoint)).digest('hex'),
        bunSha256: createHash('sha256').update(readFileSync(bunExecutable)).digest('hex'),
        buildId: 'native-electron-fixture',
        apiMajor: 1,
        requiredCapabilities: ['sessions', 'history', 'commands', 'permission_controls'],
        profile: { dataRoot: profile.dataRoot, profile: profile.profile },
      },
      outdir,
    );
    const instrumentation = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../native-history-network.fixture.ts')],
      target: 'node',
      format: 'cjs',
      outdir: root,
      naming: 'network.cjs',
    });
    if (!instrumentation.success)
      throw new AggregateError(instrumentation.logs, 'network_fixture_build_failed');
    const mainPath = join(outdir, 'main.cjs');
    writeFileSync(
      mainPath,
      `${readFileSync(join(root, 'network.cjs'), 'utf8')}\n${readFileSync(mainPath, 'utf8')}`,
    );
    const fixture = join(root, 'driver.ts'),
      driverPath = join(root, 'driver.js');
    writeFileSync(
      fixture,
      readFileSync(
        resolve(import.meta.dir, '../native-history-electron.fixture.ts'),
        'utf8',
      ).replace(
        "import { _electron } from 'playwright';",
        `import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dir, '../../package.json'))})('playwright');`,
      ),
    );
    symlinkSync(
      resolve(import.meta.dir, '../../../../node_modules'),
      join(root, 'node_modules'),
      'dir',
    );
    const built = await Bun.build({
      entrypoints: [fixture],
      target: 'node',
      format: 'esm',
      outdir: root,
      naming: 'driver.js',
      packages: 'bundle',
    });
    if (!built.success) throw new AggregateError(built.logs, 'driver_build_failed');
    const driver = Bun.spawn(
      [
        realpathSync(Bun.which('node')!),
        driverPath,
        outdir,
        root,
        profile.dataRoot,
        storeId,
        `127.0.0.1:${provider.port}`,
        require('electron') as string,
        `http://127.0.0.1:${provider.port}`,
        bunExecutable,
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      },
    );
    const stderrPromise = new Response(driver.stderr).text(),
      stdoutPromise = new Response(driver.stdout).text();
    try {
      const exit = await bounded(driver.exited, 75000);
      const stderr = await stderrPromise;
      if (exit !== 0) console.error(stderr.slice(0, 5000));
      expect(exit).toBe(0);
      const output = await stdoutPromise;
      console.info(output.trim());
      expect(output).toContain('Native History Node assertions:');
      expect(requests).toBe(0);
      const durable = new Database(profile.databasePath, { readonly: true });
      expect((durable.query('SELECT count(*) AS n FROM run').get() as { n: number }).n).toBe(1);
      expect(
        (
          durable.query("SELECT count(*) AS n FROM execution WHERE kind='model'").get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
      durable.close();
    } finally {
      barrier.release();
      compressionBarrier.release();
      driver.kill('SIGKILL');
      await driver.exited;
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  90000,
);
