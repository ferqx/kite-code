import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
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
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { buildNativeCandidate } from '../../scripts/build-native';

const require = createRequire(import.meta.url);
test.skipIf(process.platform !== 'darwin')(
  'relocated default Native Provider forms, four physical protocol families, transient effort and cold original save lookup',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-provider-bundle-')),
      home = join(root, 'home'),
      moved = join(root, 'relocated');
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(join(home, 'workspace'));
    const profile = selectProfile({
      dataRoot: join(home, '.kite-code/unified-agent'),
      profile: 'default',
    });
    const bodies: { alias: string; body: any }[] = [],
      discovery: string[] = [];
    let releaseHeld: (() => void) | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined,
      driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    const leases: ReturnType<typeof acquireArtifactAccess>[] = [];
    let completed = false;
    try {
      const { buildTerminalBundle } = await import(
        resolve(import.meta.dir, '../../../../scripts/release/terminal-bundle.ts')
      );
      const terminal = await buildTerminalBundle({ destination: join(root, 'terminal-build') });
      const built = await buildNativeCandidate({
        terminalRoot: terminal.root,
        electronDist: resolve(dirname(dirname(require('electron') as string)), '../..'),
        outdir: join(root, 'source'),
      });
      renameSync(join(root, 'source'), moved);
      rmSync(terminal.root, { recursive: true, force: true });
      expect(verifyNativeRuntimeBundle(moved).digest).toBe(built.digest);
      const candidate = verifyNativeRuntimeBundle(moved);
      leases.push(
        acquireArtifactAccess({ root: moved, mode: 'shared' }),
        acquireArtifactAccess({ root: candidate.terminal.root, mode: 'shared' }),
      );
      initializeSqliteEngine({
        root: join(candidate.terminal.root, 'node_modules/@kite-ai/agent/storage/engine'),
        manifestSha256: candidate.terminal.manifest.sqlite.manifestSha256,
      });
      const seed = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      let storeId: string;
      try {
        storeId = (await seed.getMetadata()).storeId;
        await seed.createWorkspace({
          expectedStoreId: storeId,
          id: 'w',
          name: 'Providers',
          rootUri: new URL(`file://${join(home, 'workspace')}`).href,
        });
        for (const id of ['a', 'b'])
          await seed.createSession({
            expectedStoreId: storeId,
            subjectId: 'local-user',
            commandId: `create-${id}`,
            sessionId: id,
            workspaceId: 'w',
            title: `Provider ${id.toUpperCase()}`,
          });
      } finally {
        await seed.close();
      }
      server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === '/release') {
            releaseHeld?.();
            return new Response('released');
          }
          if (url.pathname === '/count') return new Response(String(bodies.length));
          const alias = url.pathname.split('/')[1]!;
          expect(['openai', 'deepseek', 'compatible', 'ollama']).toContain(alias);
          if (url.pathname.endsWith('/models')) {
            discovery.push(alias);
            return Response.json({ data: [{ id: 'model-ollama' }] });
          }
          expect(url.pathname.endsWith('/chat/completions')).toBe(true);
          if (alias === 'openai' || alias === 'deepseek')
            expect(request.headers.get('authorization')).toBe(
              `Bearer owned-fixture-${alias}-nonpaid`,
            );
          const body = await request.json();
          bodies.push({ alias, body });
          if (
            JSON.stringify(body.messages).includes('NATIVE_compatible_held') &&
            !JSON.stringify(body.messages).includes('NATIVE_plain_steer')
          )
            await new Promise<void>((resolve) => {
              releaseHeld = resolve;
            });
          const frame = (delta: any, finish_reason: string | null) =>
            `data: ${JSON.stringify({ id: `provider-${bodies.length}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
          return new Response(
            frame({ content: `Controlled ${alias} result` }, null) +
              frame({}, 'stop') +
              'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      });
      writeFileSync(join(profile.profilePath, 'config.jsonc'), JSON.stringify({ models: [] }));
      const fixture = join(root, 'driver.ts');
      writeFileSync(
        fixture,
        readFileSync(
          resolve(import.meta.dir, '../native-provider-electron.fixture.ts'),
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
      driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(root, 'driver.js'),
          moved,
          home,
          server.url.href.replace(/\/$/, ''),
          storeId!,
        ],
        {
          cwd: home,
          env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const out = new Response(driver.stdout).text(),
        err = new Response(driver.stderr).text(),
        timer = setTimeout(() => driver!.kill('SIGKILL'), 110000);
      try {
        const code = await driver.exited,
          stdout = await out,
          stderr = await err;
        console.log(stdout);
        if (code) console.error({ root, stderr, bodies, discovery });
        expect(code).toBe(0);
      } finally {
        clearTimeout(timer);
      }
      const report = JSON.parse(readFileSync(join(home, 'provider-report.json'), 'utf8'));
      writeFileSync(join(root, 'physical-wire.json'), JSON.stringify(bodies));
      expect(discovery).toEqual(['ollama']);
      expect(bodies.slice(0, 4).map((x) => x.alias)).toEqual([
        'openai',
        'ollama',
        'deepseek',
        'compatible',
      ]);
      expect(bodies.slice(0, 4).map((x) => x.body.reasoning_effort)).toEqual([
        'high',
        undefined,
        undefined,
        'low',
      ]);
      expect(bodies.slice(4).map((x) => x.alias)).toEqual([
        'compatible',
        'compatible',
        'openai',
        'openai',
      ]);
      expect(bodies.slice(4).map((x) => x.body.reasoning_effort)).toEqual([
        'low',
        'low',
        'high',
        undefined,
      ]);
      expect(report.refsRevoked).toBe(2);
      for (const pid of report.pids) expect(() => process.kill(pid, 0)).toThrow();
      const cold = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      const artifacts = createArtifactStore({ profile, store: cold });
      try {
        const cursor = (await cold.getMetadata()).lastChangeCursor;
        let wireCursor = 0;
        async function expand(value: any) {
          if (!value?.body) return value;
          const ref = value.body.reference;
          const bytes = await artifacts.read({
            expectedStoreId: storeId!,
            refId: ref.id,
            sessionId: ref.sessionId,
            subjectId: ref.subjectId,
            scope: ref.scope,
          });
          expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.hash);
          expect(bytes.byteLength).toBe(ref.size);
          return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        }
        for (const run of report.runs) {
          const original = await cold.getRun(run.id);
          expect(original?.status).toBe('completed');
          const command = await cold.getCommand(original!.originCommandId);
          expect(command!.originStoreId).toBe(storeId!);
          expect(command!.sessionId).toBe(run.sessionId);
          expect((command!.request as any).content).toBe(run.marker);
          expect((command!.request as any).modelId).toBe(run.modelId);
          const executions = (await cold.listExecutions(run.sessionId)).filter(
            (x) => x.runId === run.id && x.kind === 'model',
          );
          expect(executions.length).toBe(run.marker.endsWith('_held') ? 2 : 1);
          const config = original!.configuration as any;
          expect(config.modelId).toBe(run.modelId);
          expect(config.snapshot.configuration.modelId).toBe(run.modelId);
          for (const execution of executions) {
            const sealed = await cold.getModelInputSnapshot({
              expectedStoreId: storeId!,
              sessionId: run.sessionId,
              executionId: execution.id,
              subjectId: 'local-user',
            });
            const request = await expand(sealed.input),
              metadata = await expand(sealed.metadata),
              wire = bodies[wireCursor++]!;
            expect((command!.request as any).reasoningEffort).toBe(wire.body.reasoning_effort);
            expect(sealed.identity.modelId).toBe(run.modelId);
            expect(request.modelId).toBe(run.modelId);
            expect(JSON.stringify(request)).toContain(run.marker);
            expect(metadata.adapter.provider.family).toBe(
              wire.alias === 'compatible' ? 'openai-compatible' : wire.alias,
            );
            expect(metadata.adapter.provider.modelId).toBe(wire.body.model);
            expect(metadata.adapter.settings.reasoningEffort).toBe(wire.body.reasoning_effort);
            const selected = config.snapshot.configuration.models.find(
              (m: any) => m.id === run.modelId,
            );
            expect(selected.provider).toBe(wire.alias);
            expect(selected.model).toBe(wire.body.model);
            expect(selected.options?.reasoningEffort).toBe(wire.body.reasoning_effort);
            expect(selected.baseURL).toBe(
              `${server!.url.href.replace(/\/$/, '')}/${wire.alias}/v1`,
            );
            expect(JSON.stringify({ sealed, request, metadata })).not.toContain('owned-fixture-');
            console.log(
              'provider_cold_model_input',
              JSON.stringify({ runId: run.id, identity: sealed.identity, metadata }),
            );
          }
        }
        expect(report.steers).toHaveLength(1);
        const steer = await cold.getCommand(report.steers[0].request.commandId);
        expect(steer!.request).toMatchObject({
          kind: 'input.steer',
          content: 'NATIVE_plain_steer',
          targetRunId: report.runs.find((r: any) => r.marker.endsWith('_held')).id,
        });
        expect('modelId' in (steer!.request as any)).toBe(false);
        expect('reasoningEffort' in (steer!.request as any)).toBe(false);
        expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
        expect(bodies).toHaveLength(8);
      } finally {
        await artifacts.close();
        await cold.close();
      }
      for (const lease of leases.splice(0)) lease.release();
      for (const path of [moved, candidate.terminal.root]) {
        const exclusive = acquireArtifactAccess({ root: path, mode: 'exclusive' });
        exclusive.release();
      }
      console.log(
        JSON.stringify({
          root,
          sourceFree: true,
          defaultVault: true,
          nativeDigest: built.digest,
          terminalDigest: candidate.terminal.digest,
          aliases: 4,
          modelCalls: bodies.length,
          discoveries: discovery.length,
          coldLookupGets: 1,
          ownedServicePids: report.pids,
        }),
      );
      completed = true;
    } finally {
      if (driver && !driver.exitCode) driver.kill('SIGKILL');
      server?.stop(true);
      for (const lease of leases) lease.release();
      if (completed) rmSync(root, { recursive: true, force: true });
      else console.error('provider_failed_candidate_retained', root);
    }
  },
  180000,
);
