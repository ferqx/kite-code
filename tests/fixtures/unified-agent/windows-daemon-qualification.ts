import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { DaemonBootstrap } from '../../../apps/service/src/daemon/bootstrap';
import {
  type TerminalBundleManifest,
  windowsTerminalRuntimeArguments,
} from '../../../apps/service/src/runtime-assets';
import { acquireArtifactAccess } from '../../../packages/agent/src/artifact-access';
import {
  startWindowsOwnedChild,
  type WindowsOwnedChild,
  WindowsOwnedChildStartError,
} from '../../../packages/agent/src/platform/process/windows-owned-child';
import type { OpenSqliteStoreOptions } from '../../../packages/agent/src/sqlite';
import type { Store } from '../../../packages/agent/src/storage/port';
import type { AgentClient } from '../../../packages/client/src';
import { serve as serveFixture } from '../../../scripts/tooling/http';

// Late opening/unknown closing never loses its original Store owner on deadline rejection.
const pendingColdOwners = new Set<object>();

type Candidate = {
  releaseRoot: string;
  candidateId: string;
  buildId: string;
  manifest: TerminalBundleManifest;
};
type QualificationStore = Pick<
  Store,
  | 'close'
  | 'createSession'
  | 'createWorkspace'
  | 'getCommand'
  | 'getExecution'
  | 'getMetadata'
  | 'getModelOutputSnapshot'
  | 'getView'
  | 'listExecutions'
  | 'listMessages'
>;
type StoreRequest = Exclude<keyof QualificationStore, 'close'>;
const pendingStoreProcesses = new Map<
  WindowsOwnedChild,
  ReturnType<typeof acquireArtifactAccess>
>();

/** Keep Store and its Worker on the installed runtime, including when reading Bun predecessors. */
export function windowsQualificationStore(input: {
  root: string;
  manifest: Pick<TerminalBundleManifest, 'nodeVersion' | 'sqlite'> & {
    entries: { runtime: string };
  };
  cwd: string;
  env: NodeJS.ProcessEnv;
  remaining(): number;
}) {
  const { root, manifest } = input;
  return {
    async openSqliteStore(options: OpenSqliteStoreOptions): Promise<QualificationStore> {
      input.remaining();
      const bounded = async <T>(promise: Promise<T>): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
              const ms = Math.min(30000, input.remaining());
              if (ms <= 0) throw Error('qualification_store_deadline');
              timer = setTimeout(() => reject(Error('qualification_store_deadline')), ms);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const artifact = acquireArtifactAccess({ root, mode: 'shared' });
      let owner: WindowsOwnedChild;
      try {
        owner = startWindowsOwnedChild({
          executable: join(root, manifest.entries.runtime),
          argv: [
            ...windowsTerminalRuntimeArguments(root, manifest.nodeVersion ? 'node' : 'bun'),
            fileURLToPath(
              new URL('./windows-daemon-qualification-store-driver.mjs', import.meta.url),
            ),
            root,
            JSON.stringify(options),
            manifest.sqlite.version,
            manifest.sqlite.sourceId,
          ],
          cwd: input.cwd,
          env: Object.fromEntries(
            Object.entries(input.env).filter(
              (row): row is [string, string] =>
                row[1] !== undefined &&
                ![
                  'NODE_OPTIONS',
                  'NODE_PATH',
                  'NODE_COMPILE_CACHE',
                  'NODE_V8_COVERAGE',
                  'BUN_OPTIONS',
                  'BUN_BE_BUN',
                ].includes(row[0].toUpperCase()),
            ),
          ),
          stdin: 'pipe',
        });
      } catch (error) {
        if (error instanceof WindowsOwnedChildStartError) {
          try {
            await bounded(error.cleanup);
          } catch (cleanup) {
            pendingColdOwners.add(artifact);
            throw new AggregateError([error, cleanup], 'qualification_store_start_unknown');
          }
        }
        try {
          artifact.release();
        } catch (cleanup) {
          pendingColdOwners.add(artifact);
          throw new AggregateError([error, cleanup], 'qualification_store_artifact_close_unknown');
        }
        throw error;
      }
      pendingStoreProcesses.set(owner, artifact);
      const wait = new Map<
        number,
        { resolve(value: unknown): void; reject(error: unknown): void }
      >();
      let failure: unknown;
      const fail = (error: unknown) => {
        failure ??= error;
        for (const pending of wait.values()) pending.reject(failure);
        wait.clear();
      };
      const result = (id: number) =>
        new Promise<unknown>((resolve, reject) => {
          if (failure !== undefined) reject(failure);
          else wait.set(id, { resolve, reject });
        });
      const ready = result(0);
      const stdout = (async () => {
        const lines = createInterface({ input: Readable.from(owner.stdout), crlfDelay: Infinity });
        for await (const line of lines) {
          assert(Buffer.byteLength(line) <= 16 * 1024 * 1024, 'qualification_store_result_limit');
          const reply: unknown = JSON.parse(line);
          assert(
            Array.isArray(reply) &&
              reply.length === 2 &&
              Array.isArray(reply[1]) &&
              reply[1].length <= 1,
          );
          const pending = wait.get(reply[0]);
          assert(pending, 'qualification_store_reply_unexpected');
          wait.delete(reply[0]);
          pending.resolve(reply[1][0]);
        }
        assert.equal(wait.size, 0, 'qualification_store_eof_before_reply');
      })();
      const stderr = (async () => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const bytes of owner.stderr) {
          size += bytes.length;
          assert(size <= 64 * 1024, 'qualification_store_stderr_limit');
          chunks.push(Buffer.from(bytes));
        }
        return Buffer.concat(chunks).toString('utf8');
      })();
      const completion = Promise.all([owner.exited, stdout, stderr]);
      void completion.then(([code, , errors]) => {
        fail(Error(`qualification_store_exit:${code}:${errors}`));
      }, fail);
      let id = 0;
      const request = async (method: StoreRequest | 'close', args: unknown[]) => {
        if (failure !== undefined) throw failure;
        const requestId = ++id;
        const response = result(requestId);
        try {
          const write = owner.writeStdin(
            Buffer.from(`${JSON.stringify([requestId, method, args])}\n`),
          );
          const [, value] = await bounded(Promise.all([write, response]));
          return value;
        } catch (error) {
          fail(error);
          throw error;
        }
      };
      let close: Promise<void> | undefined;
      const release = async () => {
        await bounded(owner.close());
        const evidence = owner.readEvidence();
        assert(evidence.closed && !evidence.closeUnknown && evidence.root.waitConfirmed);
        assert(evidence.job.treeStopped && evidence.job.activeProcesses === 0);
        artifact.release();
        pendingStoreProcesses.delete(owner);
        return evidence;
      };
      const cleanup = async (first: unknown): Promise<never> => {
        try {
          await release();
        } catch (error) {
          throw new AggregateError([first, error], 'qualification_store_close_unknown');
        }
        throw first;
      };
      try {
        await bounded(ready);
      } catch (error) {
        return cleanup(error);
      }
      const invoke =
        <K extends StoreRequest>(method: K) =>
        (...args: Parameters<Store[K]>) =>
          request(method, args) as ReturnType<Store[K]>;
      return {
        close: () =>
          (close ??= (async () => {
            let normal = false;
            try {
              await request('close', []);
              const [code, , errors] = await bounded(completion);
              assert.equal(code, 0, errors);
              assert.equal(errors, '');
              normal = true;
              const evidence = await release();
              assert.equal(evidence.job.terminationRequested, false);
            } catch (error) {
              if (!normal) return cleanup(error);
              throw error;
            }
          })()),
        createSession: invoke('createSession'),
        createWorkspace: invoke('createWorkspace'),
        getCommand: invoke('getCommand'),
        getExecution: invoke('getExecution'),
        getMetadata: invoke('getMetadata'),
        getModelOutputSnapshot: invoke('getModelOutputSnapshot'),
        getView: invoke('getView'),
        listExecutions: invoke('listExecutions'),
        listMessages: invoke('listMessages'),
      };
    },
  };
}

export interface WindowsDaemonQualificationContext {
  home: string;
  cli: string;
  prefix: string;
  dataRoot: string;
  userConfigurationPath: string;
  workspace: string;
  readerEnvironment: NodeJS.ProcessEnv;
  candidateA: Candidate;
  candidateB: Candidate;
  execute(
    phase: string,
    argv: string[],
    opts?: { cleanup?: boolean },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  deadline: number;
  /** The caller's existing whole deadline; reserved time is cleanup-only. */
  cleanupDeadline: number;
  rollback(): unknown;
  selectB(): unknown;
}
/** Original installed frontdoor and candidate modules, under the caller's unchanged deadline.
 * Manifest-only A/B selection is not cross-code, Native, PTY, Shell or MCP qualification.
 */
export async function qualifyInstalledWindowsDaemon(
  context: WindowsDaemonQualificationContext,
): Promise<Record<string, unknown>> {
  assert(
    process.platform === 'win32' && process.arch === 'x64',
    'windows_daemon_qualification_platform_required',
  );
  assert(context.cleanupDeadline >= context.deadline);
  assert(context.cleanupDeadline - context.deadline <= 10000);
  let draining = false;
  const remaining = () => {
    const ms = (draining ? context.cleanupDeadline : context.deadline) - performance.now();
    assert(ms > 0, 'windows_daemon_qualification_deadline');
    return ms;
  };
  const signal = () => AbortSignal.timeout(Math.max(1, Math.floor(remaining())));
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error('windows_daemon_qualification_deadline')),
            remaining(),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const load = (packageName: string, leaf: string) =>
    pathToFileURL(
      join(context.candidateB.releaseRoot, 'node_modules', '@kite-ai', packageName, leaf),
    ).href;
  const daemon = (await import(
    load('service', 'daemon.js')
  )) as typeof import('../../../apps/service/src/daemon');
  const clientModule = (await import(
    load('client', 'index.js')
  )) as typeof import('../../../packages/client/src');
  const sqlite = windowsQualificationStore({
    root: context.candidateB.releaseRoot,
    manifest: context.candidateB.manifest,
    cwd: context.home,
    env: context.readerEnvironment,
    remaining,
  });
  const { selectProfile } = (await import(
    load('agent', 'profile.js')
  )) as typeof import('../../../packages/agent/src/profile');
  const { acquireArtifactAccess } = (await import(
    load('agent', 'artifact-access.js')
  )) as typeof import('../../../packages/agent/src/artifact-access');
  const { defaultWindowsPathSecurity } = (await import(
    load('agent', 'platform/windows-path-security.js')
  )) as typeof import('../../../packages/agent/src/platform/windows-path-security');
  const profile = selectProfile({ dataRoot: context.dataRoot, profile: 'default' });
  const expectedProfile = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  // SHGetKnownFolderPath's default-path expansion observes USERPROFILE. The
  // installed CLI runs in the owned HOME; bind this synchronous first selection
  // to the same namespace, then restore the caller's environment immediately.
  const previousHome = process.env.HOME,
    previousProfile = process.env.USERPROFILE;
  let endpoint: ReturnType<typeof daemon.selectDaemonEndpoint>;
  try {
    process.env.HOME = context.home;
    process.env.USERPROFILE = context.home;
    endpoint = daemon.selectDaemonEndpoint({ profileAccessKey: profile.profileAccessKey });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
  }
  const configPath = context.userConfigurationPath,
    config = readFileSync(configPath);
  const security = defaultWindowsPathSecurity()!;
  const fixedBody = 'WINDOWS_DAEMON_ORIGINAL_COMPLETE';
  let calls = 0,
    releaseHeld!: () => void,
    announceHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    announceHeld = resolve;
  });
  const provider = await serveFixture({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const requestBody = await request.json();
      calls++;
      assert(calls <= 2, 'daemon_model_no_replay');
      if (calls === 2) {
        assert(JSON.stringify(requestBody).includes('windows daemon held task'));
        announceHeld();
        await Promise.race([
          held,
          new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener('abort', () => resolve(), { once: true });
          }),
        ]);
      } else assert(JSON.stringify(requestBody).includes('windows daemon ordinary task'));
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: 'windows-daemon-fixed', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        `${frame({ content: fixedBody }, null)}${frame({}, 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const originalHandles: ReturnType<typeof daemon.retainProcessObservation>[] = [];
  const clients = new Set<AgentClient>();
  let current: DaemonBootstrap | undefined,
    firstError: unknown,
    result: Record<string, unknown> | undefined;
  let store: Awaited<ReturnType<typeof sqlite.openSqliteStore>> | undefined;
  let configChanged = false,
    launchAttempted = false,
    launchUnconfirmed = false;
  const bootstrap = () => bounded(daemon.requestDaemonBootstrap(endpoint, expectedProfile));
  const assertSameBootstrap = (observed: DaemonBootstrap, original: DaemonBootstrap) => {
    const { requestId: observedRequest, ...observedIdentity } = observed;
    const { requestId: originalRequest, ...originalIdentity } = original;
    // The protocol validates each fresh nonce. Every stable field, including
    // credentials, must still match; never print bootstrap credentials on error.
    assert.notEqual(observedRequest, originalRequest);
    assert(
      isDeepStrictEqual(observedIdentity, originalIdentity),
      'daemon_bootstrap_identity_changed',
    );
  };
  const argv = (action: string, extras: string[] = []) => [
    context.cli,
    'server',
    action,
    '--data-root',
    context.dataRoot,
    ...extras,
  ];
  const command = async (phase: string, args: string[]) => {
    remaining();
    const output = await context.execute(phase, args);
    assert.equal(output.code, 0, `daemon_command_failed:${phase}`);
    return output;
  };
  const connect = async (identity: DaemonBootstrap) => {
    const client = clientModule.createClient({
      endpoint: identity.httpEndpoint,
      token: identity.token,
      expected: {
        profile: identity.profile,
        instanceId: identity.instanceId,
        buildId: identity.buildId,
        apiMajor: 1,
        requiredCapabilities: ['sessions', 'history', 'commands', 'model_outputs'],
      },
    });
    clients.add(client);
    const info = await client.connect({ signal: signal() });
    assert(info.storeId);
    return { client, storeId: info.storeId };
  };
  const until = async (check: () => Promise<boolean> | boolean) => {
    for (;;) {
      remaining();
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining())));
    }
  };
  const refuseEX = (candidate: Candidate) => {
    let lease: ReturnType<typeof acquireArtifactAccess> | undefined;
    try {
      assert.throws(() => {
        lease = acquireArtifactAccess({ root: candidate.releaseRoot, mode: 'exclusive' });
      }, /busy|in.use/i);
    } finally {
      lease?.release();
    }
  };
  try {
    remaining();
    assert.equal(
      daemon.readDaemonReservation(endpoint),
      undefined,
      'qualification_profile_must_have_no_daemon',
    );
    rmSync(configPath);
    configChanged = true;
    security.writePrivateFile(
      configPath,
      Buffer.from(
        JSON.stringify({
          modelId: 'fixed',
          models: [
            {
              id: 'fixed',
              provider: 'compatible',
              model: 'fixed',
              modelCapabilities: { contextWindowTokens: 1_000_000 },
              baseURL: `${provider.url.href}v1`,
            },
          ],
        }),
      ),
    );
    launchAttempted = true;
    await command('daemon_installed_start_b', argv('start', ['--workspace', context.workspace]));
    current = await bootstrap();
    assert.equal(current.buildId, context.candidateB.buildId);
    assert.equal(current.workspace, context.workspace);
    assert.match(current.processStartIdentity, /^windows:filetime:/);
    const original = current;
    const originalHandle = daemon.retainProcessObservation(
      original.pid,
      original.processStartIdentity,
    );
    originalHandles.push(originalHandle);
    assert.equal(originalHandle.inspect(), 'alive');
    const status = JSON.parse(
      (await command('daemon_status_b', argv('status', ['--json']))).stdout,
    );
    assert.equal(status.instanceId, original.instanceId);
    assert.equal(status.runningBuildId, original.buildId);
    const web = JSON.parse(
      (
        await command('daemon_web_b', [
          context.cli,
          'web',
          '--data-root',
          context.dataRoot,
          '--json',
        ])
      ).stdout,
    );
    assert.equal(web.url, original.webOrigin);
    assert.equal(web.instanceId, original.instanceId);
    const html = await fetch(web.url, { signal: signal() });
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type') ?? '', /text\/html/);
    assert((await html.text()).includes('/app.js'));
    const bundle = JSON.parse(
      readFileSync(join(context.candidateB.releaseRoot, 'terminal-manifest.json'), 'utf8'),
    );
    const assets = JSON.parse(
      readFileSync(join(context.candidateB.releaseRoot, bundle.entries.webManifest), 'utf8'),
    ) as { path: string; sha256: string; size: number }[];
    const script = assets.find((asset) => asset.path === '/app.js');
    assert(script);
    const js = await fetch(new URL(script.path, web.url), { signal: signal() });
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    const jsBytes = new Uint8Array(await js.arrayBuffer());
    assert.equal(jsBytes.byteLength, script.size);
    assert.equal(createHash('sha256').update(jsBytes).digest('hex'), script.sha256);
    assert.equal(
      createHash('sha256')
        .update(
          readFileSync(
            join(
              dirname(join(context.candidateB.releaseRoot, bundle.entries.webManifest)),
              'app.js',
            ),
          ),
        )
        .digest('hex'),
      script.sha256,
    );
    context.rollback();
    const reused = JSON.parse(
      (await command('daemon_original_b_reused_from_a', argv('start'))).stdout,
    );
    assert.equal(reused.reused, true);
    assert.equal(reused.instanceId, original.instanceId);
    assert.equal(reused.runningBuildId, context.candidateB.buildId);
    assert.equal(reused.targetBuildId, context.candidateA.buildId);
    const rollbackStatus = JSON.parse(
      (await command('daemon_status_original_b_from_a', argv('status', ['--json']))).stdout,
    );
    assert.equal(rollbackStatus.instanceId, original.instanceId);
    assert.equal(rollbackStatus.runningBuildId, context.candidateB.buildId);
    assert.equal(rollbackStatus.targetBuildId, context.candidateA.buildId);
    assertSameBootstrap(await bootstrap(), original);
    refuseEX(context.candidateB);
    const { uninstallTerminalBundle } = await import('../../../scripts/release/terminal-bundle');
    assert.throws(() => uninstallTerminalBundle(context.prefix), /busy|in.use/i);
    const sessionId = `windows-daemon-${randomUUID()}`;
    const task = await command('daemon_installed_shared_original_task', [
      context.cli,
      'run',
      '--server',
      endpoint.socket,
      '--data-root',
      context.dataRoot,
      '--workspace',
      context.workspace,
      '--trust-workspace',
      '--thread',
      sessionId,
      '--task',
      'windows daemon ordinary task',
      '--full',
    ]);
    assert(task.stdout.includes(fixedBody));
    assert.equal(calls, 1);
    const connected = await connect(original),
      client = connected.client,
      storeId = connected.storeId;
    const completeView = await client.getView(sessionId, { signal: signal() });
    const complete = completeView.executions.find((execution) => execution.kind === 'model');
    assert(complete);
    assert.equal(complete.status, 'succeeded');
    const completeExecution = await client.getExecution(complete.id, { signal: signal() });
    assert.equal(completeExecution.sessionId, sessionId);
    const coldStore = await bounded(
      sqlite
        .openSqliteStore({
          dataRoot: context.dataRoot,
          profile: 'default',
          mode: 'readonly',
        })
        .then((opened) => {
          pendingColdOwners.add(opened);
          store = opened;
          if (draining)
            void opened
              .close()
              .then(() => pendingColdOwners.delete(opened))
              .catch(() => {});
          return opened;
        }),
    );
    assert.equal((await bounded(coldStore.getMetadata())).storeId, storeId);
    const cold = await bounded(coldStore.getExecution(complete.id));
    assert(cold);
    assert.equal(cold.id, complete.id);
    assert.equal(cold.runId, complete.runId);
    assert.equal(cold.resultRevision, complete.resultRevision);
    assert(cold.result && typeof cold.result === 'object' && !Array.isArray(cold.result));
    const { modelOutput, ...publicResult } = cold.result;
    if (modelOutput === undefined) {
      assert.equal(publicResult.content, fixedBody);
      assert.deepEqual(completeExecution.result, cold.result);
    } else {
      assert(modelOutput && typeof modelOutput === 'object' && !Array.isArray(modelOutput));
      assert.deepEqual(completeExecution.result, {
        ...publicResult,
        outputBody: {
          kind: 'model_output',
          executionId: cold.id,
          complete: modelOutput.complete,
          contentBytes: modelOutput.contentBytes,
          reasoningBytes: modelOutput.reasoningBytes,
          toolCallCount: modelOutput.toolCallCount,
        },
      });
    }
    const fullOutput = await client.getModelOutput(sessionId, cold.id, {
      expectedStoreId: storeId,
      signal: signal(),
    });
    assert.equal(fullOutput.runId, cold.runId);
    assert.equal(fullOutput.executionId, cold.id);
    assert.equal(fullOutput.output.complete, true);
    assert.equal(fullOutput.output.content, fixedBody);
    assert(JSON.stringify(cold.result).includes(fixedBody));
    await bounded(coldStore.close());
    pendingColdOwners.delete(coldStore);
    store = undefined;
    assert.equal(calls, 1);
    const heldSessionId = `windows-daemon-held-${randomUUID()}`;
    await client.createSession(
      {
        expectedStoreId: storeId,
        commandId: randomUUID(),
        sessionId: heldSessionId,
        workspaceId: completeView.session.workspaceId,
        title: 'Windows original held',
      },
      { signal: signal() },
    );
    const heldCommand = await client.startRun(
      heldSessionId,
      {
        expectedStoreId: storeId,
        commandId: randomUUID(),
        kind: 'run.start',
        content: 'windows daemon held task',
      },
      { signal: signal() },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('daemon_held_admission_timeout')), remaining());
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(calls, 2);
    const heldView = await client.getView(heldSessionId, { signal: signal() });
    const heldExecution = heldView.executions.find((execution) => execution.kind === 'model');
    assert(heldExecution);
    client.disposeNetwork();
    clients.delete(client);
    assert.equal(originalHandle.inspect(), 'alive');
    const busy = await context.execute('daemon_busy_restart_original', argv('restart'));
    assert.notEqual(busy.code, 0);
    assert(/busy/.test(busy.stderr));
    assertSameBootstrap(await bootstrap(), original);
    await command('daemon_restart_cancel_original', argv('restart', ['--cancel']));
    assert.equal(originalHandle.inspect(), 'dead');
    current = await bootstrap();
    assert.equal(current.buildId, context.candidateA.buildId);
    assert.notEqual(current.instanceId, original.instanceId);
    assert.notEqual(current.processStartIdentity, original.processStartIdentity);
    const restartedHandle = daemon.retainProcessObservation(
      current.pid,
      current.processStartIdentity,
    );
    originalHandles.push(restartedHandle);
    assert.equal(restartedHandle.inspect(), 'alive');
    const next = await connect(current);
    assert.equal(next.storeId, storeId);
    assert.deepEqual(
      await next.client.getExecution(complete.id, { signal: signal() }),
      completeExecution,
    );
    const restartedFull = await next.client.getModelOutput(sessionId, complete.id, {
      expectedStoreId: storeId,
      signal: signal(),
    });
    assert.equal(restartedFull.runId, fullOutput.runId);
    assert.equal(restartedFull.originCommandId, fullOutput.originCommandId);
    assert.equal(restartedFull.bodyHash, fullOutput.bodyHash);
    assert.equal(restartedFull.bodyBytes, fullOutput.bodyBytes);
    assert.deepEqual(restartedFull.output, fullOutput.output);
    assert.equal(calls, 2);
    await until(
      async () =>
        (await next.client.getExecution(heldExecution.id, { signal: signal() })).status ===
        'cancelled',
    );
    const cancelled = await next.client.getExecution(heldExecution.id, { signal: signal() });
    assert.equal(cancelled.sessionId, heldSessionId);
    assert.equal(cancelled.id, heldExecution.id);
    assert.equal(cancelled.runId, heldExecution.runId);
    assert.equal(cancelled.originStoreId, storeId);
    const originalHeldCommand = await next.client.getCommand(heldCommand.id, { signal: signal() });
    assert.equal(originalHeldCommand.id, heldCommand.id);
    assert.equal(originalHeldCommand.sessionId, heldSessionId);
    assert.equal(originalHeldCommand.originStoreId, storeId);
    assert.equal(originalHeldCommand.kind, 'run.start');
    assert.equal(calls, 2);
    next.client.disposeNetwork();
    clients.delete(next.client);
    await command('daemon_final_stop_a', argv('stop'));
    assert.equal(restartedHandle.inspect(), 'dead');
    current = undefined;
    assert.equal(daemon.readDaemonReservation(endpoint), undefined);
    context.selectB();
    const leases: ReturnType<typeof acquireArtifactAccess>[] = [];
    try {
      for (const candidate of [context.candidateA, context.candidateB])
        leases.push(acquireArtifactAccess({ root: candidate.releaseRoot, mode: 'exclusive' }));
      assert.equal(leases.length, 2);
    } finally {
      for (const lease of leases.reverse()) lease.release();
    }
    rmSync(configPath);
    security.writePrivateFile(configPath, config);
    configChanged = false;
    assert.deepEqual(readFileSync(configPath), config);
    result = {
      qualified: true,
      scope: 'windows-installed-daemon-lifecycle',
      crossCode: false,
      tuiPty: false,
      native: false,
      ShellMCP: false,
      storeId,
      endpoint: endpoint.socket,
      originalInstanceId: original.instanceId,
      originalPid: original.pid,
      originalBirth: original.processStartIdentity,
      providerCalls: calls,
      originalExecutionId: complete.id,
      cancelledExecutionId: cancelled.id,
      heldOriginalCommandId: heldCommand.id,
      actualOriginalDead: true,
      actualRestartedDead: true,
      coldZeroReplay: true,
    };
  } catch (error) {
    firstError = error;
    if (!current && launchAttempted) {
      try {
        const record = daemon.readDaemonReservation(endpoint);
        if (record) {
          assert.equal(record.buildId, context.candidateB.buildId);
          current = await bootstrap();
          assert.equal(current.instanceId, record.instanceId);
          originalHandles.push(
            daemon.retainProcessObservation(record.pid, record.processStartIdentity),
          );
        }
      } catch {
        launchUnconfirmed = true;
      }
    }
  }
  draining = true;
  const errors: unknown[] = [];
  for (const client of clients) {
    try {
      client.disposeNetwork();
    } catch (error) {
      errors.push(error);
    }
  }
  if (store) {
    try {
      await bounded(store.close());
      pendingColdOwners.delete(store);
    } catch (error) {
      errors.push(error);
    }
  }
  if (current && performance.now() < context.cleanupDeadline) {
    try {
      const observed = await bootstrap();
      assert.equal(observed.instanceId, current.instanceId, 'cleanup_original_daemon_required');
      const stopped = await context.execute('daemon_failure_original_stop', argv('stop'), {
        cleanup: true,
      });
      assert.equal(stopped.code, 0);
      assert.equal(daemon.readDaemonReservation(endpoint), undefined);
      for (const handle of originalHandles) assert.equal(handle.inspect(), 'dead');
      current = undefined;
    } catch (error) {
      errors.push(error);
    }
  }
  if (launchUnconfirmed) errors.push(Error('daemon_launch_cleanup_unconfirmed'));
  if (current) errors.push(Error('daemon_cleanup_unconfirmed'));
  if (
    configChanged &&
    !current &&
    !launchUnconfirmed &&
    performance.now() < context.cleanupDeadline
  ) {
    try {
      rmSync(configPath);
      security.writePrivateFile(configPath, config);
      assert.deepEqual(readFileSync(configPath), config);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const handle of originalHandles) {
    try {
      handle.close();
    } catch (error) {
      errors.push(error);
    }
  }
  releaseHeld();
  await provider.stop(true);
  if (firstError || errors.length)
    throw new AggregateError(
      firstError ? [firstError, ...errors] : errors,
      'windows_daemon_qualification_failed',
    );
  assert(result);
  return result;
}
