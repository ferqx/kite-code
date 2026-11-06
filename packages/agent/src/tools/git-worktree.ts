import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  ExtensionRecord,
  Json,
  OperationRef,
  RecordDefinition,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../extensions';
import { canonicalJson } from '../json';
import {
  captureTemporaryWorktreeRoots,
  inspectTemporaryWorktreeTarget,
} from '../permissions/worktree-path-policy';
import { AgentError } from '../storage/types';
import { failureGuidance } from './git-worktree/errors';
import { notifyWorktreeCreated } from './git-worktree/notification';
import {
  buildWorkerCommand,
  decodeWorkerRequest,
  digest,
  type GitWorktreeConfiguration,
  type GitWorktreeInput,
  gitWorktreeInputSchema,
  jsonObject,
  type Mutation,
  parseGitWorktreeInput,
  type ResolvedWorktreeTarget,
  resolveDefaultWorktreeTarget,
  validateFrame,
  validatePlan,
  validateResolvedWorktreeTarget,
  type WorktreeFrame,
  type WorktreePhase,
  type WorktreePlan,
  type WorktreeRequest,
} from './git-worktree/protocol';
import { assertOriginalWorktreeJob, readWorktreeOutput } from './git-worktree/read-output';

export interface GitWorktreeHost {
  readRegisteredWorkspaceRoots(): Promise<{
    originStoreId: string;
    complete: true;
    roots: string[];
    snapshotCursor?: string;
  }>;
}
export interface GitWorktreeToolOptions {
  readonly configuration: GitWorktreeConfiguration;
  readonly worktreeHost?: GitWorktreeHost;
}
const contentType = 'application/vnd.kite.git-worktree-operation+json';
interface FrozenJobStep {
  operationKey: string;
  input: {
    command: string;
    permissions: { filesystem: 'workspace_write' | 'full_access'; network: 'none' };
  };
  inputDigest: string;
  timeoutMs: number;
  request: WorktreeRequest;
  ref?: OperationRef;
}
interface OperationRecord {
  schemaVersion: 1;
  ownerExecutionId: string;
  requestDigest: string;
  request: GitWorktreeInput;
  resolvedTarget?: ResolvedWorktreeTarget;
  configurationIdentity: string;
  acceptedAt: string;
  deadlineAt: string;
  phase:
    | 'accepted'
    | 'querying'
    | 'preparing'
    | 'prepared'
    | 'mutation_dispatching'
    | 'mutation_observing'
    | 'completed'
    | 'unresolved';
  plan?: WorktreePlan;
  planDigest?: string;
  steps: { query?: FrozenJobStep; prepare?: FrozenJobStep; mutation?: FrozenJobStep };
  stableResult?: ToolResult;
  lastObservation?: ToolResult;
  occupancy?: Json;
}
const asJson = (value: unknown) => value as Json;
export const gitWorktreeRecordDefinition: RecordDefinition = {
  contentType,
  contentVersion: 1,
  fork: { mode: 'omit' },
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion',
      'ownerExecutionId',
      'requestDigest',
      'request',
      'configurationIdentity',
      'acceptedAt',
      'deadlineAt',
      'phase',
      'steps',
    ],
    properties: {
      schemaVersion: { const: 1 },
      ownerExecutionId: { type: 'string' },
      requestDigest: { type: 'string' },
      request: gitWorktreeInputSchema,
      resolvedTarget: { type: 'object' },
      configurationIdentity: { type: 'string' },
      acceptedAt: { type: 'string' },
      deadlineAt: { type: 'string' },
      phase: {
        enum: [
          'accepted',
          'querying',
          'preparing',
          'prepared',
          'mutation_dispatching',
          'mutation_observing',
          'completed',
          'unresolved',
        ],
      },
      plan: { type: 'object' },
      planDigest: { type: 'string' },
      steps: { type: 'object' },
      stableResult: { type: 'object' },
      lastObservation: { type: 'object' },
      occupancy: { type: 'object' },
    },
  },
};
function errorCode(error: unknown): string {
  return error instanceof AgentError ? error.code : 'worktree_operation_unverifiable';
}
function makeResult(
  input: GitWorktreeInput,
  outcome: ToolResult['outcome'],
  details: Record<string, Json>,
  owner?: string,
  ref?: OperationRef,
): ToolResult {
  const full = {
    action: input.action,
    ...(input.action === 'list'
      ? {}
      : { key: input.key, ...(input.path ? { path: input.path } : {}) }),
    cwdChanged: false,
    observedAt: new Date().toISOString(),
    ...details,
    ...(owner
      ? { operation: { ownerExecutionId: owner, ...(ref ? { ref: asJson(ref) } : {}) } }
      : {}),
  };
  const instruction =
    outcome === 'outcome_unknown'
      ? ' Observe the original operation and owner Execution. Do not start a replacement operation or use another key to recover its result.'
      : outcome === 'failed'
        ? ' Inspect the stated cause and preserved operation evidence before submitting a new intent.'
        : '';
  const guidance =
    outcome === 'failed' || outcome === 'outcome_unknown'
      ? failureGuidance(details.failure, details.mutation)
      : '';
  const permission =
    outcome === 'failed' && details.code === 'permission_denied'
      ? ' This request was denied under the existing authorization or capability policy. Do not infer the user refused it or automatically expand permissions.'
      : '';
  return {
    outcome,
    content: canonicalJson(full) + instruction + guidance + permission,
    details: full,
  };
}
function replay(result: ToolResult): ToolResult {
  const details: Record<string, Json> = {
    ...(jsonObject(result.details) ? result.details : {}),
    replayed: true,
  };
  return {
    ...structuredClone(result),
    details,
    content: canonicalJson(details) + failureGuidance(details.failure, details.mutation),
  };
}
function recordValue(
  record: ExtensionRecord,
  sessionId: string,
  sourceCwd: string,
): OperationRecord {
  if (
    record.extensionId !== 'builtin.shell' ||
    record.sessionId !== sessionId ||
    record.contentType !== contentType ||
    record.contentVersion !== 1 ||
    !record.originStoreId ||
    record.forkProvenance ||
    !jsonObject(record.value)
  )
    throw new AgentError('worktree_operation_unverifiable');
  if (
    Object.keys(record.value).some(
      (key) =>
        ![
          'schemaVersion',
          'ownerExecutionId',
          'requestDigest',
          'request',
          'resolvedTarget',
          'configurationIdentity',
          'acceptedAt',
          'deadlineAt',
          'phase',
          'plan',
          'planDigest',
          'steps',
          'stableResult',
          'lastObservation',
          'occupancy',
        ].includes(key),
    )
  )
    throw new AgentError('worktree_operation_unverifiable');
  const value = record.value as unknown as OperationRecord;
  const parsedRequest = parseGitWorktreeInput(value.request);
  if (
    value.schemaVersion !== 1 ||
    typeof value.ownerExecutionId !== 'string' ||
    !value.ownerExecutionId ||
    typeof value.requestDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.requestDigest) ||
    typeof value.configurationIdentity !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.configurationIdentity) ||
    !parsedRequest ||
    canonicalJson(asJson(parsedRequest)) !== canonicalJson(asJson(value.request)) ||
    digest({ input: parsedRequest, sourceCwd }) !== value.requestDigest ||
    ![
      'accepted',
      'querying',
      'preparing',
      'prepared',
      'mutation_dispatching',
      'mutation_observing',
      'completed',
      'unresolved',
    ].includes(value.phase) ||
    !Number.isFinite(Date.parse(value.acceptedAt)) ||
    !Number.isFinite(Date.parse(value.deadlineAt)) ||
    Date.parse(value.deadlineAt) < Date.parse(value.acceptedAt) ||
    !jsonObject(value.steps) ||
    Object.keys(value.steps).some((key) => !['query', 'prepare', 'mutation'].includes(key))
  )
    throw new AgentError('worktree_operation_unverifiable');
  if (
    value.request.action === 'create' && value.request.path === undefined
      ? !validateResolvedWorktreeTarget(value.resolvedTarget) ||
        value.resolvedTarget.path !==
          resolveDefaultWorktreeTarget({
            defaultRoot: value.resolvedTarget.defaultRoot,
            sourceCwd,
            sessionId,
            key: value.request.key,
          })
      : value.resolvedTarget !== undefined
  )
    throw new AgentError('worktree_operation_unverifiable');
  if (
    (value.plan === undefined) !== (value.planDigest === undefined) ||
    (value.phase === 'prepared' && !value.plan)
  )
    throw new AgentError('worktree_operation_unverifiable');
  if (
    value.plan &&
    (!validatePlan(value.plan) ||
      value.plan.action !== value.request.action ||
      value.plan.sourceCwd !== sourceCwd ||
      digest(value.plan) !== value.planDigest)
  )
    throw new AgentError('worktree_operation_unverifiable');
  if (
    value.plan &&
    value.resolvedTarget &&
    (value.plan.targetPath !== value.resolvedTarget.path ||
      !jsonObject(value.plan.evidence) ||
      !jsonObject(value.plan.evidence.parent) ||
      value.plan.evidence.parent.defaultRoot !== value.resolvedTarget.defaultRoot)
  )
    throw new AgentError('worktree_operation_unverifiable');
  const token = digest({
    sessionId,
    executionId: value.ownerExecutionId,
    key: record.key,
    requestDigest: value.requestDigest,
  });
  for (const [kind, step] of Object.entries(value.steps as OperationRecord['steps'])) {
    if (
      !step ||
      !jsonObject(step as unknown) ||
      Object.keys(step).some(
        (field) =>
          !['operationKey', 'input', 'inputDigest', 'timeoutMs', 'request', 'ref'].includes(field),
      ) ||
      typeof step.operationKey !== 'string' ||
      digest(step.input) !== step.inputDigest ||
      !Number.isInteger(step.timeoutMs) ||
      step.timeoutMs < 1
    )
      throw new AgentError('worktree_operation_unverifiable');
    const expectedPhase =
      kind === 'query'
        ? 'list'
        : kind === 'prepare'
          ? `prepare_${value.request.action}`
          : value.request.action;
    if (
      step.request.phase !== expectedPhase ||
      step.request.operationToken !== token ||
      step.request.sourceCwd !== sourceCwd ||
      step.operationKey !== `git-worktree-${digest({ token, kind })}` ||
      (kind === 'query') !== (value.request.action === 'list') ||
      (kind === 'mutation' && (!value.plan || digest(step.request.plan) !== value.planDigest)) ||
      (kind !== 'mutation' &&
        (canonicalJson(asJson(step.request.input)) !== canonicalJson(asJson(value.request)) ||
          (value.resolvedTarget
            ? canonicalJson(asJson(step.request.resolvedTarget)) !==
              canonicalJson(asJson(value.resolvedTarget))
            : step.request.resolvedTarget !== undefined)))
    )
      throw new AgentError('worktree_operation_unverifiable');
    if (
      !jsonObject(step.input) ||
      Object.keys(step.input).some((key) => !['command', 'permissions'].includes(key)) ||
      !jsonObject(step.input.permissions) ||
      Object.keys(step.input.permissions).some((key) => !['filesystem', 'network'].includes(key)) ||
      step.input.permissions.network !== 'none' ||
      !['workspace_write', 'full_access'].includes(step.input.permissions.filesystem)
    )
      throw new AgentError('worktree_operation_unverifiable');
    // Bind the frozen request to its exact command without consulting today's host assets.
    const encoded = step.input.command.match(/ '([A-Za-z0-9_-]+)'$/)?.[1];
    if (
      !encoded ||
      canonicalJson(asJson(decodeWorkerRequest(encoded))) !== canonicalJson(asJson(step.request))
    )
      throw new AgentError('worktree_operation_unverifiable');
    if (
      step.ref &&
      (!jsonObject(step.ref as unknown) ||
        Object.keys(step.ref).some(
          (key) =>
            ![
              'childSessionId',
              'commandId',
              'sessionId',
              'originStoreId',
              'extensionId',
              'key',
              'executionId',
            ].includes(key),
        ) ||
        typeof step.ref.commandId !== 'string' ||
        typeof step.ref.executionId !== 'string' ||
        !step.ref.executionId ||
        step.ref.originStoreId !== record.originStoreId ||
        step.ref.sessionId !== sessionId ||
        step.ref.extensionId !== 'builtin.shell' ||
        step.ref.key !== step.operationKey)
    )
      throw new AgentError('worktree_operation_unverifiable');
  }
  if (value.stableResult) {
    const stable = value.stableResult;
    if (
      !jsonObject(stable as unknown) ||
      Object.keys(stable).some(
        (key) =>
          ![
            'outcome',
            'content',
            'details',
            'artifactRefs',
            'modelContent',
            'modelImages',
          ].includes(key),
      ) ||
      typeof stable.content !== 'string' ||
      stable.outcome === 'outcome_unknown' ||
      !['succeeded', 'failed', 'cancelled'].includes(stable.outcome) ||
      !jsonObject(stable.details) ||
      stable.details.mutation === 'unknown'
    )
      throw new AgentError('worktree_operation_unverifiable');
    if (stable.outcome !== 'cancelled') {
      const details = { ...stable.details };
      delete details.key;
      delete details.operation;
      delete details.replayed;
      if (
        !validateFrame(
          {
            protocolVersion: 1,
            operationToken: token,
            phase: value.request.action,
            businessOutcome: stable.outcome,
            details,
          },
          { operationToken: token, phase: value.request.action },
        )
      )
        throw new AgentError('worktree_operation_unverifiable');
    }
  }
  if (value.phase === 'completed' && !value.stableResult)
    throw new AgentError('worktree_operation_unverifiable');
  return structuredClone(value);
}
function contains(parent: string, child: string): boolean {
  const diff = relative(parent, child);
  return diff === '' || (!diff.startsWith(`..${sep}`) && diff !== '..' && !isAbsolute(diff));
}
/** One Tool; process ownership, authorization, output and cancellation stay in shell.command. */
export function createGitWorktreeTool(options: GitWorktreeToolOptions): ToolDefinition {
  const configuration = Object.freeze(structuredClone(options.configuration));
  const configurationIdentity = digest(configuration);
  async function invoke(raw: Json, context: ToolContext, resuming: boolean): Promise<ToolResult> {
    const parsedInput = parseGitWorktreeInput(raw);
    if (!parsedInput)
      return {
        outcome: 'failed',
        content:
          'invalid_worktree_arguments: Supply only fields for list, create or remove. No Git operation was started.',
        details: { code: 'invalid_worktree_arguments', mutation: 'not_started', cwdChanged: false },
      };
    const input: GitWorktreeInput = parsedInput;
    const key =
      input.action === 'list'
        ? `git-worktree/list/${context.executionId}`
        : `git-worktree/${input.key}`;
    const requestDigest = digest({ input, sourceCwd: configuration.sourceCwd });
    let saved: ExtensionRecord | null = null;
    let value: OperationRecord | undefined;
    let created = false;
    async function persist(next: OperationRecord): Promise<void> {
      saved = await context.records.write({
        key,
        expectedRevision: saved?.revision ?? null,
        executable: true,
        contentType,
        contentVersion: 1,
        value: asJson(next),
      });
      value = structuredClone(next);
    }
    function withParentNotification(
      result: ToolResult,
      notification: Awaited<ReturnType<typeof notifyWorktreeCreated>>,
    ): ToolResult {
      if (notification.status === 'not_applicable') return result;
      const details = {
        ...(jsonObject(result.details) ? result.details : {}),
        parentNotification: asJson(notification),
      };
      return {
        ...result,
        details,
        content:
          canonicalJson(details) +
          (notification.status === 'queued'
            ? ''
            : ' Worktree creation is complete. Parent notification was not confirmed. Use the existing agent message flow to report the saved result; do not repeat Git creation.'),
      };
    }
    async function notifyCreated(result: ToolResult, original = result): Promise<ToolResult> {
      return withParentNotification(result, await notifyWorktreeCreated(context, original));
    }
    async function finish(result: ToolResult, stable: boolean): Promise<ToolResult> {
      // A different Execution may observe original Job evidence, but must not race the
      // owner's frozen-step CAS or take over its stable receipt and notification identity.
      if (value!.ownerExecutionId !== context.executionId) return result;
      const next = {
        ...value!,
        phase: stable ? ('completed' as const) : ('unresolved' as const),
        ...(stable ? { stableResult: result } : { lastObservation: result }),
      };
      try {
        await persist(next);
      } catch {
        /* Original immutable Job evidence remains authoritative. */
        if (stable && input.action === 'create' && result.outcome === 'succeeded')
          return withParentNotification(result, {
            status: 'failed',
            accepted: false,
            code: 'worktree_notification_unavailable',
          });
        return result;
      }
      return stable ? notifyCreated(result) : result;
    }
    function unknown(code: string, ref?: OperationRef): ToolResult {
      return makeResult(
        input!,
        'outcome_unknown',
        {
          code,
          mutation: value?.steps.mutation ? 'unknown' : 'not_started',
          ...(value?.resolvedTarget ? { path: value.resolvedTarget.path } : {}),
        },
        value?.ownerExecutionId,
        ref,
      );
    }
    try {
      saved = await context.records.get(key);
      if (!saved) {
        if (configuration.unavailable)
          return makeResult(input, 'failed', {
            code: configuration.unavailable,
            mutation: 'not_started',
          });
        context.signal.throwIfAborted();
        let resolvedTarget: ResolvedWorktreeTarget | undefined;
        if (input.action === 'create') {
          if (input.path === undefined) {
            if (!configuration.defaultRoot || !isAbsolute(configuration.defaultRoot))
              throw new AgentError('worktree_default_root_unavailable');
            resolvedTarget = {
              defaultRoot: resolve(configuration.defaultRoot),
              path: resolveDefaultWorktreeTarget({
                defaultRoot: configuration.defaultRoot,
                sourceCwd: configuration.sourceCwd,
                sessionId: context.sessionId,
                key: input.key,
              }),
            };
          }
          const temporaryRoots = await captureTemporaryWorktreeRoots({
            platform: process.platform,
            temporaryDirectory: tmpdir(),
            environment: process.env,
          });
          if (
            await inspectTemporaryWorktreeTarget(input.path ?? resolvedTarget!.path, temporaryRoots)
          )
            throw new AgentError('temporary_worktree_target');
          context.signal.throwIfAborted();
        }
        const acceptedAt = new Date().toISOString();
        const initial: OperationRecord = {
          schemaVersion: 1,
          ownerExecutionId: context.executionId,
          requestDigest,
          request: input,
          ...(resolvedTarget ? { resolvedTarget } : {}),
          configurationIdentity,
          acceptedAt,
          deadlineAt: new Date(
            Date.parse(acceptedAt) + (input.action === 'list' ? 15000 : input.timeoutMs),
          ).toISOString(),
          phase: 'accepted',
          steps: {},
        };
        try {
          await persist(initial);
          created = true;
        } catch (error) {
          if (errorCode(error) !== 'record_revision_conflict') throw error;
          saved = await context.records.get(key);
          if (!saved) throw new AgentError('worktree_operation_unverifiable');
        }
      }
      value = recordValue(saved!, context.sessionId, configuration.sourceCwd);
      if (value.requestDigest !== requestDigest)
        return makeResult(
          input,
          'failed',
          { code: 'worktree_intent_conflict', mutation: 'not_started' },
          value.ownerExecutionId,
        );
      const ownExecution = await context.getExecution(context.executionId);
      if (!ownExecution || ownExecution.originStoreId !== saved!.originStoreId)
        return unknown('worktree_operation_unverifiable');
      if (value.stableResult) return notifyCreated(replay(value.stableResult), value.stableResult);
      const mayDispatch =
        value.ownerExecutionId === context.executionId &&
        (created || resuming) &&
        value.configurationIdentity === configurationIdentity &&
        !configuration.unavailable;
      const token = digest({
        sessionId: context.sessionId,
        executionId: value.ownerExecutionId,
        key,
        requestDigest,
      });
      async function freezeStep(
        kind: 'query' | 'prepare' | 'mutation',
        phase: WorktreePhase,
      ): Promise<FrozenJobStep | null> {
        const existing = value!.steps[kind];
        if (existing) return existing;
        if (!mayDispatch) return null;
        context.signal.throwIfAborted();
        const remaining = Date.parse(value!.deadlineAt) - Date.now();
        if (remaining <= 0) throw new AgentError('worktree_timeout');
        const request: WorktreeRequest = {
          schemaVersion: 1,
          configurationId: configuration.configurationId,
          operationToken: token,
          phase,
          sourceCwd: configuration.sourceCwd,
          git: configuration.git,
          hooksPath: configuration.hooksPath,
          ...(kind === 'mutation'
            ? { plan: value!.plan!, planDigest: value!.planDigest! }
            : {
                input,
                ...(value!.resolvedTarget ? { resolvedTarget: value!.resolvedTarget } : {}),
              }),
        };
        const command = buildWorkerCommand(configuration, request);
        const jobInput = {
          command,
          permissions:
            input.action === 'list'
              ? { filesystem: 'workspace_write' as const, network: 'none' as const }
              : input.permissions,
        };
        const step: FrozenJobStep = {
          operationKey: `git-worktree-${digest({ token, kind })}`,
          input: jobInput,
          inputDigest: digest(jobInput),
          timeoutMs: Math.max(1, Math.floor(remaining)),
          request,
        };
        await persist({
          ...value!,
          phase:
            kind === 'query'
              ? 'querying'
              : kind === 'prepare'
                ? 'preparing'
                : 'mutation_dispatching',
          steps: { ...value!.steps, [kind]: step },
        });
        return step;
      }
      async function observe(
        kind: 'query' | 'prepare' | 'mutation',
        phase: WorktreePhase,
      ): Promise<{ frame: WorktreeFrame | null; result?: ToolResult } | null> {
        let step = await freezeStep(kind, phase);
        if (!step) return null;
        if (!step.ref) {
          if (!mayDispatch) return null;
          if (Date.now() >= Date.parse(value!.deadlineAt))
            return { frame: null, result: unknown('worktree_timeout') };
          context.signal.throwIfAborted();
          const ref = await context.operations.ensure({
            key: step.operationKey,
            request: {
              kind: 'job',
              definitionId: 'shell.command',
              definitionVersion: '1',
              input: step.input,
            },
            planRecordKey: key,
            cancellation: 'attached',
          });
          step = { ...step, ref };
          await persist({
            ...value!,
            phase: kind === 'mutation' ? 'mutation_observing' : value!.phase,
            steps: { ...value!.steps, [kind]: step },
          });
        }
        const ref = step.ref!;
        let cancelledAt: number | undefined;
        for (;;) {
          const execution = await context.operations.get(ref);
          assertOriginalWorktreeJob(ref, context, execution);
          if (execution.parentExecutionId !== value!.ownerExecutionId)
            throw new AgentError('worktree_operation_unverifiable');
          if (['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status))
            break;
          if (Date.now() >= Date.parse(value!.deadlineAt) && cancelledAt === undefined) {
            if (!context.operations.cancel)
              return { frame: null, result: unknown('worktree_cancellation_unconfirmed', ref) };
            await context.operations.cancel(ref, {
              commandId: `git_worktree_timeout_${digest(ref)}`,
            });
            cancelledAt = Date.now();
          }
          if (context.signal.aborted || cancelledAt !== undefined) {
            cancelledAt ??= Date.now();
            if (Date.now() - cancelledAt > 30000)
              return { frame: null, result: unknown('worktree_cancellation_unconfirmed', ref) };
            // Attached cancellation belongs to Runtime. Continue only pure original-ref observation.
            await new Promise((resolve) => setTimeout(resolve, 25));
            continue;
          }
          try {
            await context.operations.wait(ref, {
              signal: context.signal,
              timeoutMs: Math.min(1000, Math.max(1, Date.parse(value!.deadlineAt) - Date.now())),
            });
          } catch (error) {
            if (!context.signal.aborted && errorCode(error) !== 'wait_timeout') throw error;
          }
        }
        const observed = await readWorktreeOutput(ref, context, step.request);
        if (observed.frame) return { frame: observed.frame };
        const status = observed.execution.status;
        const notStarted =
          kind !== 'mutation' || observed.execution.authorization?.dispatched === false;
        const outcome =
          status === 'cancelled'
            ? 'cancelled'
            : notStarted && status === 'failed'
              ? 'failed'
              : 'outcome_unknown';
        const mutation: Mutation = notStarted ? 'not_started' : 'unknown';
        return {
          frame: null,
          result: makeResult(
            input,
            outcome,
            {
              code:
                status === 'cancelled' ? 'worktree_cancelled' : 'worktree_operation_unverifiable',
              mutation,
            },
            value!.ownerExecutionId,
            ref,
          ),
        };
      }
      function frameResult(
        frame: WorktreeFrame,
        kind: 'query' | 'prepare' | 'mutation',
      ): ToolResult {
        const outcome = frame.businessOutcome === 'failed' ? 'failed' : 'succeeded';
        return makeResult(
          input!,
          outcome,
          frame.details,
          value!.ownerExecutionId,
          value!.steps[kind]?.ref,
        );
      }
      if (input.action === 'list') {
        const observation = await observe('query', 'list');
        if (!observation) return finish(unknown('worktree_operation_unverifiable'), false);
        const result = observation.result ?? frameResult(observation.frame!, 'query');
        return finish(result, result.outcome !== 'outcome_unknown');
      }
      // A mutation ref always takes precedence over preparation, deadlines, and new occupancy facts.
      if (!value.steps.mutation) {
        const preparation = await observe(
          'prepare',
          input.action === 'create' ? 'prepare_create' : 'prepare_remove',
        );
        if (!preparation) return finish(unknown('worktree_operation_unverifiable'), false);
        if (preparation.result)
          return finish(preparation.result, preparation.result.outcome === 'failed');
        const frame = preparation.frame!;
        if (frame.businessOutcome === 'failed') return finish(frameResult(frame, 'prepare'), true);
        if (frame.businessOutcome !== 'prepared' || !frame.plan || !frame.planDigest)
          throw new AgentError('worktree_protocol_error');
        if (
          value.resolvedTarget &&
          (frame.plan.targetPath !== value.resolvedTarget.path ||
            !jsonObject(frame.plan.evidence) ||
            !jsonObject(frame.plan.evidence.parent) ||
            frame.plan.evidence.parent.defaultRoot !== value.resolvedTarget.defaultRoot)
        )
          throw new AgentError('worktree_protocol_error');
        if (!mayDispatch) return finish(unknown('worktree_operation_unverifiable'), false);
        await persist({
          ...value,
          plan: frame.plan,
          planDigest: frame.planDigest,
          phase: 'prepared',
        });
        context.signal.throwIfAborted();
        if (input.action === 'remove') {
          if (!context.runId || !context.readRunExecutionSafety || !options.worktreeHost)
            return finish(
              makeResult(
                input,
                'failed',
                { code: 'worktree_occupancy_unavailable', mutation: 'not_started' },
                value!.ownerExecutionId,
              ),
              true,
            );
          let occupancy: Awaited<ReturnType<GitWorktreeHost['readRegisteredWorkspaceRoots']>>;
          try {
            const safety = await context.readRunExecutionSafety(context.runId);
            if (
              safety.originStoreId !== saved!.originStoreId ||
              safety.sessionId !== context.sessionId ||
              safety.runId !== context.runId ||
              safety.excludedExecutionId !== context.executionId
            )
              throw new AgentError('worktree_occupancy_unavailable');
            if (safety.unconfirmed !== false)
              return finish(
                makeResult(
                  input,
                  'failed',
                  { code: 'worktree_busy', mutation: 'not_started' },
                  value!.ownerExecutionId,
                ),
                true,
              );
            occupancy = await options.worktreeHost.readRegisteredWorkspaceRoots();
            if (
              occupancy.originStoreId !== saved!.originStoreId ||
              occupancy.complete !== true ||
              !Array.isArray(occupancy.roots) ||
              !occupancy.roots.every(
                (root) => typeof root === 'string' && isAbsolute(root) && resolve(root) === root,
              )
            )
              throw new AgentError('worktree_occupancy_unavailable');
            await persist({ ...value!, occupancy: asJson({ ...occupancy, safety }) });
          } catch {
            return finish(
              makeResult(
                input,
                'failed',
                { code: 'worktree_occupancy_unavailable', mutation: 'not_started' },
                value!.ownerExecutionId,
              ),
              true,
            );
          }
          if (occupancy.roots.some((root) => contains(value!.plan!.targetPath, root)))
            return finish(
              makeResult(
                input,
                'failed',
                { code: 'worktree_registered_workspace', mutation: 'not_started' },
                value!.ownerExecutionId,
              ),
              true,
            );
        }
      }
      const mutation = await observe('mutation', input.action);
      if (!mutation) return finish(unknown('worktree_operation_unverifiable'), false);
      const result = mutation.result ?? frameResult(mutation.frame!, 'mutation');
      const details = jsonObject(result.details) ? result.details : {};
      return finish(result, result.outcome !== 'outcome_unknown' && details.mutation !== 'unknown');
    } catch (error) {
      const code = errorCode(error);
      const ref =
        value?.steps.mutation?.ref ?? value?.steps.prepare?.ref ?? value?.steps.query?.ref;
      if (value) {
        const possibleEffect = !!value.steps.mutation;
        // A storage/ensure boundary failure cannot certify the original operation was never accepted.
        // Keep the owner record resumable even when the only accepted phase was preparation.
        const preparationCompleted =
          value.phase === 'prepared' &&
          value.plan !== undefined &&
          value.planDigest !== undefined &&
          value.steps.prepare?.ref !== undefined &&
          value.steps.mutation === undefined;
        const knownTimeout =
          code === 'worktree_timeout' &&
          (Object.keys(value.steps).length === 0 || preparationCompleted);
        const result = makeResult(
          input,
          knownTimeout ? 'failed' : 'outcome_unknown',
          {
            code,
            mutation: possibleEffect ? 'unknown' : 'not_started',
          },
          value.ownerExecutionId,
          ref,
        );
        return finish(result, knownTimeout);
      }
      return makeResult(input, 'failed', { code, mutation: 'not_started' });
    }
  }
  return {
    id: 'git.worktree',
    version: '1',
    model: { name: 'git_worktree' },
    description:
      'List registered Git worktrees, create a worktree from a frozen commit, or remove a protected clean linked worktree. To list, send exactly {"action":"list"}; no key, path, baseRef, newBranch, timeoutMs or permissions. create requires key; omit path for a stable persistent target under ~/.kite-code/worktrees, or supply an absolute path. Temporary create targets are refused. remove requires key and absolute path and forbids baseRef/newBranch. Invalid argument combinations start no Git Job; correct the fields without requesting broader permissions. create defaults to detached at the source checkout HEAD; newBranch creates a new local branch. Creation returns the real path and never changes Session cwd. Reuse the same key only to observe the original intent; changed arguments conflict and unknown operations must not be restarted. Removal refuses local content, unprotected HEAD/reflog commits, links, mounts, registered Workspaces and uncertain occupancy; it preserves branches and tags.',
    inputSchema: gitWorktreeInputSchema as ToolDefinition['inputSchema'],
    recovery: { version: '1' },
    execute: (input, context) => invoke(input, context, false),
    resume: (input, context) => invoke(input, context, true),
  };
}
