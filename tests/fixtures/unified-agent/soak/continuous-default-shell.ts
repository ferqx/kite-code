import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import {
  decodeLinuxShellProcessEvidence,
  decodeMacosShellProcessEvidence as decodeShellProcessEvidence,
  type LinuxShellProcessEvidence,
  type MacosShellProcessEvidence as ShellProcessEvidence,
  shellProcessEvidenceEnded,
} from '@kite-ai/agent/jobs/shell';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { createClient } from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';
import {
  buildTerminalBundle,
  verifyTerminalBundle,
} from '../../../../scripts/release/terminal-bundle';
import {
  busyDuration,
  CONTINUOUS_OPERATION_MS,
  CONTINUOUS_SHELL_SOURCE,
  type ContinuousEvidence,
  type ContinuousLinuxShellEvidence,
  type ContinuousShellEvidence,
} from '../../../../scripts/runtime/unified-soak-continuous';

import {
  type NativeProcessObservation,
  observeNativeProcess,
  observeNativeProcessResources,
  observeOwnedProcessExit,
} from '../../../../scripts/runtime/unified-soak-native';
import type { PairedServiceResources } from '../../../../scripts/runtime/unified-soak-service-resources';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
interface Operation {
  commandId: string;
  sessionId: string;
  began: number;
  admissionMs?: number;
  durationMs?: number;
  childId?: string;
  shell?: ContinuousShellEvidence['jobs'][number] | ContinuousLinuxShellEvidence['jobs'][number];
  reference?: unknown;
  output?: unknown;
  result?: unknown;
}

/** Two source-free default Services. No configure hook, custom Tool, Job or permission adapter. */
export async function openDefaultShellContinuousFixture(root: string, candidateRoot?: string) {
  if (!['darwin', 'linux'].includes(process.platform))
    throw Error('continuous_qualified_background_shell_required');
  const cleanup: (() => Promise<unknown>)[] = [];
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      const failures: unknown[] = [];
      for (const action of cleanup.splice(0).reverse())
        try {
          await action();
        } catch (error) {
          failures.push(error);
        }
      if (failures.length) throw new AggregateError(failures, 'continuous_cleanup_failed');
    })();
    return closing;
  };
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const workspace = join(root, 'workspace');
    mkdirSync(join(workspace, 'effects'), { recursive: true, mode: 0o700 });
    const candidate = candidateRoot
      ? verifyTerminalBundle(candidateRoot)
      : await buildTerminalBundle({ destination: join(root, 'candidate') });
    const access = acquireArtifactAccess({ root: candidate.root, mode: 'shared' });
    cleanup.push(async () => access.release());
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'continuous' });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    let childCalls = 0,
      providerCalls = 0;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          messages: { role: string; content: string }[];
        };
        providerCalls++;
        const last = body.messages.reduce(
          (found, row, index) =>
            row.role === 'user' && /(?:^load-parent:|load-child:)[a-f0-9-]{36}/.test(row.content)
              ? index
              : found,
          -1,
        );
        const content = body.messages[last]?.content ?? '';
        const childMatch = /load-child:([a-f0-9-]{36})/.exec(content);
        const parentMatch = /^load-parent:([a-f0-9-]{36})$/.exec(content);
        const child = childMatch !== null;
        const nonce = (childMatch ?? parentMatch)?.[1];
        if (!nonce) {
          writeFileSync(join(root, 'model-input-failure.json'), JSON.stringify({ content }), {
            mode: 0o600,
          });
          throw Error('continuous_original_model_input_missing');
        }
        if (child) childCalls++;
        const results = body.messages.slice(last + 1).filter((row) => row.role === 'tool');
        const calls = [
          {
            name: 'files.write',
            input: { path: `effects/${nonce}.txt`, base: null, content: nonce },
          },
          {
            name: 'task',
            input: {
              key: `child-${nonce}`,
              role: 'worker',
              input: { content: `load-child:${nonce}` },
              cancellation: 'attached',
              resultDisposition: 'required',
            },
          },
          {
            name: 'shell.launch',
            input: {
              key: `shell-${nonce}`,
              command: `${quote(join(candidate.root, candidate.manifest.entries.runtime))} -e ${quote(CONTINUOUS_SHELL_SOURCE)} ${quote(nonce)}`,
              cancellation: 'detached',
            },
          },
          {
            name: 'shell.wait',
            input: { shellId: `shell-${nonce}`, timeoutMs: 4000 },
          },
        ];
        const call = child ? undefined : calls[Math.min(results.length, 3)];
        const waiting =
          results.length > 3 &&
          !results
            .slice(3)
            .some((row) =>
              /"status":"(?:succeeded|failed|cancelled|outcome_unknown)"/.test(row.content),
            );
        const selected = results.length > 3 && !waiting ? undefined : call;
        const delta = selected
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `load-${nonce}-${results.length}`,
                  type: 'function',
                  function: { name: selected.name, arguments: JSON.stringify(selected.input) },
                },
              ],
            }
          : { content: child ? `child-complete:${nonce}` : `parent-complete:${nonce}` };
        const frame = (delta: unknown, reason: string | null) =>
          `data: ${JSON.stringify({ id: 'continuous-default', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
        return new Response(
          `${frame(delta, null)}${frame({}, selected ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    cleanup.push(async () => provider.stop(true));
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
        tools: [
          { id: 'files.write', definitionVersion: '2' },
          ...['task', 'shell.launch', 'shell.wait'].map((id) => ({ id, definitionVersion: '1' })),
        ],
      }),
      { mode: 0o600 },
    );
    const services: Awaited<ReturnType<typeof launchPairedService>>[] = [];
    const resourceServices: PairedServiceResources['services'] = [];
    let resourceCold: PairedServiceResources['cold'] = null;
    for (let index = 0; index < 2; index++) {
      let spawnObservation: NativeProcessObservation | null = null;
      const service = await launchPairedService({
        profile,
        entrypoint: join(candidate.root, candidate.manifest.entries.service),
        executable: join(candidate.root, candidate.manifest.entries.runtime),
        instanceId: `continuous-default-${index}`,
        spawnChild(command, options) {
          // Exact original default spawn; observation supplies no runtime/Tool/permission adapter.
          const child = Bun.spawn([...command], {
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
            env: options.env,
          });
          spawnObservation = observeNativeProcess(child.pid);
          return child;
        },
        buildId: `terminal-${candidate.digest}`,
        apiMajor: 1,
        runtimeProtection: {
          kind: 'terminal.candidate',
          root: candidate.root,
          manifestSha256: candidate.digest,
        },
        requiredCapabilities: ['sessions', 'commands', 'events', 'permission_controls'],
      });
      services.push(service);
      const resources: PairedServiceResources['services'][number] = {
        instanceId: service.bootstrap.instanceId,
        pid: service.pid,
        spawn: spawnObservation,
        ready: observeNativeProcessResources(service.pid),
        preclose: null,
        exit: null,
      };
      resourceServices.push(resources);
      cleanup.push(async () => {
        resources.preclose = observeNativeProcessResources(service.pid);
        await service.close();
        const exitCode = await service.exited;
        const kernelState = observeOwnedProcessExit(service.pid, resources.ready.before);
        resources.exit = {
          exitCode,
          originalExited: true,
          reaped: exitCode === 0 && (kernelState === 'absent' || kernelState === 'reused'),
          kernelState,
        };
      });
    }
    const clients = services.map((service) => service.client);
    const storeId = services[0]!.bootstrap.storeId!;
    if (services[1]!.bootstrap.storeId !== storeId) throw Error('continuous_peer_store_mismatch');
    let originalReader: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    if (process.platform === 'linux') {
      initializeSqliteEngine({
        root: join(candidate.root, 'node_modules/@kite-ai/agent/storage/engine'),
        manifestSha256: candidate.manifest.sqlite.manifestSha256,
      });
      originalReader = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      cleanup.push(() => originalReader!.close());
    }
    await clients[0]!.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'default load',
      rootUri: pathToFileURL(workspace).href,
    });
    const sessionIds = Array.from({ length: 20 }, (_, index) => `load-${index}`);
    for (const sessionId of sessionIds)
      await clients[0]!.createSession({
        expectedStoreId: storeId,
        commandId: `create-${sessionId}`,
        sessionId,
        workspaceId: 'w',
        title: 'default Shell load',
      });
    const trust = await clients[0]!.getWorkspaceTrust('w', { storeId });
    await clients[0]!.setWorkspaceTrust('w', {
      expectedStoreId: storeId,
      commandId: 'trust',
      trusted: true,
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
      ifRevision: trust.revision,
    });
    const mode = await clients[0]!.getPermissionMode(sessionIds[0]!, { storeId });
    await clients[0]!.setPermissionMode(sessionIds[0]!, {
      expectedStoreId: storeId,
      commandId: 'full-default',
      mode: 'full',
      makeDefault: true,
      ifRevision: mode.revision,
      ifDefaultRevision: mode.defaultRevision,
    });
    const slow = createClient({
      endpoint: services[0]!.bootstrap.endpoint,
      token: services[0]!.bootstrap.token,
      expected: {
        profile: services[0]!.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['events'],
      },
    });
    await slow.connect();
    cleanup.push(async () => slow.disposeNetwork());
    let slowEntered = false,
      peerEvents = 0,
      reconnects = 0;
    const slowAbort = new AbortController();
    let releaseSlow!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const initial = (await clients[0]!.getView(sessionIds[0]!)).snapshotCursor;
    const slowStream = slow
      .observe({
        cursor: { storeId, sequence: initial },
        sessionIds,
        signal: slowAbort.signal,
        async onChange() {
          slowEntered = true;
          await blocked;
        },
      })
      .catch((error: unknown) => {
        if (!slowAbort.signal.aborted) throw error;
      });
    cleanup.push(async () => {
      slowAbort.abort();
      releaseSlow();
      await slowStream;
    });
    const operations: Operation[] = [];
    const wallStartedAt = Date.now();
    let completedCycles = 0;
    let coldRead = false;
    const until = async <T>(
      read: () => Promise<T>,
      test: (value: T) => boolean,
      deadline: number,
      signal?: AbortSignal,
    ) => {
      for (;;) {
        if (signal?.aborted) throw Error('continuous_schedule_stopped');
        const value = await read();
        if (test(value)) return value;
        if (performance.now() > deadline) throw Error('continuous_default_operation_deadline');
        await Bun.sleep(10);
      }
    };
    return {
      services,
      async cycle(signal?: AbortSignal) {
        const observerAbort = new AbortController();
        let ready = false;
        const observing = clients[1]!
          .observe({
            sessionIds,
            signal: observerAbort.signal,
            onReady() {
              ready = true;
            },
            onChange() {
              peerEvents++;
            },
          })
          .catch((error: unknown) => {
            if (!observerAbort.signal.aborted) throw error;
          });
        let next = 0;
        let failure: unknown;
        try {
          await until(
            async () => ready,
            Boolean,
            performance.now() + CONTINUOUS_OPERATION_MS,
            signal,
          );
          await Promise.all(
            Array.from({ length: 4 }, async () => {
              while (!failure && next < sessionIds.length) {
                const index = next++;
                const sessionId = sessionIds[index]!;
                const operation: Operation = {
                  commandId: randomUUID(),
                  sessionId,
                  began: performance.now(),
                };
                const deadline = operation.began + CONTINUOUS_OPERATION_MS;
                operations.push(operation);
                const client = clients[index % 2]!;
                try {
                  await client.startRun(sessionId, {
                    expectedStoreId: storeId,
                    commandId: operation.commandId,
                    kind: 'run.start',
                    content: `load-parent:${operation.commandId}`,
                  });
                  operation.admissionMs = performance.now() - operation.began;
                  const command = await until(
                    () => clients[(index + 1) % 2]!.getCommand(operation.commandId),
                    (row) => row.status !== 'accepted',
                    deadline,
                    signal,
                  );
                  const runId = (command.receipt as { runId?: string } | null)?.runId;
                  if (command.status !== 'applied' || !runId)
                    throw Error('continuous_default_run_not_applied');
                  const run = await until(
                    () => client.getRun(runId),
                    (row) => !row.isActive,
                    deadline,
                    signal,
                  );
                  const view = await client.getView(sessionId);
                  const rows = view.executions.filter((row) => row.runId === runId);
                  const writes = rows.filter(
                    (row) => row.definitionId === 'files.write' && row.status === 'succeeded',
                  );
                  const child = view.executions.find(
                    (row) =>
                      row.definitionId === 'agent/worker' &&
                      row.parentExecutionId &&
                      rows.some((parent) => parent.id === row.parentExecutionId),
                  );
                  const job = view.executions.find(
                    (row) =>
                      row.definitionId === 'shell.command' &&
                      row.parentExecutionId &&
                      rows.some((parent) => parent.id === row.parentExecutionId),
                  );
                  if (
                    run.status !== 'completed' ||
                    writes.length !== 1 ||
                    child?.status !== 'succeeded' ||
                    job?.status !== 'succeeded' ||
                    !JSON.stringify(job.result).includes('"processTreeStopped":true') ||
                    readFileSync(join(workspace, `effects/${operation.commandId}.txt`), 'utf8') !==
                      operation.commandId
                  ) {
                    writeFileSync(
                      join(root, `operation-${operation.commandId}-failure.json`),
                      JSON.stringify({ run, rows, executions: view.executions }),
                      { mode: 0o600 },
                    );
                    throw Error('continuous_original_effects_failed');
                  }
                  const output = await client.listExecutionOutput(job.id, {
                    afterSeq: '0',
                    limit: 200,
                  });
                  const stdout = output.items
                    .filter((row) => row.stream === 'stdout')
                    .map((row) => row.content)
                    .join('');
                  const fact = JSON.parse(stdout) as {
                    nonce: string;
                    startedAt: number;
                    endedAt: number;
                    units: number;
                    digest: string;
                  };
                  const details = (
                    job.result as {
                      details?: {
                        coalitionId?: string;
                        ownedProcesses?: ShellProcessEvidence | LinuxShellProcessEvidence;
                      };
                    } | null
                  )?.details;
                  if (fact.nonce !== operation.commandId)
                    throw Error('continuous_original_shell_identity_failed');
                  const proof = details?.ownedProcesses;
                  const common = {
                    commandId: operation.commandId,
                    sessionId,
                    executionId: job.id,
                    startedAt: fact.startedAt,
                    endedAt: fact.endedAt,
                    units: fact.units,
                    digest: fact.digest,
                    processTreeStopped: true as const,
                    stdoutSha256: hash(stdout),
                  };
                  if (process.platform === 'linux') {
                    const terminal =
                      proof &&
                      decodeLinuxShellProcessEvidence(proof, {
                        sessionId,
                        executionId: job.id,
                        nonce: proof.binding?.nonce,
                      });
                    const original = await originalReader!.getExecution(job.id);
                    const reference = original?.reference as {
                      ownedProcesses?: unknown;
                      nonce?: string;
                    } | null;
                    const startup =
                      terminal &&
                      decodeLinuxShellProcessEvidence(
                        reference?.ownedProcesses,
                        terminal.binding,
                        terminal.owner.ownerPid,
                      );
                    if (
                      !terminal ||
                      !shellProcessEvidenceEnded(terminal) ||
                      !startup ||
                      startup.owner.phase !== 'ready' ||
                      !services.some((service) => service.pid === terminal.owner.ownerPid) ||
                      reference?.nonce !== terminal.binding.nonce ||
                      original?.originStoreId !== storeId ||
                      original.sessionId !== sessionId ||
                      JSON.stringify(original.result) !== JSON.stringify(job.result)
                    )
                      throw Error('continuous_original_shell_process_handoff_failed');
                    operation.reference = structuredClone(original.reference);
                    operation.shell = {
                      ...common,
                      ownedProcesses: terminal,
                      startupProcesses: startup,
                    };
                  } else {
                    const originalProcesses =
                      proof &&
                      decodeShellProcessEvidence(proof, {
                        sessionId,
                        executionId: job.id,
                        nonce: proof.binding?.nonce,
                      });
                    if (
                      !details?.coalitionId ||
                      !originalProcesses ||
                      !shellProcessEvidenceEnded(originalProcesses) ||
                      !services.some((service) => service.pid === originalProcesses.ownerPid) ||
                      originalProcesses.coalition.id !== details.coalitionId
                    )
                      throw Error('continuous_original_shell_process_handoff_failed');
                    operation.shell = {
                      ...common,
                      coalitionId: details.coalitionId,
                      ownedProcesses: originalProcesses,
                    };
                  }
                  operation.result = structuredClone(job.result);
                  operation.childId = child.id;
                  operation.output = output;
                  operation.durationMs = performance.now() - operation.began;
                  if (operation.durationMs > CONTINUOUS_OPERATION_MS)
                    throw Error('continuous_default_operation_deadline');
                } catch (error) {
                  failure = error;
                }
              }
            }),
          );
          if (failure) throw failure;
          await until(
            async () => slowEntered,
            Boolean,
            performance.now() + CONTINUOUS_OPERATION_MS,
            signal,
          );
          completedCycles++;
        } finally {
          observerAbort.abort();
          await observing;
          reconnects++;
        }
      },
      evidence(): ContinuousEvidence {
        if (
          operations.some(
            (row) =>
              !row.shell ||
              !row.childId ||
              row.durationMs === undefined ||
              row.admissionMs === undefined,
          )
        )
          throw Error('continuous_incomplete_original_operation');
        const jobs = operations.map((row) => row.shell!);
        const busyIntervals = jobs.map(
          (job) => [job.startedAt - wallStartedAt, job.endedAt - wallStartedAt] as [number, number],
        );
        const shellCommon = {
          candidateDigest: candidate.digest,
          sourceSha256: hash(CONTINUOUS_SHELL_SOURCE),
          wallStartedAt,
          coldRead,
          noReplay: coldRead,
          serviceResources: {
            version: process.platform === 'linux' ? (2 as const) : (1 as const),
            coverage: 'paired-services-only' as const,
            storeId,
            candidateDigest: candidate.digest,
            ownerPid: process.pid,
            services: resourceServices,
            cold: resourceCold,
          },
        };
        const shell =
          process.platform === 'linux'
            ? {
                ...shellCommon,
                backend: 'linux-pid-namespace' as const,
                jobs: jobs.map((job) => {
                  if (!('startupProcesses' in job))
                    throw Error('continuous_original_shell_process_handoff_failed');
                  return job;
                }),
              }
            : {
                ...shellCommon,
                backend: 'macos-launchd-coalition' as const,
                jobs: jobs.map((job) => {
                  if (!('coalitionId' in job))
                    throw Error('continuous_original_shell_process_handoff_failed');
                  return job;
                }),
              };
        return {
          version: process.platform === 'linux' ? 3 : 2,
          mode: 'formal',
          status: 'passed',
          storeId,
          serviceInstanceIds: services.map((row) => row.bootstrap.instanceId),
          sessionIds,
          commandIds: operations.map((row) => row.commandId),
          childExecutionIds: operations.map((row) => row.childId!),
          synchronousEffects: operations.length,
          childCalls,
          slowEntered,
          peerEvents,
          reconnects,
          completedCycles,
          wallDurationMs: Date.now() - wallStartedAt,
          activeWorkloadDurationMs: busyDuration(busyIntervals),
          busyIntervals,
          operationDurationMs: operations.map((row) => row.durationMs!),
          admissionLatencyMs: operations.map((row) => row.admissionMs!),
          cleanupConfirmed: coldRead,
          missing: [],
          shell,
        };
      },
      async confirmCold() {
        await close();
        const before = providerCalls;
        const readAccess = acquireArtifactAccess({ root: candidate.root, mode: 'shared' });
        let reader: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
        try {
          initializeSqliteEngine({
            root: join(candidate.root, 'node_modules/@kite-ai/agent/storage/engine'),
            manifestSha256: candidate.manifest.sqlite.manifestSha256,
          });
          reader = await openSqliteStore({
            dataRoot: profile.dataRoot,
            profile: profile.profile,
            mode: 'readonly',
          });
          const metadata = await reader.getMetadata();
          if (metadata.storeId !== storeId) throw Error('continuous_cold_store_changed');
          for (const operation of operations) {
            const job = await reader.getExecution(operation.shell!.executionId);
            const output = await reader.listExecutionOutput({
              executionId: operation.shell!.executionId,
              afterSeq: '0',
              limit: 200,
            });
            if (operation.shell && 'startupProcesses' in operation.shell) {
              const terminal = operation.shell.ownedProcesses;
              const reference = job?.reference as {
                ownedProcesses?: unknown;
                nonce?: string;
              } | null;
              const ready = decodeLinuxShellProcessEvidence(
                reference?.ownedProcesses,
                terminal.binding,
                terminal.owner.ownerPid,
              );
              if (
                job?.status !== 'succeeded' ||
                JSON.stringify(job.result) !== JSON.stringify(operation.result) ||
                JSON.stringify(job.reference) !== JSON.stringify(operation.reference) ||
                !ready ||
                JSON.stringify(ready) !== JSON.stringify(operation.shell.startupProcesses) ||
                reference?.nonce !== terminal.binding.nonce ||
                job.originStoreId !== storeId ||
                job.sessionId !== operation.sessionId ||
                !JSON.stringify(job.result).includes('"processTreeStopped":true') ||
                JSON.stringify(output) !== JSON.stringify(operation.output) ||
                (await reader.getCommand(operation.commandId))?.status !== 'applied'
              )
                throw Error('continuous_cold_original_facts_changed');
            } else {
              const terminal = operation.shell!.ownedProcesses!;
              if (terminal.coverage !== 'shell-owned-coalition')
                throw Error('continuous_cold_original_facts_changed');
              const reference = job?.reference as {
                ownedProcesses?: unknown;
                nonce?: string;
              } | null;
              const ready = decodeShellProcessEvidence(
                reference?.ownedProcesses,
                terminal.binding,
                terminal.ownerPid,
              );
              const identity = (row: ShellProcessEvidence['broker']) => ({
                pid: row.pid,
                parentPid: row.parentPid,
                birth: row.birth,
                unavailable: row.unavailable,
              });
              if (
                job?.status !== 'succeeded' ||
                JSON.stringify(job.result) !== JSON.stringify(operation.result) ||
                !ready ||
                reference?.nonce !== terminal.binding.nonce ||
                job.originStoreId !== storeId ||
                job.sessionId !== operation.sessionId ||
                JSON.stringify(identity(ready.broker)) !==
                  JSON.stringify(identity(terminal.broker)) ||
                JSON.stringify(identity(ready.guardian)) !==
                  JSON.stringify(identity(terminal.guardian)) ||
                JSON.stringify(ready.root.identity) !== JSON.stringify(terminal.root.identity) ||
                ready.coalition.id !== terminal.coalition.id ||
                ready.coalition.guardianUniqueId !== terminal.coalition.guardianUniqueId ||
                ready.coalition.guardianPidVersion !== terminal.coalition.guardianPidVersion ||
                ready.coalition.label !== terminal.coalition.label ||
                ready.coalition.domain !== terminal.coalition.domain ||
                !JSON.stringify(job.result).includes('"processTreeStopped":true') ||
                JSON.stringify(output) !== JSON.stringify(operation.output) ||
                (await reader.getCommand(operation.commandId))?.status !== 'applied'
              )
                throw Error('continuous_cold_original_facts_changed');
            }
          }
          if (
            (await reader.getMetadata()).lastChangeCursor !== metadata.lastChangeCursor ||
            providerCalls !== before
          )
            throw Error('continuous_cold_replayed');
          coldRead = true;
          // Original preceding cursor/provider comparisons prove this receipt; no new Core read.
          resourceCold = {
            storeId,
            cursor: metadata.lastChangeCursor,
            unchanged: true,
            providerCallsBefore: before,
            providerCallsAfter: providerCalls,
          };
        } finally {
          await reader?.close();
          readAccess.release();
        }
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'continuous_setup_failed');
    }
    throw error;
  }
}
