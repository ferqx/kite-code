import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
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
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { buildNativeCandidate } from '../../scripts/build-native';

const require = createRequire(import.meta.url);
test.skipIf(process.platform !== 'darwin')(
  'source-free default Native cold window reads real opt-in Shell Job complete Unicode output without execution replay',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-job-output-bundle-')),
      home = join(root, 'home'),
      moved = join(root, 'relocated');
    mkdirSync(home, { mode: 0o700 });
    const workspace = join(home, 'workspace'),
      secondWorkspace = join(home, 'workspace-two');
    mkdirSync(workspace);
    mkdirSync(secondWorkspace);
    const profile = selectProfile({
      dataRoot: join(home, '.kite-code/unified-agent'),
      profile: 'default',
    });
    let producerCalls = 0;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        producerCalls++;
        return new Response('unexpected cold Provider call', { status: 500 });
      },
    });
    let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined,
      out: Promise<string> | undefined,
      err: Promise<string> | undefined,
      completed = false,
      cleanupUnconfirmed = false,
      failure: unknown;
    const leases: ReturnType<typeof acquireArtifactAccess>[] = [],
      candidatePaths: string[] = [],
      cleanupFailures: unknown[] = [];
    try {
      const { buildTerminalBundle } = await import(
        resolve(import.meta.dir, '../../../../scripts/release/terminal-bundle.ts')
      );
      // Production default process Service: no source, resolver, Runtime, credential,
      // model, OAuth, network-policy or processHostFixture injection.
      const terminal = await buildTerminalBundle({ destination: join(root, 'terminal-build') });
      const built = await buildNativeCandidate({
        terminalRoot: terminal.root,
        electronDist: resolve(dirname(dirname(require('electron') as string)), '../..'),
        outdir: join(root, 'source'),
      });
      renameSync(join(root, 'source'), moved);
      rmSync(terminal.root, { recursive: true, force: true });
      expect(existsSync(join(root, 'source'))).toBe(false);
      expect(existsSync(terminal.root)).toBe(false);
      const candidate = verifyNativeRuntimeBundle(moved);
      expect(candidate.digest).toBe(built.digest);
      leases.push(
        acquireArtifactAccess({ root: moved, mode: 'shared' }),
        acquireArtifactAccess({ root: candidate.terminal.root, mode: 'shared' }),
      );
      candidatePaths.push(moved, candidate.terminal.root);
      initializeSqliteEngine({
        root: join(candidate.terminal.root, 'node_modules/@kite-ai/agent/storage/engine'),
        manifestSha256: candidate.terminal.manifest.sqlite.manifestSha256,
      });
      const seeded = await seedJob({
        root,
        workspace,
        profile,
        providerURL: `${provider.url.href}v1`,
      });
      const { storeId, jobId, baseline, expected } = seeded;
      writeFileSync(join(home, 'original-job.json'), JSON.stringify(seeded));
      const fixture = join(root, 'driver.ts');
      writeFileSync(
        fixture,
        readFileSync(
          resolve(import.meta.dir, '../native-job-output-electron.fixture.ts'),
          'utf8',
        ).replace(
          "import { _electron } from 'playwright';",
          `import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dir, '../../package.json'))})('playwright');`,
        ),
      );
      expect(
        (
          await Bun.build({
            entrypoints: [fixture],
            target: 'node',
            format: 'esm',
            packages: 'external',
            outdir: root,
            naming: 'driver.js',
          })
        ).success,
      ).toBe(true);
      writeFileSync(
        join(root, 'candidate-evidence.json'),
        JSON.stringify({
          nativeDigest: built.digest,
          terminalDigest: candidate.terminal.digest,
          sourceFree: true,
          productionDefaultService: true,
          productionDefaultNetwork: true,
          credentials: false,
          home,
          storeId: storeId!,
          producer: 'explicit opt-in Full Shell',
          jobId,
          originalCursor: baseline.cursor,
        }),
      );
      driver = Bun.spawn(
        [realpathSync(Bun.which('node')!), join(root, 'driver.js'), moved, home, storeId!],
        {
          cwd: home,
          env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      out = new Response(driver.stdout).text();
      err = new Response(driver.stderr).text();
      // New qualification budget includes two real Native launches and full saved
      // Unicode output and multiple complete refreshes; existing job deadlines are unchanged.
      const timer = setTimeout(() => driver!.kill('SIGKILL'), 150000);
      try {
        const code = await driver.exited,
          stdout = await out,
          stderr = await err;
        writeFileSync(join(root, 'driver.stdout.log'), stdout);
        writeFileSync(join(root, 'driver.stderr.log'), stderr);
        console.log(stdout);
        if (code) console.error({ root, stderr: stderr.slice(0, 4000) });
        expect(code).toBe(0);
      } finally {
        clearTimeout(timer);
      }
      const report = JSON.parse(readFileSync(join(home, 'job-output-report.json'), 'utf8')) as {
        pids: number[];
        physical: { method: string }[];
        coldPhysical: { method: string }[];
        bytePages: { highWaterSeq: string; items: number; bytes: number }[];
      };
      expect(report.pids).toHaveLength(2);
      for (const pid of report.pids) expect(() => process.kill(pid, 0)).toThrow();
      expect(producerCalls).toBe(0);
      expect(report.physical.every((row) => row.method === 'GET')).toBe(true);
      expect(report.coldPhysical.every((row) => row.method === 'GET')).toBe(true);
      expect(report.bytePages.length).toBeGreaterThan(1);
      expect(report.bytePages.every((row) => row.bytes <= 524288)).toBe(true);
      expect(new Set(report.bytePages.map((row) => row.highWaterSeq)).size).toBe(1);
      const coldStore = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      try {
        expect((await coldStore.getMetadata()).storeId).toBe(storeId);
        expect((await coldStore.getMetadata()).lastChangeCursor).toBe(baseline.cursor);
        const view = await coldStore.getView('job-output-window');
        expect(view.runs).toEqual(baseline.runs);
        expect(await coldStore.listExecutions('job-output-window')).toEqual(baseline.executions);
        const result = await allOutput(coldStore, jobId);
        expect(result).toEqual(expected);
        expect((await coldStore.getMetadata()).lastChangeCursor).toBe(baseline.cursor);
        console.log(
          JSON.stringify({
            stage: 'post_exit_cold_readonly_store',
            root,
            storeId,
            jobId,
            originalCursor: baseline.cursor,
            highWaterSeq: result.highWaterSeq,
            outputRecords: result.items.length,
            runIds: baseline.runs.map((run) => run.id),
            executionIds: baseline.executions.map((execution) => execution.id),
            providerCalls: producerCalls,
            pids: report.pids,
            nativeDigest: built.digest,
            terminalDigest: candidate.terminal.digest,
          }),
        );
      } finally {
        await coldStore.close();
      }
      completed = true;
    } catch (cause) {
      failure = cause;
    } finally {
      if (driver && driver.exitCode === null) {
        driver.kill('SIGKILL');
        await driver.exited;
      }
      if (out) writeFileSync(join(root, 'driver.stdout.log'), await out);
      if (err) writeFileSync(join(root, 'driver.stderr.log'), await err);
      if (driver) {
        const readRows = () =>
          String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
            .trim()
            .split('\n')
            .map((line) => {
              const parts = line.trim().split(/\s+/);
              return {
                pid: Number(parts[0]),
                parent: Number(parts[1]),
                command: parts.slice(2).join(' '),
              };
            });
        const rows = readRows();
        const originalIdentity = new Map(rows.map((row) => [row.pid, row.command]));
        const owned = new Set(
          rows.filter((row) => row.command.startsWith(`${moved}/`)).map((row) => row.pid),
        );
        for (let count = 0; count < rows.length; count++)
          for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
        for (const pid of owned)
          try {
            process.kill(pid, 'SIGTERM');
          } catch {}
        const until = Date.now() + 2000;
        while (
          Date.now() < until &&
          [...owned].some((pid) => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          })
        )
          await Bun.sleep(20);
        const forced: number[] = [];
        for (const pid of owned)
          try {
            process.kill(pid, 0);
            process.kill(pid, 'SIGKILL');
            forced.push(pid);
          } catch {}
        const remainingOwned = () => {
          const current = readRows(),
            targets = new Set(
              current
                .filter(
                  (row) =>
                    row.command.startsWith(`${moved}/`) ||
                    (owned.has(row.pid) && originalIdentity.get(row.pid) === row.command),
                )
                .map((row) => row.pid),
            );
          for (let count = 0; count < current.length; count++)
            for (const row of current) if (targets.has(row.parent)) targets.add(row.pid);
          return [...targets];
        };
        const disappearanceDeadline = Date.now() + 5000;
        let remaining = remainingOwned();
        while (remaining.length && Date.now() < disappearanceDeadline) {
          await Bun.sleep(50);
          remaining = remainingOwned();
        }
        cleanupUnconfirmed = remaining.length > 0;
        const cleanup = { observed: [...owned], forced, remaining, confirmed: !cleanupUnconfirmed };
        writeFileSync(join(root, 'owned-cleanup.json'), JSON.stringify(cleanup));
        console.log(JSON.stringify({ stage: 'owned_process_tree_cleanup', root, ...cleanup }));
      }
      provider.stop(true);
      // Release SH only after owned process disappearance has been checked.
      // A passing case must then prove both exact roots admit EX before removal.
      for (const lease of leases.splice(0)) lease.release();
      if (completed && !cleanupUnconfirmed) {
        for (const path of candidatePaths) {
          try {
            const exclusive = acquireArtifactAccess({ root: path, mode: 'exclusive' });
            exclusive.release();
          } catch (cause) {
            cleanupFailures.push(cause);
          }
        }
        console.log(
          JSON.stringify({
            stage: 'candidate_exclusive_after_cleanup',
            root,
            roots: candidatePaths,
            confirmed: cleanupFailures.length === 0,
          }),
        );
      }
      if (completed && !cleanupUnconfirmed && !cleanupFailures.length)
        rmSync(root, { recursive: true, force: true });
      else console.error('job_output_failed_candidate_retained', root);
    }
    if (cleanupUnconfirmed || cleanupFailures.length)
      throw new AggregateError(
        [
          failure,
          ...cleanupFailures,
          ...(cleanupUnconfirmed ? [Error(`native_owned_cleanup_unconfirmed:${root}`)] : []),
        ].filter(Boolean),
        'Native Job output fixture cleanup failed',
      );
    if (failure) throw failure;
  },
  240000,
);

async function allOutput(store: Awaited<ReturnType<typeof openSqliteStore>>, executionId: string) {
  let afterSeq = '0',
    highWaterSeq: string | undefined;
  const items: Awaited<ReturnType<typeof store.listExecutionOutput>>['items'] = [];
  for (;;) {
    const page = await store.listExecutionOutput({
      executionId,
      afterSeq,
      limit: 200,
      ...(highWaterSeq ? { upperSeq: highWaterSeq } : {}),
    });
    highWaterSeq ??= page.highWaterSeq;
    items.push(...page.items);
    afterSeq = String(
      page.items.reduce(
        (cursor, row) => (BigInt(row.throughSeq) > cursor ? BigInt(row.throughSeq) : cursor),
        BigInt(afterSeq),
      ),
    );
    if (afterSeq === highWaterSeq) return { executionId, highWaterSeq, items };
    if (!page.items.length) throw Error('seed_output_incomplete');
  }
}
async function seedJob({
  root,
  workspace,
  profile,
  providerURL,
}: {
  root: string;
  workspace: string;
  profile: ReturnType<typeof selectProfile>;
  providerURL: string;
}) {
  const block = '原始完整输出中文🙂'.repeat(100) + '\n';
  const repeats = 210;
  const script = join(workspace, 'produce.sh');
  writeFileSync(
    script,
    `i=0; while [ "$i" -lt ${repeats} ]; do printf '%s' '${block}'; printf '%s' '${block}' >&2; /bin/sleep 0.01; i=$((i+1)); done`,
  );
  const producer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string }[] };
      const results = body.messages.filter((row) => row.role === 'tool').length;
      const call =
        results === 0
          ? {
              name: 'shell.launch',
              input: { key: 'original', command: `/bin/sh '${script}'`, cancellation: 'detached' },
            }
          : results === 1
            ? { name: 'shell.wait', input: { shellId: 'original', timeoutMs: 10000 } }
            : undefined;
      const frame = (delta: unknown, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
      return new Response(
        frame(
          call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${results}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  },
                ],
              }
            : { content: 'ORIGINAL_JOB_DONE' },
          null,
        ) +
          frame({}, call ? 'tool_calls' : 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const config = {
    modelId: 'fixed',
    models: [
      { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${producer.url.href}v1` },
    ],
    tools: ['shell.launch', 'shell.wait'].map((id) => ({ id, definitionVersion: '1' })),
  };
  writeFileSync(join(profile.profilePath, 'config.jsonc'), JSON.stringify(config));
  const supervisor = await Bun.build({
    entrypoints: [
      resolve(
        import.meta.dir,
        '../../../../packages/agent/src/platform/process/shell-supervisor.ts',
      ),
    ],
    target: 'bun',
    outdir: join(root, 'producer'),
    naming: 'supervisor.js',
  });
  expect(supervisor.success).toBe(true);
  const host = createDefaultProcessConfiguration({
    profile,
    shell: {
      platform: 'darwin',
      configurationId: 'explicit-output-producer-1',
      env: { PATH: '/usr/bin:/bin' },
      supervisorPath: supervisor.outputs[0]!.path,
      bunExecutable: process.execPath,
      shellExecutable: '/bin/sh',
      graceMs: 20,
      maxQueuedBytes: 16 * 1024 * 1024,
    },
    permissionPolicy: {
      readPolicy: () => ({
        mode: 'full',
        workspaceTrust: true,
        revision: 'explicit-output-producer-full',
        allowed: [
          { kind: 'model', definitionId: 'fixed', definitionVersion: '1' },
          ...['shell.launch', 'shell.wait'].map((definitionId) => ({
            kind: 'tool' as const,
            definitionId,
            definitionVersion: '1',
          })),
          { kind: 'job', definitionId: 'shell.command', definitionVersion: '1' },
        ],
      }),
    },
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const runtime = createRuntime({
    ...host,
    store,
    permissions: host.permissions!,
    modelConcurrency: 1,
    processConcurrency: 1,
  });
  try {
    const storeId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'Original output',
      rootUri: pathToFileURL(workspace).href,
    });
    for (const [sessionId, title] of [
      ['job-output-window', 'Job Output Window'],
      ['second-output-window', 'Second Output Window'],
    ])
      await runtime.createSession({
        expectedStoreId: storeId,
        subjectId: 'local-user',
        commandId: `create-${sessionId}`,
        sessionId: sessionId!,
        workspaceId: 'w',
        title: title!,
      });
    await runtime.submitCommand({
      expectedStoreId: storeId,
      subjectId: 'local-user',
      sessionId: 'job-output-window',
      commandId: 'produce-original',
      request: { kind: 'run.start', content: 'Produce real complete Job output once' },
    });
    expect((await runtime.waitForCommand('produce-original', { timeoutMs: 20000 })).status).toBe(
      'applied',
    );
    const executions = await store.listExecutions('job-output-window');
    const job = executions.find((row) => row.definitionId === 'shell.command')!;
    expect(job?.status).toBe('succeeded');
    const group = (job.reference as { processGroupId: number }).processGroupId;
    expect(() => process.kill(-group, 0)).toThrow();
    const expected = await allOutput(store, job.id);
    for (const stream of ['stdout', 'stderr']) {
      const rows = expected.items.filter((row) => row.stream === stream);
      const retained = rows
        .filter((row) => row.droppedBytes === '0')
        .map((row) => row.content)
        .join('');
      expect(block.repeat(repeats).startsWith(retained)).toBe(true);
      expect(retained.length).toBeGreaterThan(0);
      const dropped = rows.reduce((sum, row) => sum + BigInt(row.droppedBytes ?? '0'), 0n);
      expect(BigInt(Buffer.byteLength(retained)) + dropped).toBe(
        BigInt(Buffer.byteLength(block) * repeats),
      );
    }
    expect(expected.items.some((row) => row.droppedBytes !== '0')).toBe(true);
    expect(expected.items.length).toBeGreaterThan(200);
    const baseline = {
      cursor: (await store.getMetadata()).lastChangeCursor,
      runs: (await store.getView('job-output-window')).runs,
      executions,
    };
    console.log(
      JSON.stringify({
        stage: 'real_opt_in_shell_producer',
        storeId,
        jobId: job.id,
        group,
        highWaterSeq: expected.highWaterSeq,
        records: expected.items.length,
        originalCursor: baseline.cursor,
      }),
    );
    return { storeId, jobId: job.id, baseline, expected };
  } finally {
    await runtime.close();
    producer.stop(true);
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'cold-fixed',
        models: [
          { id: 'cold-fixed', provider: 'compatible', model: 'fixed', baseURL: providerURL },
        ],
        tools: [],
      }),
    );
    rmSync(join(root, 'producer'), { recursive: true, force: true });
  }
}
