/** Disposable Linux evaluation host. Calls the unchanged development CLI/Service. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { launchPairedService, type PairedServiceChild } from '../../apps/service/src/paired';
import { selectProfile } from '../../packages/agent/src/profile';
import {
  createTrajectoryBundle,
  openTrajectoryBundle,
  readOrdinaryCommandApplication,
  readTrajectoryEvidence,
} from '../../packages/client/src';
import { selectDevelopmentServiceArtifact } from '../../scripts/development/unified-cli';
import { createInvocationLifetime, InvocationStopped } from './lifetime';

export type RunStatus =
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'needs_input'
  | 'cancelled'
  | 'timed_out';
export interface LaunchArguments {
  instructionFile: string;
  workspace: string;
  output: string;
  deadlineMs: number;
}
export interface KiteRunReport {
  schema: 'kite-harbor-run-1';
  status: RunStatus;
  cliExitCode: number | null;
  sourceCommit: string;
  sourceDirty: boolean;
  classification: 'deterministic-mock-plumbing-only' | 'configured-model-run';
  realModelEvaluation: boolean;
  originalIds: Record<string, string>;
  trajectory: {
    exported: boolean;
    eventCount: number;
    evidenceCount: number;
    evidenceIssueCount: number;
    integrity?: unknown;
  };
  startedAt: string;
  finishedAt?: string;
  error?: string;
  cleanup?: string;
}
const repositoryRoot = realpathSync(resolve(import.meta.dir, '../..'));
const save = (path: string, data: unknown) =>
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const privateDir = (path: string) => mkdirSync(path, { recursive: true, mode: 0o700 });

export function parseLaunchArguments(argv: string[]): LaunchArguments {
  const values = new Map<string, string>();
  for (let n = 0; n < argv.length; n += 2) {
    const key = argv[n],
      value = argv[n + 1];
    if (
      !key ||
      !value ||
      values.has(key) ||
      !['--instruction-file', '--workspace', '--output', '--deadline-ms'].includes(key)
    )
      throw Error('invalid_launcher_arguments');
    values.set(key, value);
  }
  const paths = ['--instruction-file', '--workspace', '--output'].map((key) => values.get(key));
  if (paths.some((path) => !path || !isAbsolute(path)))
    throw Error('absolute_launcher_paths_required');
  const deadlineMs = Number(values.get('--deadline-ms') ?? 120000);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 86400000)
    throw Error('invalid_deadline');
  return { instructionFile: paths[0]!, workspace: paths[1]!, output: paths[2]!, deadlineMs };
}

function sourceIdentity() {
  const stamp = join(repositoryRoot, 'integrations/harbor/source.json');
  if (existsSync(stamp)) {
    const value = JSON.parse(readFileSync(stamp, 'utf8')) as { commit: string };
    if (!/^[a-f0-9]{40}$/.test(value.commit)) throw Error('invalid_source_stamp');
    return { sourceCommit: value.commit, sourceDirty: false };
  }
  const sha = Bun.spawnSync(['git', '-C', repositoryRoot, 'rev-parse', 'HEAD']);
  const sourceCommit = Buffer.from(sha.stdout).toString().trim();
  if (sha.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(sourceCommit))
    throw Error('source_identity_unavailable');
  const status = Bun.spawnSync(['git', '-C', repositoryRoot, 'status', '--porcelain']);
  if (status.exitCode !== 0) throw Error('source_status_unavailable');
  return { sourceCommit, sourceDirty: status.stdout.byteLength !== 0 };
}

async function within<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ done: true as const, value })),
      new Promise<{ done: false }>((resolve_) => {
        timer = setTimeout(() => resolve_({ done: false }), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function interpretCLI(stdout: string, exitCode: number | null) {
  const lines = stdout.split('\n');
  const intents = lines.filter((line) => line.startsWith('work intent '));
  if (intents.length !== 1) throw Error('one_original_work_intent_required');
  const intent = JSON.parse(intents[0]!.slice('work intent '.length)) as Record<string, string>;
  for (const key of ['storeId', 'sessionId', 'commandId'])
    if (typeof intent[key] !== 'string' || !intent[key]) throw Error('invalid_original_identity');
  const answers = lines.filter((line) => line.startsWith('answer '));
  const answer =
    answers.length === 1 ? (JSON.parse(answers[0]!.slice(7)) as Record<string, unknown>) : null;
  const status: RunStatus =
    exitCode === 2 || exitCode === null
      ? 'unknown'
      : exitCode === 3
        ? 'needs_input'
        : exitCode === 130
          ? 'cancelled'
          : exitCode === 0
            ? 'succeeded'
            : 'failed';
  if (status === 'succeeded') {
    if (
      !lines.includes(`terminal ${intent.commandId} succeeded`) ||
      !answer ||
      answer.complete !== true
    )
      throw Error('successful_original_terminal_required');
    for (const key of ['storeId', 'sessionId', 'commandId'])
      if (answer[key] !== intent[key]) throw Error('answer_identity_mismatch');
    if (typeof answer.executionId !== 'string' || !answer.executionId)
      throw Error('execution_identity_missing');
  }
  return { intent, answer, status };
}

export async function runKiteTask(
  args: LaunchArguments,
  options: {
    configuration: unknown;
    classification: KiteRunReport['classification'];
    beforeExport?: () => unknown;
    afterExport?: (before: unknown) => void;
  },
): Promise<KiteRunReport> {
  if (process.platform !== 'linux') throw Error('first_adapter_supports_linux_only');
  const output = resolve(args.output),
    workspace = realpathSync(args.workspace);
  privateDir(output);
  const reportFile = join(output, 'kite-run.json');
  if (existsSync(reportFile)) throw Error('output_already_has_a_run_report');
  const report: KiteRunReport = {
    schema: 'kite-harbor-run-1',
    status: 'unknown',
    cliExitCode: null,
    ...sourceIdentity(),
    classification: options.classification,
    realModelEvaluation: options.classification === 'configured-model-run',
    originalIds: {},
    trajectory: { exported: false, eventCount: 0, evidenceCount: 0, evidenceIssueCount: 0 },
    startedAt: new Date().toISOString(),
  };
  save(reportFile, report);
  const lifetime = createInvocationLifetime(args.deadlineMs);
  let exporter: Awaited<ReturnType<typeof launchPairedService>> | undefined;
  let exporterChild: PairedServiceChild | undefined;
  let exporterLaunch: Promise<Awaited<ReturnType<typeof launchPairedService>>> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<number | null> | undefined;
  let streams: Promise<unknown> | undefined;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  try {
    const runtime = join(tmpdir(), `kite-harbor-owned-${randomUUID()}`),
      home = join(runtime, 'home');
    for (const path of [runtime, home, join(home, '.kite-code'), join(runtime, 'empty-codex-home')])
      privateDir(path);
    // Only explicitly supplied config is used; no host HOME, environment keys or auth cache is inherited.
    writeFileSync(join(home, '.kite-code/kite-code.jsonc'), JSON.stringify(options.configuration), {
      mode: 0o600,
    });
    const childEnv = {
      PATH: process.env.PATH ?? '',
      LANG: 'C.UTF-8',
      HOME: home,
      CODEX_HOME: join(runtime, 'empty-codex-home'),
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      BUN_CONFIG_NO_CLEAR_TERMINAL: '1',
    };
    const profile = selectProfile({ dataRoot: join(home, '.kite-code'), profile: 'development' });
    const artifact = selectDevelopmentServiceArtifact(repositoryRoot, process.execPath);
    const instruction = readFileSync(args.instructionFile, 'utf8');
    if (!instruction || Buffer.byteLength(instruction) > 96 * 1024)
      throw Error('instruction_size_out_of_bounds');
    const argv = [
      'run',
      '--workspace',
      workspace,
      '--thread',
      `harbor-${randomUUID()}`,
      '--trust-workspace',
      '--full',
      '--task',
      instruction,
    ];
    save(join(output, 'invocation.json'), {
      argv,
      instructionSha256: hash(instruction),
      artifact,
      ...sourceIdentity(),
      profile: profile.profile,
      permissionScope: 'Full only in this disposable benchmark workspace/container',
    });
    lifetime.check();
    child = spawn(
      process.execPath,
      [join(repositoryRoot, 'scripts/development/unified-cli.ts'), ...argv],
      { cwd: workspace, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    exited = new Promise<number | null>((resolve_, reject) => {
      child!.once('error', reject);
      child!.once('exit', (code) => resolve_(code));
    });
    streams = Promise.all([
      pipeline(child.stdout!, createWriteStream(join(output, 'kite.stdout.log'), { mode: 0o600 })),
      pipeline(child.stderr!, createWriteStream(join(output, 'kite.stderr.log'), { mode: 0o600 })),
    ]);
    // Observe stream errors immediately; a write failure terminates the owned processes.
    const code = await lifetime.guard(Promise.all([exited, streams]).then(([code]) => code));
    report.cliExitCode = code;
    const parsed = interpretCLI(readFileSync(join(output, 'kite.stdout.log'), 'utf8'), code);
    report.originalIds = { ...parsed.intent };
    if (parsed.answer && typeof parsed.answer.executionId === 'string')
      report.originalIds.executionId = parsed.answer.executionId;
    report.status = parsed.status;
    save(join(output, 'cli-answer.json'), parsed.answer);
    save(reportFile, report);
    if (report.status !== 'succeeded') return report;

    // Cold reopen the same profile; GET-only identity/trajectory reads, no new Work.
    const before = options.beforeExport?.();
    exporterLaunch = launchPairedService({
      entrypoint: artifact.entrypoint,
      profile,
      instanceId: randomUUID(),
      buildId: artifact.buildId,
      apiMajor: artifact.apiMajor,
      executable: process.execPath,
      requiredCapabilities: ['commands', 'trajectory', 'trajectory_evidence'],
      startupTimeoutMs: 10000,
      shutdownTimeoutMs: 10000,
      spawnChild: (command) => {
        exporterChild = Bun.spawn([...command], {
          env: childEnv,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
        return exporterChild;
      },
    });
    // Keep ownership even if cancellation wins during startup. Cleanup also joins this promise.
    void exporterLaunch.then(
      (value) => {
        exporter = value;
      },
      () => {},
    );
    exporter = await lifetime.guard(exporterLaunch);
    const client = exporter.client,
      intent = parsed.intent;
    const command = await lifetime.guard(
      client.getCommand(intent.commandId!, { signal: lifetime.signal }),
    );
    const application = await lifetime.guard(
        readOrdinaryCommandApplication(client, command, { signal: lifetime.signal }),
      ),
      run = application?.run;
    if (
      command.originStoreId !== intent.storeId ||
      command.sessionId !== intent.sessionId ||
      !run ||
      run.originStoreId !== intent.storeId ||
      run.sessionId !== intent.sessionId ||
      run.originCommandId !== intent.commandId ||
      run.status !== 'completed' ||
      run.isActive
    )
      throw Error('cold_original_run_identity_or_terminal_mismatch');
    const execution = await lifetime.guard(
      client.getExecution(report.originalIds.executionId!, { signal: lifetime.signal }),
    );
    if (
      execution.id !== report.originalIds.executionId ||
      execution.originStoreId !== intent.storeId ||
      execution.sessionId !== intent.sessionId ||
      execution.runId !== run.id ||
      execution.kind !== 'model' ||
      execution.status !== 'succeeded'
    )
      throw Error('cold_original_execution_mismatch');
    report.originalIds.runId = run.id;
    save(join(output, 'original-execution.json'), execution);
    save(join(output, 'original-command.json'), command);
    save(join(output, 'original-run.json'), run);
    const snapshot = await lifetime.guard(
      client.openTrajectory(
        { storeId: intent.storeId!, sessionId: intent.sessionId!, runId: run.id },
        { signal: lifetime.signal },
      ),
    );
    save(join(output, 'trajectory-snapshot.json'), snapshot);
    const bundleRoot = join(output, 'kite-trajectory'),
      written: string[] = [],
      cursors = new Map<string, string>();
    privateDir(bundleRoot);
    for await (const frame of createTrajectoryBundle({
      snapshot,
      signal: lifetime.signal,
      async readEvents(request, signal) {
        const page = await lifetime.guard(client.readTrajectoryEvents(request, { signal }));
        for (const event of page.events) {
          cursors.set(event.eventId, event.sequence);
          report.trajectory.eventCount++;
        }
        return page;
      },
      async readEvidence(eventId, ref, signal) {
        const atCursor = cursors.get(eventId);
        if (!atCursor) throw Error('original_evidence_cursor_missing');
        try {
          const result = await lifetime.guard(
            readTrajectoryEvidence(
              client,
              {
                storeId: intent.storeId!,
                sessionId: intent.sessionId!,
                upperCursor: snapshot.upperCursor,
                atCursor,
                eventId,
                evidenceId: ref.evidenceId,
                contentVersion: ref.contentVersion,
              },
              { signal },
            ),
          );
          report.trajectory.evidenceCount++;
          return result.content;
        } catch {
          lifetime.check();
          report.trajectory.evidenceIssueCount++;
          return null;
        }
      },
    })) {
      lifetime.check();
      const path = join(bundleRoot, frame.path);
      privateDir(dirname(path));
      writeFileSync(path, frame.bytes, { mode: 0o600 });
      written.push(frame.path);
    }
    await lifetime.guard(exporter.close());
    exporter = undefined;
    const local = await openTrajectoryBundle({
      async list() {
        return written;
      },
      async read(path) {
        return new Uint8Array(readFileSync(join(bundleRoot, path)));
      },
    });
    let cursor = '0',
      count = 0;
    for (;;) {
      const page = await local.readEvents({
        storeId: snapshot.storeId,
        sessionId: snapshot.sessionId,
        runId: run.id,
        upperCursor: snapshot.upperCursor,
        afterCursor: cursor,
        limit: 200,
      });
      count += page.events.length;
      if (page.exhausted) break;
      cursor = page.scannedThrough;
    }
    if (!count || count !== report.trajectory.eventCount || report.trajectory.evidenceIssueCount)
      throw Error('trajectory_export_incomplete');
    report.trajectory.integrity = local.manifest.integrity;
    local.clearCache();
    options.afterExport?.(before);
    lifetime.check();
    report.trajectory.exported = true;
    return report;
  } catch (error) {
    const stopped = lifetime.signal.aborted ? lifetime.signal.reason : error;
    report.status = stopped instanceof InvocationStopped ? stopped.outcome : 'unknown';
    report.error = error instanceof Error ? error.message : String(error);
    return report;
  } finally {
    // Cleanup has its own maximum allowance, less than the adapter's +60 seconds.
    // Group signals cover descendants that stayed in our process group; Docker teardown
    // remains the final boundary for arbitrary descendants of a future task.
    if (child && exited) {
      try {
        signalGroup('SIGINT');
        let result = await within(exited, 10000);
        if (!result.done) {
          signalGroup('SIGTERM');
          result = await within(exited, 5000);
        }
        signalGroup('SIGKILL');
        if (!result.done) result = await within(exited, 5000);
        if (!result.done) {
          report.status = 'unknown';
          report.cleanup = 'owned_cli_exit_unconfirmed';
        } else report.cliExitCode ??= result.value;
      } catch {
        report.status = 'unknown';
        report.cleanup = 'owned_cli_cleanup_failed';
      }
    }
    if (streams) {
      try {
        if (!(await within(streams, 2000)).done) {
          report.status = 'unknown';
          report.cleanup = 'cli_stream_drain_unconfirmed';
        }
      } catch {
        report.status = 'unknown';
        report.cleanup = 'cli_stream_write_failed';
      }
    }
    if (exporterLaunch) {
      try {
        const cleanup = async () => {
          const service = exporter ?? (await exporterLaunch!);
          await service.close();
        };
        let closed = await within(cleanup(), 15000);
        if (!closed.done) {
          exporterChild?.kill('SIGKILL');
          closed = await within(cleanup(), 5000);
        }
        if (!closed.done) {
          report.status = 'unknown';
          report.cleanup = 'exporter_close_unconfirmed';
        }
      } catch {
        report.status = 'unknown';
        report.cleanup = 'exporter_close_failed';
      }
    }
    if (lifetime.signal.aborted && report.status === 'succeeded')
      report.status = (lifetime.signal.reason as InvocationStopped).outcome;
    lifetime.dispose();
    // A timeout/cancellation still retains any already-written original identity.
    // Never submit a second Work to repair a missing or unknown receipt.
    if (!report.originalIds.commandId) {
      try {
        const observed = interpretCLI(
          readFileSync(join(output, 'kite.stdout.log'), 'utf8'),
          report.cliExitCode,
        );
        report.originalIds = { ...observed.intent };
        if (typeof observed.answer?.executionId === 'string')
          report.originalIds.executionId = observed.answer.executionId;
      } catch {
        /* No valid original Work was observed. Raw logs remain available. */
      }
    }
    save(join(output, 'owned-processes.json'), {
      cliPid: child?.pid ?? null,
      cliExitCode: child?.exitCode ?? null,
      cliSignalCode: child?.signalCode ?? null,
      exporterPid: exporterChild?.pid ?? null,
      cleanup: report.cleanup ?? null,
      scope:
        'Owned CLI leader and paired exporter only; no arbitrary descendant containment claim.',
    });
    report.finishedAt = new Date().toISOString();
    save(reportFile, report);
  }
}
