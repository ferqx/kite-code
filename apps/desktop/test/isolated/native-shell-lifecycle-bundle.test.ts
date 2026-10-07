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
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { buildNativeCandidate } from '../../scripts/build-native';
import {
  type NativeShellProcessIdentity,
  openNativeShellObservation,
} from '../native-shell-observation.fixture';

const require = createRequire(import.meta.url);
test.skipIf(process.platform !== 'darwin')(
  'installed default Native creates host Shell Jobs, stops the exact full tree and cold reads original output after Main and Service faults',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-shell-lifecycle-')),
      home = join(root, 'home'),
      moved = join(root, 'relocated'),
      prefix = join(root, 'installed'),
      workspace = join(home, 'workspace'),
      executable = join(workspace, 'tree'),
      effects = join(workspace, 'effects');
    const { installNativeBundle, uninstallNativeBundle } = await import(
      resolve(import.meta.dir, '../../../../scripts/release/native-install.ts')
    );
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const profile = selectProfile({
      dataRoot: join(home, '.kite-code/unified-agent'),
      profile: 'default',
    });
    const observation = openNativeShellObservation(),
      trees = new Map<string, NativeShellProcessIdentity[]>(),
      processes = new Map<number, NativeShellProcessIdentity>(),
      calls: { marker: string; tools: number }[] = [],
      controlEvidence: unknown[] = [];
    let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined,
      stdout: Promise<string> | undefined,
      stderr: Promise<string> | undefined,
      candidateRoot = '',
      storeId = '',
      failure: unknown,
      qualification: unknown,
      completed = false;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const labels = ['exact', 'main', 'service'];
    const readTree = async (label: string) => {
      if (!labels.includes(label)) throw Error('unexpected_tree_label');
      const path = join(workspace, `${label}.pids`);
      await until(
        () =>
          existsSync(path) &&
          existsSync(effects) &&
          readFileSync(effects, 'utf8').includes(`${label}\n`),
      );
      const pids = readFileSync(path, 'utf8').trim().split(/\s+/).map(Number);
      expect(pids).toHaveLength(3);
      const identities = pids.map((pid) => observation.observe(pid));
      expect(identities.every((identity) => !!identity)).toBe(true);
      const actual = identities as NativeShellProcessIdentity[];
      expect(new Set(actual.map((identity) => identity.coalition)).size).toBe(1);
      expect(actual[0]!.coalition).not.toBe('0');
      expect(actual.every((identity) => identity.executable === executable)).toBe(true);
      expect(actual[2]!.parent).toBe(1);
      expect(actual[1]!.processGroup).toBe(actual[1]!.pid);
      expect(actual[2]!.processGroup).toBe(actual[1]!.processGroup);
      expect(actual[0]!.processGroup).not.toBe(actual[1]!.processGroup);
      expect(observation.coalitionCount(actual[0]!.coalition)).toBeGreaterThanOrEqual(4);
      const original = trees.get(label);
      if (original) expect(actual).toEqual(original);
      else trees.set(label, actual);
      const evidence = { stage: 'live_original_tree', label, identities: actual };
      controlEvidence.push(evidence);
      return evidence;
    };
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      // Control observations have a 25 s bound; the fixture's HTTP server must
      // not close them at Bun's independent 10 s default idle timeout.
      idleTimeout: 30,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/control/')) {
          try {
            const operation = url.pathname.slice('/control/'.length),
              label = url.searchParams.get('label') ?? '';
            if (operation === 'count') return Response.json({ calls: calls.length });
            if (operation === 'leases') {
              const held = { outer: false, inner: false };
              for (const [name, path] of [
                ['outer', candidateRoot],
                ['inner', join(candidateRoot, 'terminal')],
              ] as const) {
                try {
                  acquireArtifactAccess({ root: path, mode: 'exclusive' }).release();
                } catch (cause) {
                  expect(String(cause)).toContain('Lock is busy');
                  held[name] = true;
                }
              }
              controlEvidence.push({ stage: 'installed_candidate_leases', ...held });
              return Response.json(held);
            }
            if (operation === 'uninstall-busy') {
              const active = readFileSync(join(prefix, 'active'), 'utf8');
              expect(() => uninstallNativeBundle(prefix)).toThrow('Lock is busy');
              expect(readFileSync(join(prefix, 'active'), 'utf8')).toBe(active);
              expect(existsSync(candidateRoot)).toBe(true);
              const evidence = { stage: 'installed_uninstall_busy', active };
              controlEvidence.push(evidence);
              return Response.json(evidence);
            }
            if (operation === 'tree') return Response.json(await readTree(label));
            if (operation === 'flush') {
              const stream = url.searchParams.get('stream'),
                bytes = Number(url.searchParams.get('bytes'));
              expect(labels.includes(label) && ['stdout', 'stderr'].includes(stream!)).toBe(true);
              expect(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 198000).toBe(true);
              await until(async () => {
                const store = await openSqliteStore({
                  dataRoot: profile.dataRoot,
                  profile: profile.profile,
                  mode: 'readonly',
                });
                try {
                  const execution = (await store.listExecutions('native-shell')).find(
                    (entry) =>
                      entry.definitionId === 'shell.command' &&
                      (entry.input as { command?: string }).command?.endsWith(
                        `${quote(label)} ${quote(provider.url.port)}`,
                      ),
                  );
                  if (!execution) return false;
                  let afterSeq = '0',
                    upperSeq: string | undefined,
                    savedBytes = 0;
                  for (;;) {
                    const output = await store.listExecutionOutput({
                      executionId: execution.id,
                      afterSeq,
                      limit: 200,
                      ...(upperSeq ? { upperSeq } : {}),
                    });
                    upperSeq ??= output.highWaterSeq;
                    savedBytes += output.items
                      .filter((item) => item.stream === stream)
                      .reduce((total, item) => total + Buffer.byteLength(item.content), 0);
                    afterSeq = String(
                      output.items.reduce(
                        (maximum, item) =>
                          BigInt(item.throughSeq) > maximum ? BigInt(item.throughSeq) : maximum,
                        BigInt(afterSeq),
                      ),
                    );
                    if (savedBytes >= bytes) return true;
                    if (afterSeq === upperSeq) return false;
                    if (!output.items.length) throw Error('native_shell_flush_output_incomplete');
                  }
                } finally {
                  await store.close();
                }
              });
              return Response.json({ saved: true, label, stream, bytes });
            }
            if (operation === 'process') {
              const pid = Number(url.searchParams.get('pid'));
              const identity = observation.observe(pid);
              expect(identity).toBeDefined();
              expect(identity!.executable.startsWith(`${candidateRoot}/`)).toBe(true);
              processes.set(pid, identity!);
              return Response.json(identity);
            }
            if (operation === 'signal') {
              const identity = processes.get(Number(url.searchParams.get('pid')));
              expect(identity).toBeDefined();
              observation.signal(identity!, 9);
              return Response.json({ signalled: identity });
            }
            if (operation === 'absent') {
              const identities = trees.get(label);
              expect(identities).toBeDefined();
              await until(() => identities!.every((identity) => !observation.present(identity)));
              const coalition = identities![0]!.coalition;
              await until(() => {
                const count = observation.coalitionCount(coalition);
                return count === 'absent' || count === 0;
              });
              const evidence = {
                stage: 'original_tree_absent',
                label,
                identities,
                coalition,
                taskCount: observation.coalitionCount(coalition),
                observations: observation.diagnostics(),
              };
              controlEvidence.push(evidence);
              return Response.json(evidence);
            }
            if (operation === 'process-absent') {
              const identity = processes.get(Number(url.searchParams.get('pid')));
              expect(identity).toBeDefined();
              await until(() => !observation.present(identity!));
              return Response.json({ absent: identity });
            }
            if (operation === 'snapshot') return Response.json(await snapshot(profile));
            return new Response('unknown_control', { status: 404 });
          } catch (cause) {
            return Response.json({ error: String(cause) }, { status: 500 });
          }
        }
        const body = (await request.json()) as {
          messages: { role: string; content: unknown }[];
        };
        const latest = body.messages.filter((message) => message.role === 'user').at(-1),
          marker =
            typeof latest?.content === 'string' ? latest.content : JSON.stringify(latest?.content),
          start = body.messages.lastIndexOf(latest!),
          tools = body.messages
            .slice(start + 1)
            .filter((message) => message.role === 'tool').length;
        if (!['HOST_FIRST', 'HOST_SERVICE'].includes(marker))
          return new Response('unexpected_model_input', { status: 500 });
        calls.push({ marker, tools });
        const delta = tools
          ? { content: `${marker}_DONE` }
          : {
              tool_calls: (marker === 'HOST_FIRST' ? ['exact', 'main'] : ['service']).map(
                (label, index) => ({
                  index,
                  id: `${marker}-${label}`,
                  type: 'function',
                  function: {
                    name: 'shell.launch',
                    arguments: JSON.stringify({
                      key: label,
                      command: `${quote(executable)} ${quote(join(workspace, `${label}.pids`))} ${quote(effects)} ${quote(label)} ${quote(provider.url.port)}`,
                      cancellation: 'detached',
                    }),
                  },
                }),
              ),
            };
        const frame = (value: unknown, finish: string | null) =>
          `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
        return new Response(
          `${frame(delta, null)}${frame({}, tools ? 'stop' : 'tool_calls')}data: [DONE]\n\n`,
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        );
      },
    });
    try {
      const compiler = Bun.spawn(
        [
          '/usr/bin/clang',
          '-Wall',
          '-Wextra',
          '-Werror',
          resolve(import.meta.dir, '../native-shell-tree.fixture.c'),
          '-o',
          executable,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const compilerError = await new Response(compiler.stderr).text();
      await new Response(compiler.stdout).text();
      expect(await compiler.exited, compilerError).toBe(0);
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
      expect(existsSync(join(root, 'source'))).toBe(false);
      expect(existsSync(terminal.root)).toBe(false);
      expect(verifyNativeRuntimeBundle(moved).digest).toBe(built.digest);
      const installed = installNativeBundle({ bundleRoot: moved, prefix });
      candidateRoot = installed.releaseRoot;
      const candidate = verifyNativeRuntimeBundle(candidateRoot);
      expect(candidate.digest).toBe(built.digest);
      expect(installed.candidateId).toBe(candidate.digest);
      expect(readFileSync(join(prefix, 'active'), 'utf8')).toBe(`${candidate.digest}\n\n`);
      rmSync(moved, { recursive: true, force: true });
      expect(existsSync(moved)).toBe(false);
      initializeSqliteEngine({
        root: join(candidate.terminal.root, 'node_modules/@kite-ai/agent/storage/engine'),
        manifestSha256: candidate.terminal.manifest.sqlite.manifestSha256,
      });
      const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      try {
        storeId = (await store.getMetadata()).storeId;
        await store.createWorkspace({
          expectedStoreId: storeId,
          id: 'w',
          name: 'Host Shell',
          rootUri: pathToFileURL(workspace).href,
        });
        await store.createSession({
          expectedStoreId: storeId,
          subjectId: 'local-user',
          commandId: 'create-shell',
          sessionId: 'native-shell',
          workspaceId: 'w',
          title: 'Default Host Shell',
        });
      } finally {
        await store.close();
      }
      writeFileSync(
        join(profile.profilePath, 'config.jsonc'),
        JSON.stringify({
          modelId: 'fixed',
          models: [
            {
              id: 'fixed',
              provider: 'compatible',
              model: 'fixed',
              baseURL: `${provider.url.href}v1`,
            },
          ],
          tools: [{ id: 'shell.launch', definitionVersion: '1' }],
        }),
        { mode: 0o600 },
      );
      writeFileSync(
        join(root, 'candidate-evidence.json'),
        JSON.stringify({
          nativeDigest: candidate.digest,
          terminalDigest: candidate.terminal.digest,
          sourceFree: true,
          productionDefaultService: true,
          productionDefaultShell: true,
          productionDefaultNetwork: true,
          installedLauncher: join(prefix, 'bin/kite-desktop'),
          installedCandidateRoot: candidateRoot,
          storeId,
          producer:
            'ordinary workspace native program via actual Native Full selection and shell.launch',
        }),
      );
      const fixture = join(root, 'driver.ts');
      writeFileSync(
        fixture,
        readFileSync(
          resolve(import.meta.dir, '../native-shell-lifecycle-electron.fixture.ts'),
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
          candidateRoot,
          home,
          storeId,
          provider.url.href.replace(/\/$/, ''),
          join(prefix, 'bin/kite-desktop'),
        ],
        {
          cwd: home,
          env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      stdout = new Response(driver.stdout).text();
      stderr = new Response(driver.stderr).text();
      const timer = setTimeout(() => driver!.kill('SIGKILL'), 170000);
      try {
        const code = await driver.exited;
        writeFileSync(join(root, 'driver.stdout.log'), await stdout);
        writeFileSync(join(root, 'driver.stderr.log'), await stderr);
        console.log(await stdout);
        if (code) console.error({ root, stderr: (await stderr).slice(0, 4000) });
        expect(code).toBe(0);
      } finally {
        clearTimeout(timer);
      }
      const report = JSON.parse(readFileSync(join(home, 'shell-lifecycle-report.json'), 'utf8'));
      expect(report.storeId).toBe(storeId);
      expect(report.jobs).toHaveLength(3);
      expect(report.servicePids).toHaveLength(3);
      expect(report.coldPhysical.every((row: { method: string }) => row.method === 'GET')).toBe(
        true,
      );
      expect(readFileSync(effects, 'utf8').trim().split('\n').sort()).toEqual(labels.sort());
      expect(calls).toHaveLength(4);
      expect(trees.size).toBe(3);
      expect(
        controlEvidence.filter(
          (row) => (row as { stage: string }).stage === 'original_tree_absent',
        ),
      ).toHaveLength(3);
      const cold = await snapshot(profile);
      expect(cold).toEqual(report.finalSnapshot);
      expect(cold.storeId).toBe(storeId);
      expect([...processes.values()].every((identity) => !observation.present(identity))).toBe(
        true,
      );
      for (const path of [candidateRoot, candidate.terminal.root])
        acquireArtifactAccess({ root: path, mode: 'exclusive' }).release();
      const preservedPaths = [
        profile.databasePath,
        join(profile.profilePath, 'desktop-private/data.sqlite'),
        join(profile.profilePath, 'config.jsonc'),
      ];
      const preserved = () =>
        preservedPaths.map((path) => ({
          path,
          inode: statSync(path).ino,
          sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
        }));
      const beforeUninstall = preserved();
      uninstallNativeBundle(prefix);
      expect(existsSync(prefix)).toBe(false);
      expect(preserved()).toEqual(beforeUninstall);
      qualification = {
        status: 'passed',
        report,
        controlEvidence,
        calls,
        installation: { ...installed, uninstalled: true, preserved: beforeUninstall },
      };
      completed = true;
    } catch (cause) {
      failure = cause;
    } finally {
      if (driver && driver.exitCode === null) {
        driver.kill('SIGKILL');
        await driver.exited;
      }
      if (stdout) writeFileSync(join(root, 'driver.stdout.log'), await stdout);
      if (stderr) writeFileSync(join(root, 'driver.stderr.log'), await stderr);
      // These paths belong exclusively to this installed candidate/workspace. Each
      // signal is kernel-matched to the observed original PID version.
      const cleanupFailures: unknown[] = [];
      let remaining: ReturnType<typeof observation.owned> | undefined;
      try {
        const owned = observation.owned([executable], candidateRoot ? [candidateRoot] : []);
        for (const identity of owned.identities) observation.signal(identity, 9);
        remaining = owned;
        await until(() => {
          remaining = observation.owned([executable], candidateRoot ? [candidateRoot] : []);
          return remaining.identities.length === 0 && remaining.unconfirmed.length === 0;
        });
        expect([...processes.values()].every((identity) => !observation.present(identity))).toBe(
          true,
        );
        writeFileSync(
          join(root, 'owned-cleanup.json'),
          JSON.stringify({
            remaining: remaining.identities,
            unconfirmed: remaining.unconfirmed,
            forced: owned.identities,
            confirmed: true,
            observations: observation.diagnostics(),
          }),
        );
        if (completed) expect(owned.identities).toHaveLength(0);
      } catch (cause) {
        cleanupFailures.push(cause);
        writeFileSync(
          join(root, 'owned-cleanup.json'),
          JSON.stringify({
            confirmed: false,
            cause: String(cause),
            remaining: remaining?.identities,
            unconfirmed: remaining?.unconfirmed,
            observations: observation.diagnostics(),
          }),
        );
      }
      provider.stop(true);
      for (const path of [candidateRoot, join(candidateRoot, 'terminal')].filter(
        (path) => candidateRoot && existsSync(path),
      )) {
        try {
          acquireArtifactAccess({ root: path, mode: 'exclusive' }).release();
        } catch (cause) {
          cleanupFailures.push(cause);
        }
      }
      observation.close();
      if (cleanupFailures.length)
        failure = new AggregateError(
          [failure, ...cleanupFailures].filter(Boolean),
          `Native Shell cleanup unconfirmed:${root}`,
        );
      if (completed && !failure) {
        writeFileSync(join(root, 'qualification.json'), JSON.stringify(qualification));
        console.log(
          JSON.stringify({
            stage: 'native_default_shell_qualified',
            root,
            storeId,
            providerCalls: calls.length,
          }),
        );
      } else
        writeFileSync(
          join(root, 'qualification.json'),
          JSON.stringify({ status: 'failed', cause: String(failure), controlEvidence, calls }),
        );
    }
    if (failure) throw failure;
  },
  240000,
);

async function until(read: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 25000;
  while (!(await read())) {
    if (Date.now() >= deadline) throw Error('native_shell_observation_timeout');
    await Bun.sleep(25);
  }
}

async function snapshot(profile: ReturnType<typeof selectProfile>) {
  const store = await openSqliteStore({
    dataRoot: profile.dataRoot,
    profile: profile.profile,
    mode: 'readonly',
  });
  try {
    const metadata = await store.getMetadata(),
      view = await store.getView('native-shell'),
      executions = await store.listExecutions('native-shell');
    const jobs = await Promise.all(
      executions
        .filter((execution) => execution.definitionId === 'shell.command')
        .map(async (execution) => {
          let afterSeq = '0',
            highWaterSeq: string | undefined;
          const items: Awaited<ReturnType<typeof store.listExecutionOutput>>['items'] = [];
          for (;;) {
            const page = await store.listExecutionOutput({
              executionId: execution.id,
              afterSeq,
              limit: 200,
              ...(highWaterSeq ? { upperSeq: highWaterSeq } : {}),
            });
            highWaterSeq ??= page.highWaterSeq;
            items.push(...page.items);
            afterSeq = String(
              page.items.reduce(
                (maximum, item) =>
                  BigInt(item.throughSeq) > maximum ? BigInt(item.throughSeq) : maximum,
                BigInt(afterSeq),
              ),
            );
            if (afterSeq === highWaterSeq)
              return { executionId: execution.id, highWaterSeq, items };
            if (!page.items.length) throw Error('native_shell_output_incomplete');
          }
        }),
    );
    return {
      storeId: metadata.storeId,
      cursor: metadata.lastChangeCursor,
      runs: view.runs,
      executions,
      jobs,
    };
  } finally {
    await store.close();
  }
}
