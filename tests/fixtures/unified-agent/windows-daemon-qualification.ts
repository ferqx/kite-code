import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DaemonBootstrap } from '../../../apps/service/src/daemon/bootstrap';
import type { AgentClient } from '../../../packages/client/src';

// Late opening/unknown closing never loses its original Store owner on deadline rejection.
const pendingColdOwners = new Set<object>();

type Candidate = { releaseRoot: string; candidateId: string; buildId: string };
export interface WindowsDaemonQualificationContext {
  cli: string;
  prefix: string;
  dataRoot: string;
  workspace: string;
  candidateA: Candidate;
  candidateB: Candidate;
  execute(
    phase: string,
    argv: string[],
    opts?: { cleanup?: boolean },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  deadline: number;
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
  const remaining = () => {
    const ms = context.deadline - performance.now();
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
  const sqlite = (await import(
    load('agent', 'sqlite.js')
  )) as typeof import('../../../packages/agent/src/sqlite');
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
  const endpoint = daemon.selectDaemonEndpoint({ profileAccessKey: profile.profileAccessKey });
  const configPath = join(profile.profilePath, 'config.jsonc'),
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
  const provider = Bun.serve({
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
    draining = false,
    launchAttempted = false,
    launchUnconfirmed = false;
  const bootstrap = () => bounded(daemon.requestDaemonBootstrap(endpoint, expectedProfile));
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
    assert.deepEqual(await bootstrap(), original);
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
    assert.deepEqual(await bootstrap(), original);
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
  if (current && performance.now() < context.deadline) {
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
  if (configChanged && !current && !launchUnconfirmed && performance.now() < context.deadline) {
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
