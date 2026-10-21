import { createHash } from 'node:crypto';
import {
  type AgentClient,
  ClientError,
  type Command,
  canonicalCallerCommandRequest,
  readOrdinaryCommandApplication,
  type SessionView,
  type StartCommandRequest,
} from '@kite-ai/client';
import type {
  ScheduledTaskInput,
  ScheduledTaskRun,
  ScheduledTaskRunUpdate,
} from '../src/scheduled-task-types';
import type { PrivateData } from './private-data';
import {
  type NativeScheduledTaskData,
  parseScheduledTaskInput,
  validateScheduledTaskInput,
} from './scheduled-tasks';

export type ScheduledTaskClock = {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
};
const clock: ScheduledTaskClock = {
  now: Date.now,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const startRequest = (run: ScheduledTaskRun): StartCommandRequest => ({
  kind: 'run.start',
  expectedStoreId: run.task.storeId,
  commandId: run.startCommandId,
  content: run.task.prompt,
  modelId: run.task.modelId,
});
const requestDigest = (run: ScheduledTaskRun) =>
  createHash('sha256')
    .update(canonicalCallerCommandRequest(startRequest(run)))
    .digest('hex');
const terminal = (run: Pick<ScheduledTaskRun, 'status'>) =>
  ['completed', 'failed', 'cancelled'].includes(run.status);
const errorCode = (error: unknown) =>
  error instanceof ClientError ? error.code : 'scheduled_outcome_unknown';
const rejected = (error: unknown) =>
  error instanceof ClientError &&
  !!error.problem &&
  error.status !== undefined &&
  error.status >= 400 &&
  error.status < 500 &&
  ![408, 425, 429].includes(error.status);

/** Desktop-owned scheduling only. All model work and permissions remain ordinary Service work. */
export class ScheduledTaskRunner {
  private readonly clock: ScheduledTaskClock;
  private timer?: unknown;
  private stopped = true;
  private work?: Promise<void>;
  private readonly active = new Map<string, Promise<void>>();
  private readonly manual = new Set<Promise<unknown>>();
  private readonly deleted = new Set<string>();
  private readonly legacyChecks = new Map<string, number>();
  private legacyCheckSequence = 0;
  private readonly client: AgentClient;
  private readonly data: NativeScheduledTaskData & Pick<PrivateData, 'begin' | 'finish'>;
  private readonly options: { clock?: ScheduledTaskClock; pollMs?: number; changed?: () => void };
  constructor(
    client: AgentClient,
    data: NativeScheduledTaskData & Pick<PrivateData, 'begin' | 'finish'>,
    options: { clock?: ScheduledTaskClock; pollMs?: number; changed?: () => void } = {},
  ) {
    this.client = client;
    this.data = data;
    this.options = options;
    this.clock = options.clock ?? clock;
  }
  list() {
    const result = {
      kind: 'scheduled.tasks' as const,
      tasks: this.data.scheduledTasks(),
      runs: [] as Omit<ScheduledTaskRun, 'task'>[],
    };
    // Budget actual UTF-8 JSON, including escaping, below the IPC envelope limit.
    const budget = 3 * 1024 * 1024;
    let bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes > budget) throw Error('scheduled_result_too_large');
    const counts = new Map<string, number>();
    const candidates = this.data
      .scheduledTaskRuns()
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    for (const { task, ...persisted } of candidates) {
      const run =
        terminal(persisted) &&
        persisted.settlementVersion !== 1 &&
        task.storeId === this.client.serverInfo?.storeId
          ? {
              ...persisted,
              status: 'unknown' as const,
              error: persisted.error ?? 'scheduled_task_history_unverified',
            }
          : persisted;
      if (result.runs.length >= 128) break;
      const count = counts.get(run.taskId) ?? 0;
      if (count >= 20) continue;
      const added = Buffer.byteLength(JSON.stringify(run)) + (result.runs.length ? 1 : 0);
      if (bytes + added > budget) break;
      result.runs.push(run);
      counts.set(run.taskId, count + 1);
      bytes += added;
    }
    return result;
  }
  private assertStore(storeId: string) {
    if (!storeId || this.client.serverInfo?.storeId !== storeId)
      throw new ClientError('store_identity_mismatch');
  }
  async save(input: ScheduledTaskInput, operation: 'create' | 'update') {
    const original = parseScheduledTaskInput(structuredClone(input));
    const assertEditingTarget = () => {
      const existing = this.data.scheduledTasks().find((task) => task.id === original.id);
      if ((original.id && this.deleted.has(original.id)) || (operation === 'update' && !existing))
        throw Error('scheduled_task_not_found');
      if (
        operation === 'create' &&
        existing &&
        JSON.stringify(validateScheduledTaskInput(existing)) !== JSON.stringify(original)
      )
        throw Error('scheduled_task_identity_conflict');
    };
    assertEditingTarget();
    this.assertStore(original.storeId);
    const [workspaces, models] = await Promise.all([
      this.client.listWorkspaces(),
      this.client.getModelSettings('user', { storeId: original.storeId }),
    ]);
    this.assertStore(original.storeId);
    if (!workspaces.some((workspace) => workspace.id === original.workspaceId))
      throw Error('scheduled_workspace_missing');
    if (
      !models.models.some(
        (model) => model.id === original.modelId && model.enabled && model.configured,
      )
    )
      throw Error('scheduled_model_unavailable');
    // Explicit creates preserve the renderer retry identity; updates never recreate a
    // deleted target after their read-only validation, including outside NativeCaller.
    assertEditingTarget();
    this.data.saveScheduledTask(original, this.clock.now());
    this.changed();
    return this.list();
  }
  delete(id: string) {
    this.data.deleteScheduledTask(id);
    this.deleted.add(id);
    this.changed();
    return this.list();
  }
  async toggle(id: string, enabled: boolean) {
    const task = this.data.scheduledTasks().find((task) => task.id === id);
    if (!task) throw Error('scheduled_task_missing');
    const { nextRunAt: _next, createdAt: _created, updatedAt: _updated, ...input } = task;
    // Pausing must remain possible even when the configured model is unavailable.
    if (!enabled) {
      this.data.saveScheduledTask({ ...input, enabled }, this.clock.now());
      this.changed();
      return this.list();
    }
    return this.save({ ...input, enabled }, 'update');
  }
  runNow(id: string) {
    const work = this.runManual(id);
    this.manual.add(work);
    void work.then(
      () => this.manual.delete(work),
      () => this.manual.delete(work),
    );
    return work;
  }
  private async runManual(id: string) {
    if (this.stopped) throw Error('scheduled_runner_stopped');
    const task = this.data.scheduledTasks().find((item) => item.id === id);
    if (task) this.assertStore(task.storeId);
    if (
      this.data
        .scheduledTaskRuns(id)
        .some(
          (run) =>
            run.task.storeId === this.client.serverInfo?.storeId &&
            terminal(run) &&
            run.settlementVersion !== 1,
        )
    ) {
      await this.verifyLegacy(new Set([id]));
      if (this.stopped) throw Error('scheduled_runner_stopped');
    }
    if (
      this.data
        .scheduledTaskRuns(id)
        .some(
          (run) =>
            run.task.storeId === this.client.serverInfo?.storeId &&
            terminal(run) &&
            run.settlementVersion !== 1,
        )
    )
      throw Error('scheduled_task_history_unverified');
    const run = this.data.claimScheduledTask(id, this.clock.now(), {
      manual: true,
      storeId: this.client.serverInfo?.storeId,
    });
    if (run) await this.launch(run);
    this.changed();
    return this.list();
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick().catch(() => {});
  }
  async stop() {
    this.stopped = true;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    await this.work;
    await Promise.allSettled(this.manual);
    await Promise.all(this.active.values());
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.work) return this.work;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.work = this.cycle().finally(() => {
      this.work = undefined;
      this.arm();
    });
    return this.work;
  }
  private arm() {
    if (this.stopped || this.timer !== undefined) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.tick().catch(() => {});
    }, this.options.pollMs ?? 1000);
  }
  private changed() {
    this.options.changed?.();
  }
  private update(run: ScheduledTaskRun, update: ScheduledTaskRunUpdate) {
    const result = this.data.updateScheduledTaskRun(run.id, update, this.clock.now());
    this.changed();
    return result;
  }
  private async verifyLegacy(taskIds: ReadonlySet<string>) {
    const bindings = new Set(
      this.data
        .scheduledTasks()
        .filter((task) => taskIds.has(task.id) && task.storeId === this.client.serverInfo?.storeId)
        .map((task) => task.id),
    );
    const candidates = this.data
      .scheduledTaskRuns()
      .filter(
        (run) =>
          bindings.has(run.taskId) &&
          run.task.storeId === this.client.serverInfo?.storeId &&
          terminal(run) &&
          run.settlementVersion !== 1,
      );
    candidates.sort(
      (a, b) =>
        (this.legacyChecks.get(a.id) ?? -1) - (this.legacyChecks.get(b.id) ?? -1) ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id),
    );
    // Global per-cycle budget, with fair retry ordering. A failed or unknown group is
    // never marked verified; subsequent occurrences remain due until all gates clear.
    for (const run of candidates.slice(0, 4)) {
      if (this.stopped) return;
      this.legacyChecks.set(run.id, ++this.legacyCheckSequence);
      await this.observe(run);
    }
  }
  private async cycle() {
    for (const run of this.data.scheduledTaskRuns().filter((run) => !terminal(run))) {
      if (this.stopped) return;
      // Restored records retain their original identity and are read-only history.
      if (run.task.storeId !== this.client.serverInfo?.storeId) continue;
      if (!this.active.has(run.id)) await this.observe(run);
    }
    await this.verifyLegacy(
      new Set(
        this.data
          .scheduledTasks()
          .filter(
            (task) => task.enabled && task.nextRunAt !== null && task.nextRunAt <= this.clock.now(),
          )
          .map((task) => task.id),
      ),
    );
    for (const task of this.data.scheduledTasks()) {
      if (this.stopped) return;
      if (!task.enabled || task.nextRunAt === null || task.nextRunAt > this.clock.now()) continue;
      if (task.storeId !== this.client.serverInfo?.storeId) continue;
      const run = this.data.claimScheduledTask(task.id, this.clock.now(), {
        storeId: this.client.serverInfo?.storeId,
      });
      if (run) await this.launch(run);
    }
  }
  private launch(run: ScheduledTaskRun) {
    const pending = this.active.get(run.id);
    if (pending) return pending;
    const work = this.execute(run).finally(() => this.active.delete(run.id));
    this.active.set(run.id, work);
    return work;
  }
  private async execute(run: ScheduledTaskRun) {
    let mutation: 'create' | 'start' | undefined;
    try {
      this.assertStore(run.task.storeId);
      const input = {
        expectedStoreId: run.task.storeId,
        commandId: run.createCommandId,
        sessionId: run.sessionId,
        workspaceId: run.task.workspaceId,
        title: run.task.name,
      };
      this.update(run, { status: 'creating' });
      const intent = this.data.begin(input);
      if (!intent.created) {
        await this.observe(run);
        return;
      }
      mutation = 'create';
      const session = await this.client.createSession(intent.value.input);
      mutation = undefined;
      this.assertStore(run.task.storeId);
      if (
        session.id !== run.sessionId ||
        session.workspaceId !== run.task.workspaceId ||
        session.parentSessionId !== null
      )
        throw Error('scheduled_identity_mismatch');
      this.data.finish(run.createCommandId, 'created');
      // A shutdown between effects must not start new model work. Recovery is GET-only.
      if (this.stopped) {
        this.update(run, { status: 'unknown', error: 'scheduled_stopped_before_start' });
        return;
      }
      this.update(run, { status: 'starting' });
      mutation = 'start';
      const command = await this.client.startRun(run.sessionId, startRequest(run));
      mutation = undefined;
      await this.observeCommand(run, command);
    } catch (error) {
      if (run.task.storeId !== this.client.serverInfo?.storeId) return;
      const known = mutation !== undefined && rejected(error);
      if (mutation === 'create')
        this.data.finish(run.createCommandId, known ? 'rejected' : 'unknown', errorCode(error));
      this.update(run, {
        status: known ? 'failed' : 'unknown',
        error: errorCode(error),
        ...(known ? { settlementVersion: 1 as const } : {}),
      });
    }
  }
  /** Never replay a mutation, including a claim persisted just before process death. */
  private async observe(run: ScheduledTaskRun) {
    try {
      this.assertStore(run.task.storeId);
      if (!run.serviceRunId) {
        const creation = await this.client.getCommand(run.createCommandId);
        this.assertStore(run.task.storeId);
        if (
          creation.id !== run.createCommandId ||
          creation.sessionId !== run.sessionId ||
          creation.originStoreId !== run.task.storeId ||
          creation.kind !== 'session.create'
        )
          throw Error('scheduled_identity_mismatch');
        if (creation.status === 'rejected') {
          this.data.finish(run.createCommandId, 'rejected');
          this.update(run, {
            status: 'failed',
            error: 'scheduled_creation_rejected',
            settlementVersion: 1,
          });
          return;
        }
        if (creation.status === 'applied') {
          const view = await this.client.getView(run.sessionId);
          this.assertStore(run.task.storeId);
          if (
            view.storeId !== run.task.storeId ||
            view.session.id !== run.sessionId ||
            view.session.workspaceId !== run.task.workspaceId ||
            view.session.parentSessionId !== null ||
            view.session.deletedAt !== null
          )
            throw Error('scheduled_identity_mismatch');
          this.data.finish(run.createCommandId, 'created');
        }
      }
      const command = await this.client.getCommand(run.startCommandId);
      await this.observeCommand(run, command);
    } catch (error) {
      if (run.task.storeId !== this.client.serverInfo?.storeId) return;
      this.update(run, { status: 'unknown', error: errorCode(error) });
    }
  }
  private async observeCommand(run: ScheduledTaskRun, command: Command) {
    this.assertStore(run.task.storeId);
    if (
      command.id !== run.startCommandId ||
      command.originStoreId !== run.task.storeId ||
      command.sessionId !== run.sessionId ||
      command.kind !== 'run.start' ||
      command.requestDigest !== requestDigest(run)
    )
      throw Error('scheduled_identity_mismatch');
    if (command.status === 'rejected') {
      if (run.serviceRunId) throw Error('scheduled_identity_mismatch');
      this.update(run, {
        status: 'failed',
        error: 'scheduled_command_rejected',
        settlementVersion: 1,
      });
      return;
    }
    const application = await readOrdinaryCommandApplication(this.client, command);
    if (!application?.run || application.observation) {
      this.update(run, {
        status: ['accepted', 'needs_review'].includes(command.status) ? 'waiting' : 'unknown',
      });
      return;
    }
    const actual = application.run;
    const controlledWorkId =
      actual.rootWorkCommandId ??
      (application.sourceCommandId === run.startCommandId ? run.startCommandId : undefined);
    this.assertStore(run.task.storeId);
    if (
      actual.sessionId !== run.sessionId ||
      actual.originStoreId !== run.task.storeId ||
      !controlledWorkId
    )
      throw Error('scheduled_identity_mismatch');
    let status: ScheduledTaskRunUpdate['status'] =
      actual.status === 'completed'
        ? 'completed'
        : actual.status === 'cancelled'
          ? 'cancelled'
          : actual.status === 'failed' || actual.status === 'interrupted'
            ? 'failed'
            : actual.status === 'waiting_interaction' || actual.status === 'waiting_execution'
              ? 'waiting'
              : 'running';
    if (['completed', 'failed', 'cancelled'].includes(status)) {
      // A foreground Run may finish while its tools, detached jobs or child work remain
      // unresolved. Read the exact original group before releasing the next occurrence.
      const background = await this.client.listAllBackgroundExecutions({
        workspaceId: run.task.workspaceId,
        rootSessionId: run.sessionId,
      });
      this.assertStore(run.task.storeId);
      const views: SessionView[] = [await this.client.getView(run.sessionId)];
      this.assertStore(run.task.storeId);
      const root = views[0]!;
      if (
        root.storeId !== run.task.storeId ||
        root.session.id !== run.sessionId ||
        root.session.workspaceId !== run.task.workspaceId ||
        root.session.parentSessionId !== null ||
        root.session.deletedAt !== null
      )
        throw Error('scheduled_identity_mismatch');
      let pending = false,
        unknown = false;
      const children = new Set<string>();
      for (const item of background) {
        if (
          item.execution.rootSessionId !== run.sessionId ||
          item.rootSession.id !== run.sessionId ||
          item.session.workspaceId !== run.task.workspaceId
        )
          throw Error('scheduled_identity_mismatch');
        if (
          item.execution.originStoreId !== run.task.storeId ||
          item.execution.rootWorkCommandId !== controlledWorkId
        )
          continue;
        unknown ||= item.execution.status === 'outcome_unknown';
        pending ||= ['planned', 'dispatching', 'running'].includes(item.execution.status);
        pending ||= !!item.childRun?.isActive;
        // Terminal after-turn jobs can still admit another Run in this same group.
        // Their report is registered atomically with settlement; ordinary pending
        // results have no report and must not permanently block future occurrences.
        if (item.execution.delivery === 'pending') {
          const reportId = `report-${createHash('sha256')
            .update(
              JSON.stringify([
                item.execution.originStoreId,
                item.execution.id,
                item.execution.resultRevision,
              ]),
            )
            .digest('hex')}`;
          try {
            const report = await this.client.getCommand(reportId);
            this.assertStore(run.task.storeId);
            if (
              report.id !== reportId ||
              report.kind !== 'job.report' ||
              report.originStoreId !== run.task.storeId ||
              report.sessionId !== item.execution.sessionId
            )
              throw Error('scheduled_identity_mismatch');
            // Even if this report just applied, reobserve next cycle. Its new work
            // may postdate the background snapshot read above.
            pending = true;
          } catch (error) {
            this.assertStore(run.task.storeId);
            if (
              !(error instanceof ClientError) ||
              error.status !== 404 ||
              error.code !== 'command_not_found'
            )
              throw error;
          }
        }
        if (item.childSession) children.add(item.childSession.id);
      }
      for (const childId of children) {
        const view = await this.client.getView(childId);
        this.assertStore(run.task.storeId);
        if (
          view.storeId !== run.task.storeId ||
          view.session.id !== childId ||
          view.session.rootSessionId !== run.sessionId ||
          view.session.workspaceId !== run.task.workspaceId ||
          view.session.parentSessionId === null ||
          view.session.deletedAt !== null
        )
          throw Error('scheduled_identity_mismatch');
        views.push(view);
      }
      for (const view of views) {
        // Public SessionView Runs omit root-work identity. Any active Run in the
        // exact original/linked child Session conservatively keeps settlement open,
        // including a report Run admitted before its first execution is planned.
        pending ||= view.runs.some((item) => item.isActive);
        for (const execution of view.executions) {
          if (
            execution.originStoreId !== run.task.storeId ||
            (execution.rootWorkCommandId !== controlledWorkId && execution.runId !== actual.id)
          )
            continue;
          if (execution.sessionId !== view.session.id) throw Error('scheduled_identity_mismatch');
          unknown ||= execution.status === 'outcome_unknown';
          pending ||= ['planned', 'dispatching', 'running'].includes(execution.status);
        }
      }
      if (unknown) status = 'unknown';
      else if (pending) status = 'waiting';
    }
    this.update(run, {
      status,
      serviceRunId: actual.id,
      ...(['completed', 'failed', 'cancelled'].includes(status)
        ? { settlementVersion: 1 as const }
        : {}),
      ...(actual.reason ? { error: actual.reason } : {}),
    });
  }
}
