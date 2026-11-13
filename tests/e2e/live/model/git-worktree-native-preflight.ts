import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as fixtureDelay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import type { JobContext } from '@kite-ai/agent/extensions';
import {
  decodeMacosShellProcessEvidence,
  shellProcessEvidenceEnded,
} from '@kite-ai/agent/jobs/shell';
import { builtinCapability, createPermissionPolicy } from '@kite-ai/agent/permissions';
import { createShellConfiguration, hostExecutionScope } from '@kite-ai/agent/permissions/shell';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Json } from '@kite-ai/agent/storage';
import { createFixedModel } from '@kite-ai/ai';
import { readLiveExecutionDirectory } from './approval-execution-fixture';
import { completeJobOutput, worktreeLiveShellReferenceEvidence } from './git-worktree-evidence';

export interface GitWorktreeNativePreflightOptions {
  readonly root: string;
  readonly source: string;
  readonly control: string;
  readonly supervisorPath: string;
  readonly fixtureHome: string;
  readonly signal: AbortSignal;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const scope = { filesystem: 'workspace_write', network: 'none' } as const;

/** An isolated, managed native capability probe. It never runs Git or a Provider. */
export async function runGitWorktreeNativePreflight(options: GitWorktreeNativePreflightOptions) {
  assert.equal(process.platform, 'darwin', 'native-preflight-qualified-macos-required');
  options.signal.throwIfAborted();
  assert.equal(homedir(), options.fixtureHome, 'native-preflight-startup-home-required');
  for (const path of [
    options.root,
    options.source,
    options.control,
    options.supervisorPath,
    options.fixtureHome,
  ])
    assert(isAbsolute(path), 'native-preflight-absolute-host-path-required');
  for (const path of [options.root, options.source, options.control, options.fixtureHome])
    assert(
      lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(),
      'native-preflight-ordinary-directory-required',
    );
  const directory = join(options.root, 'native-preflight');
  assert(!existsSync(directory), 'native-preflight-original-directory-already-exists');
  mkdirSync(directory, { mode: 0o700 });
  const reportPath = join(directory, 'report.json');
  const report: Record<string, unknown> = {
    status: 'running',
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    startedAt: new Date().toISOString(),
    backend: 'macos-seatbelt-launchd-coalition',
    providerRequests: 0,
    gitCommands: 0,
    requestedScope: scope,
    source: realpathSync(options.source),
    supervisorPath: options.supervisorPath,
    fixtureHome: options.fixtureHome,
    closeConfirmed: false,
  };
  const save = () =>
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  save();
  const sessionId = 'native-preflight';
  const subjectId = 'native-preflight-operator';
  const profile = selectProfile({ dataRoot: join(directory, 'state'), profile: 'preflight' });
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let expectedStoreId: string | undefined;
  let sessionCreated = false;
  let hasFailure = false;
  let failure: unknown;
  const errors: { phase: string; message: string }[] = [];
  const failed = (phase: string, error: unknown) => {
    if (!hasFailure) failure = error;
    hasFailure = true;
    errors.push({ phase, message: error instanceof Error ? error.message : String(error) });
  };
  const dispatches: { executionId: string; scope: typeof scope; authorization: unknown }[] = [];
  const capture = async (active: Awaited<ReturnType<typeof openSqliteStore>>) => {
    if (!expectedStoreId || !sessionCreated) return;
    const { executions } = await readLiveExecutionDirectory(active, {
      expectedStoreId,
      sessionId,
      subjectId,
    });
    report.executions = executions;
    report.dispatches = dispatches;
    const references = await active.listExtensionRecords({
      extensionId: 'builtin.shell',
      sessionId,
      contentType: 'application/vnd.kite.shell-reference+json',
      limit: 200,
    });
    report.references = references;
    const outputs = [];
    for (const job of executions.filter((row) => row.kind === 'job'))
      outputs.push(await completeJobOutput(active, job.id, 'shell'));
    report.outputs = outputs;
    save();
    return { executions, references, outputs };
  };
  try {
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    const host = await createShellConfiguration({
      workspaceRoot: options.source,
      toolIds: ['shell.execute'],
      signal: options.signal,
      options: {
        platform: 'darwin',
        configurationId: 'worktree-native-preflight',
        env: { PATH: '/usr/bin:/bin', HOME: options.fixtureHome },
        supervisorPath: options.supervisorPath,
        runtimeExecutable: process.execPath,
        shellExecutable: '/bin/sh',
        host: {
          controlBase: options.control,
          protectedRoots: [profile.dataRoot, options.control, join(options.root, 'evidence')],
          readonlyAssets: [dirname(options.supervisorPath)],
          runtimeReadOnlyRoots: [dirname(process.execPath)],
        },
      },
    });
    report.configuration = host.snapshot;
    store = await openSqliteStore(profile);
    expectedStoreId = (await store.getMetadata()).storeId;
    report.originStoreId = expectedStoreId;
    const command = "printf '%s\\n' 'kite-worktree-native-preflight'";
    const model = createFixedModel([
      [
        {
          type: 'tool_call',
          id: 'native-preflight-call',
          name: 'shell_execute',
          arguments: JSON.stringify({ command, ...scope }),
        },
        { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
    ]);
    const permissions = createPermissionPolicy({
      readPolicy: () => ({
        mode: 'accept_edits',
        workspaceTrust: true,
        revision: 'native-preflight',
        allowed: [
          { kind: 'model', definitionId: 'fixed', definitionVersion: '1' },
          { kind: 'tool', definitionId: 'shell.execute', definitionVersion: '1' },
          { kind: 'job', definitionId: 'shell.command', definitionVersion: '1' },
        ],
      }),
      describeCapability: async (request) => ({
        kind: request.kind,
        definitionId: request.definitionId,
        definitionVersion: request.definitionVersion,
        revision: 'native-preflight',
        hardAllowed: true,
        ...(request.kind === 'model'
          ? { effects: [] as const, safeRead: false }
          : builtinCapability(
              'builtin.shell',
              request.definitionId,
              request.kind,
              'builtin.planning',
              request.definitionVersion,
            )),
        ...(await host.describeRequest(request)),
      }),
    });
    const extensions = host.extensions.map((extension) => ({
      ...extension,
      jobs: extension.jobs?.map((job) => ({
        ...job,
        async start(input: Json, context: JobContext) {
          const accepted = hostExecutionScope(context);
          assert.deepEqual(accepted, scope, 'native-preflight-scope-must-not-expand');
          dispatches.push({
            executionId: context.executionId,
            scope: accepted as typeof scope,
            authorization: structuredClone(context.dispatchAuthorization),
          });
          save();
          return job.start(input, context);
        },
      })),
    }));
    runtime = createRuntime({
      store,
      model,
      modelId: 'fixed',
      permissions,
      extensions,
    });
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Native preflight only',
      rootUri: pathToFileURL(realpathSync(options.source)).href,
    });
    await runtime.createSession({
      expectedStoreId,
      sessionId,
      workspaceId: 'w',
      subjectId,
      commandId: 'create-preflight-session',
      title: 'Read-only native preflight',
    });
    sessionCreated = true;
    await runtime.submitCommand({
      expectedStoreId,
      sessionId,
      subjectId,
      commandId: 'native-preflight-run',
      request: {
        kind: 'run.start',
        content:
          'Execute the single fixed read-only printf probe through the existing managed Shell, then stop. No Git, network, Provider or filesystem business mutation.',
      },
    });
    for (;;) {
      options.signal.throwIfAborted();
      const accepted = await store.getCommand('native-preflight-run');
      assert(
        accepted &&
          !['rejected', 'failed', 'outcome_unknown', 'needs_review'].includes(accepted.status),
        'native-preflight-command-not-accepted',
      );
      const runId = object(accepted.receipt).runId;
      const run = typeof runId === 'string' ? await store.getRun(runId) : null;
      if (run && !run.isActive) {
        assert.equal(run.status, 'completed', 'native-preflight-run-not-complete');
        break;
      }
      await fixtureDelay(25);
    }
    const captured = await capture(store);
    assert(captured);
    const tools = captured.executions.filter((row) => row.kind === 'tool');
    const jobs = captured.executions.filter((row) => row.kind === 'job');
    assert.equal(tools.length, 1, 'native-preflight-exactly-one-tool');
    assert.equal(jobs.length, 1, 'native-preflight-exactly-one-job');
    const tool = tools[0]!;
    const job = jobs[0]!;
    assert.equal(tool.definitionId, 'shell.execute');
    assert.equal(job.definitionId, 'shell.command');
    assert.equal(job.parentExecutionId, tool.id);
    assert.equal(job.cancelWithParent, true);
    for (const execution of [tool, job]) {
      assert.equal(execution.status, 'succeeded');
      assert.equal(object(execution.result).outcome, 'succeeded');
      assert.equal(object(execution.input).command, command);
    }
    assert.equal(dispatches.length, 1);
    assert.deepEqual(object(job.input).permissions, scope);
    const ref = object(object(tool.result).details).ref;
    assert.equal(captured.references.length, 1);
    assert.deepEqual(object(captured.references[0]!.value).ref, ref);
    assert.equal(object(ref).executionId, job.id);
    assert.equal(object(ref).commandId, job.originCommandId);
    assert.equal(object(ref).originStoreId, expectedStoreId);
    assert.equal(object(ref).sessionId, sessionId);
    const originalCommand = await store.getCommand(job.originCommandId);
    const referenceProof = worktreeLiveShellReferenceEvidence(
      job,
      tool,
      captured.references,
      originalCommand,
    );
    assert(referenceProof.exactOriginalCommand && referenceProof.uniqueOriginalRecordAndReceipt);
    report.originalReferenceProof = referenceProof;
    const output = captured.outputs[0]!;
    assert.equal(output.stdout, 'kite-worktree-native-preflight\n');
    assert.equal(output.stderr, '');
    const reference = object(job.reference);
    const original = object(reference.ownedProcesses);
    const details = object(object(job.result).details);
    const ended = decodeMacosShellProcessEvidence(
      details.ownedProcesses,
      { executionId: job.id, sessionId, nonce: String(reference.nonce) },
      process.pid,
    );
    assert(
      ended && shellProcessEvidenceEnded(ended),
      'native-preflight-original-stop-proof-required',
    );
    assert.deepEqual(ended.root.identity, object(original.root).identity);
    assert.equal(ended.coalition.id, reference.coalitionId);
    assert.equal(details.groupStopped, true);
    assert.equal(details.processTreeStopped, true);
    report.originalStopConfirmed = true;
    report.originalReference = ref;
    report.originalCommand = originalCommand;
  } catch (error) {
    failed('probe', error);
  } finally {
    if (store) {
      try {
        await capture(store);
      } catch (error) {
        failed('capture-before-close', error);
      }
    }
    try {
      if (runtime) await runtime.close();
      else await store?.close();
      report.closeConfirmed = true;
    } catch (error) {
      failed('close', error);
    }
    if (report.closeConfirmed && expectedStoreId && sessionCreated) {
      let cold: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
      try {
        cold = await openSqliteStore(profile);
        await capture(cold);
        const safety = await cold.readExecutionGroupSafety({
          expectedStoreId,
          sessionId,
          subjectId,
        });
        report.coldSafety = safety;
        assert(safety.quiescent, 'native-preflight-close-not-quiescent');
        assert.equal(
          (await cold.getSession(sessionId))?.ownerInstanceId,
          null,
          'native-preflight-session-owner-not-released',
        );
        report.coldReadConfirmed = true;
      } catch (error) {
        failed('cold-read', error);
      } finally {
        try {
          await cold?.close();
        } catch (error) {
          failed('cold-close', error);
        }
      }
    }
    try {
      options.signal.throwIfAborted();
    } catch (error) {
      failed('cancelled-after-close', error);
    }
    report.finishedAt = new Date().toISOString();
    report.errors = errors;
    report.status = hasFailure ? 'failed' : 'passed';
    save();
  }
  if (hasFailure) {
    options.signal.throwIfAborted();
    throw new Error(`git_worktree_native_preflight_failed: ${reportPath}`, { cause: failure });
  }
  return { reportPath, status: 'passed' as const, closeConfirmed: true as const };
}
