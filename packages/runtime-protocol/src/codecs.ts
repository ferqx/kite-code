import {
  RUNTIME_TOOL_DISPLAY_NAMES_,
  RUNTIME_TOOL_PRESENTATIONS_,
  sameRuntimeClientInteractionIdentity,
} from '@kite-ai/runtime-contract';
import { z } from 'zod';
import {
  assertProtocolJsonValue,
  RUNTIME_PROTOCOL_LIMITS,
  RUNTIME_PROTOCOL_SCHEMA,
  RUNTIME_PROTOCOL_VERSION,
} from './limits';

const noForbiddenControls = (value: string) =>
  ![...value].some(
    (character) =>
      /\p{Cc}/u.test(character) && character !== '\n' && character !== '\r' && character !== '\t',
  );
const identifier = z
  .string()
  .min(1)
  .max(RUNTIME_PROTOCOL_LIMITS.maxIdentifierLength)
  .refine((value) => !/\p{Cc}/u.test(value));
const rpcId = z
  .string()
  .min(1)
  .max(RUNTIME_PROTOCOL_LIMITS.maxRpcIdLength)
  .refine((value) => !/\p{Cc}/u.test(value));
const safeRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const shortText = z.string().max(8_192).refine(noForbiddenControls);
const approvalCommand = z.string().max(16_384).refine(noForbiddenControls);
const runtimeToolDisplayName = z.enum(RUNTIME_TOOL_DISPLAY_NAMES_);
const runtimeToolPresentation = z.enum(RUNTIME_TOOL_PRESENTATIONS_);
const displayLabel = z.string().min(1).max(512).refine(noForbiddenControls);
const inputText = z
  .string()
  .min(1)
  .max(RUNTIME_PROTOCOL_LIMITS.maxTextLength)
  .refine(noForbiddenControls);
const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.boolean(),
    z.null(),
    z.number().finite(),
    z.array(jsonValue).max(RUNTIME_PROTOCOL_LIMITS.maxArrayLength),
    z.record(z.string(), jsonValue),
  ]),
);
const jsonRecord = z
  .unknown()
  .superRefine((value, context) => {
    try {
      assertProtocolJsonValue(value);
    } catch (error) {
      context.addIssue({ code: 'custom', message: (error as Error).message });
    }
  })
  .pipe(z.record(z.string(), jsonValue));
const safeInteger = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const outputText = z
  .string()
  .max(RUNTIME_PROTOCOL_LIMITS.maxTextLength)
  .refine(noForbiddenControls);
const toolResult = z
  .object({
    ok: z.boolean(),
    exitCode: safeInteger,
    stdout: outputText,
    stderr: outputText,
    status: z.enum(['success', 'error', 'exhausted']).optional(),
    totalLines: safeRevision.optional(),
    toolTokenCount: safeRevision.optional(),
    terminationReason: z.enum(['timed_out', 'cancelled', 'sandbox_denied']).optional(),
  })
  .strict();
const subagentToolResult = z.object({ ok: z.boolean() }).strict();

const interactionBase = {
  interactionId: identifier,
  sessionRevision: safeRevision,
  title: shortText.optional(),
  summary: shortText.optional(),
};
const interaction = z.discriminatedUnion('kind', [
  z
    .object({
      ...interactionBase,
      kind: z.literal('approval'),
      generation: safeRevision,
      grants: z
        .array(z.enum(['approve_once', 'same_command']))
        .min(1)
        .max(2),
      command: approvalCommand.optional(),
    })
    .strict(),
  z
    .object({
      ...interactionBase,
      kind: z.literal('input'),
      question: inputText,
      allowFreeText: z.boolean(),
      options: z
        .array(
          z
            .object({ id: identifier, label: shortText, description: shortText.optional() })
            .strict(),
        )
        .max(256)
        .optional(),
    })
    .strict(),
  z
    .object({
      ...interactionBase,
      kind: z.literal('plan_review'),
      plan: z
        .object({ planId: identifier, version: safeRevision.min(1), structuralDigest: identifier })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...interactionBase,
      kind: z.literal('provider_action'),
      provider: z
        .object({ providerId: identifier, directoryRevision: identifier.optional() })
        .strict(),
      action: z.enum(['login', 'approve', 'retry']),
    })
    .strict(),
  z
    .object({
      ...interactionBase,
      kind: z.literal('verification'),
      verification: z.object({ verificationId: identifier, revision: identifier }).strict(),
    })
    .strict(),
]);
export type RuntimeProtocolInteraction = z.infer<typeof interaction>;

const textResponse = z.object({ kind: z.literal('text'), value: inputText }).strict();
const inputCancelResponse = z.object({ kind: z.literal('input_cancel') }).strict();
const approvalResponse = z
  .object({
    kind: z.literal('approval'),
    decision: z.enum(['approve_once', 'same_command', 'reject']),
  })
  .strict();
const planReviewResponse = z
  .object({
    kind: z.literal('plan_review'),
    decision: z.enum(['auto', 'accept_edits', 'feedback', 'cancel']),
    feedback: shortText.optional(),
  })
  .strict();
const providerActionResponse = z
  .object({
    kind: z.literal('provider_action'),
    outcome: z.enum(['completed', 'deferred', 'cancelled']),
    detail: shortText.optional(),
  })
  .strict();
const verificationResponse = z
  .object({
    kind: z.literal('verification'),
    decision: z.enum(['replan', 'waive', 'compensate']),
    detail: shortText,
  })
  .strict();

const commandBase = { schema: z.literal('kite.runtime-command.v1'), commandId: identifier };
const sessionCommandBase = {
  ...commandBase,
  sessionId: identifier,
  expectedRevision: safeRevision,
};
const respondInteractionCommands = z
  .union([
    z
      .object({
        ...sessionCommandBase,
        type: z.literal('respond_interaction'),
        interaction: interaction.options[1],
        response: textResponse,
      })
      .strict(),
    z
      .object({
        ...sessionCommandBase,
        type: z.literal('respond_interaction'),
        interaction: interaction.options[1],
        response: inputCancelResponse,
      })
      .strict(),
    z
      .object({
        ...sessionCommandBase,
        type: z.literal('respond_interaction'),
        interaction: interaction.options[0],
        response: approvalResponse,
      })
      .strict(),
    z
      .object({
        ...sessionCommandBase,
        type: z.literal('respond_interaction'),
        interaction: interaction.options[2],
        response: planReviewResponse,
      })
      .strict(),
    z
      .object({
        ...sessionCommandBase,
        type: z.literal('respond_interaction'),
        interaction: interaction.options[3],
        response: providerActionResponse,
      })
      .strict(),
    z
      .object({
        ...sessionCommandBase,
        type: z.literal('respond_interaction'),
        interaction: interaction.options[4],
        response: verificationResponse,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.interaction.sessionRevision !== value.expectedRevision) {
      context.addIssue({
        code: 'custom',
        message: 'interaction revision must match the command revision',
      });
    }
  });

/** The intentionally frozen remote command vocabulary. */
export const RUNTIME_PROTOCOL_COMMAND_SCHEMA_ = z.union([
  z
    .object({
      ...commandBase,
      type: z.literal('create_session'),
      bootstrapSessionId: identifier.optional(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal('resume_session'),
      sessionId: identifier,
      afterRevision: safeRevision.optional(),
    })
    .strict(),
  z
    .object({
      ...sessionCommandBase,
      type: z.literal('start_turn'),
      input: inputText,
      phase: z.enum(['planning', 'building']).optional(),
      initialSkills: z
        .array(z.object({ skillId: identifier, input: jsonRecord }).strict())
        .max(64)
        .optional(),
    })
    .strict(),
  z
    .object({
      ...sessionCommandBase,
      type: z.literal('cancel_turn'),
      turnId: identifier,
      runId: identifier.optional(),
    })
    .strict(),
  respondInteractionCommands,
  z
    .object({
      ...sessionCommandBase,
      type: z.literal('set_interaction_mode'),
      mode: z.enum(['accept_edits', 'auto', 'full']),
    })
    .strict(),
  z
    .object({
      ...sessionCommandBase,
      type: z.literal('compact_session'),
      mode: z.enum(['manual', 'reset']),
      instructions: shortText.optional(),
    })
    .strict(),
  z
    .object({
      ...sessionCommandBase,
      type: z.literal('rewind_session'),
      checkpointId: identifier,
      scope: z.enum(['conversation_only', 'conversation_and_workspace', 'code_only']),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal('fork_session'),
      sourceSessionId: identifier,
      sourceRevision: safeRevision,
      checkpointId: identifier.optional(),
    })
    .strict(),
  z.object({ ...sessionCommandBase, type: z.literal('close_session') }).strict(),
  z.object({ ...sessionCommandBase, type: z.literal('clear_session_command_grants') }).strict(),
  z.object({ ...sessionCommandBase, type: z.literal('delete_session') }).strict(),
]);
export type RuntimeProtocolCommand = z.infer<typeof RUNTIME_PROTOCOL_COMMAND_SCHEMA_>;

export const RUNTIME_PROTOCOL_QUERY_SCHEMA_ = z.discriminatedUnion('type', [
  z
    .object({ schema: z.literal('kite.runtime-query.v1'), type: z.literal('list_sessions') })
    .strict(),
  z
    .object({
      schema: z.literal('kite.runtime-query.v1'),
      type: z.literal('get_session_projection'),
      sessionId: identifier,
    })
    .strict(),
  z
    .object({
      schema: z.literal('kite.runtime-query.v1'),
      type: z.literal('get_context_status'),
      sessionId: identifier,
    })
    .strict(),
  z
    .object({
      schema: z.literal('kite.runtime-query.v1'),
      type: z.literal('list_checkpoints'),
      sessionId: identifier,
    })
    .strict(),
  z
    .object({
      schema: z.literal('kite.runtime-query.v1'),
      type: z.literal('get_rewind_preview'),
      sessionId: identifier,
      checkpointId: identifier,
    })
    .strict(),
  z
    .object({
      schema: z.literal('kite.runtime-query.v1'),
      type: z.literal('get_run'),
      sessionId: identifier,
      runId: identifier,
    })
    .strict(),
  z
    .object({
      schema: z.literal('kite.runtime-query.v1'),
      type: z.literal('list_runs'),
      sessionId: identifier,
      status: z
        .enum(['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'unknown'])
        .optional(),
      phase: z.enum(['planning', 'building']).optional(),
      cursor: z.object({ createdRevision: safeRevision, runId: identifier }).strict().optional(),
      limit: safeRevision.min(1).max(200),
    })
    .strict(),
]);
export type RuntimeProtocolQuery = z.infer<typeof RUNTIME_PROTOCOL_QUERY_SCHEMA_>;
export const RUNTIME_SUBSCRIPTION_SPEC_SCHEMA_ = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal('session'),
      sessionId: identifier,
      afterRevision: safeRevision.optional(),
      includeEphemeral: z.boolean().optional(),
    })
    .strict(),
  z.object({ scope: z.literal('sessions') }).strict(),
]);
export type RuntimeSubscriptionSpec = z.infer<typeof RUNTIME_SUBSCRIPTION_SPEC_SCHEMA_>;

const clientInfo = z
  .object({
    name: z.string().min(1).max(128),
    version: z.string().min(1).max(128),
    instanceId: identifier,
  })
  .strict();
export const INITIALIZE_PARAMS_SCHEMA_ = z
  .object({ protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION), clientInfo })
  .strict();
export type InitializeParams = z.infer<typeof INITIALIZE_PARAMS_SCHEMA_>;
export const RUNTIME_PROTOCOL_METHOD_SCHEMA_ = z.enum([
  'initialize',
  'runtime/command',
  'runtime/query',
  'runtime/subscribe',
  'runtime/unsubscribe',
  'history/list_sessions',
  'history/list_events',
  'history/load_session',
  'app/workspace_trust/query',
  'app/workspace_trust/decide',
  'app/provider_model/snapshot',
  'app/provider_model/select',
  'app/mcp/snapshot',
  'app/mcp/action',
  'app/skills/catalog',
  'app/execution/status',
  'app/release/status',
  'app/provider_credential/write',
  'server/status',
  'server/shutdown',
  'server/ping',
]);
export type RuntimeProtocolMethod = z.infer<typeof RUNTIME_PROTOCOL_METHOD_SCHEMA_>;

export const RUNTIME_PROTOCOL_APP_CONTROL_METHOD_SCHEMA_ = z.enum([
  'app/workspace_trust/query',
  'app/workspace_trust/decide',
  'app/provider_model/snapshot',
  'app/provider_model/select',
  'app/mcp/snapshot',
  'app/mcp/action',
  'app/skills/catalog',
  'app/execution/status',
  'app/release/status',
]);
export type RuntimeProtocolAppControlMethod = z.infer<
  typeof RUNTIME_PROTOCOL_APP_CONTROL_METHOD_SCHEMA_
>;
export const RUNTIME_PROTOCOL_APP_METHOD_SCHEMA_ = z.enum([
  ...RUNTIME_PROTOCOL_APP_CONTROL_METHOD_SCHEMA_.options,
  'app/provider_credential/write',
]);
export type RuntimeProtocolAppMethod = z.infer<typeof RUNTIME_PROTOCOL_APP_METHOD_SCHEMA_>;
export const RUNTIME_PROTOCOL_SERVER_CONTROL_METHOD_SCHEMA_ = z.enum([
  'server/status',
  'server/shutdown',
]);
export type RuntimeProtocolServerControlMethod = z.infer<
  typeof RUNTIME_PROTOCOL_SERVER_CONTROL_METHOD_SCHEMA_
>;
const requestBase = { jsonrpc: z.literal('2.0'), id: rpcId };
export const RUNTIME_PROTOCOL_REQUEST_SCHEMA_ = z.discriminatedUnion('method', [
  z
    .object({ ...requestBase, method: z.literal('initialize'), params: INITIALIZE_PARAMS_SCHEMA_ })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('runtime/command'),
      params: z.object({ command: RUNTIME_PROTOCOL_COMMAND_SCHEMA_ }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('history/list_sessions'),
      params: z
        .object({
          request: z
            .object({
              cursor: z
                .object({ updatedAt: safeRevision, sessionId: identifier })
                .strict()
                .optional(),
              limit: safeRevision.min(1).max(100),
              query: shortText.max(256).optional(),
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('history/list_events'),
      params: z
        .object({
          request: z
            .object({
              sessionId: identifier,
              afterSequence: safeRevision.optional(),
              beforeSequence: safeRevision.optional(),
              direction: z.enum(['forward', 'backward']),
              limit: safeRevision.min(1).max(200),
              eventTypes: z.array(shortText.min(1).max(160)).max(256).optional(),
            })
            .strict()
            .refine(
              (value) =>
                value.afterSequence === undefined ||
                value.beforeSequence === undefined ||
                value.afterSequence < value.beforeSequence,
            ),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('history/load_session'),
      params: z.object({ sessionId: identifier }).strict(),
    })
    .strict(),
  ...RUNTIME_PROTOCOL_APP_CONTROL_METHOD_SCHEMA_.options.map((method) =>
    z
      .object({
        ...requestBase,
        method: z.literal(method),
        params: z.object({ request: jsonRecord }).strict(),
      })
      .strict(),
  ),
  z
    .object({
      ...requestBase,
      method: z.literal('app/provider_credential/write'),
      params: z.object({ request: jsonRecord }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('runtime/query'),
      params: z.object({ query: RUNTIME_PROTOCOL_QUERY_SCHEMA_ }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('runtime/subscribe'),
      params: z.object({ subscription: RUNTIME_SUBSCRIPTION_SPEC_SCHEMA_ }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('runtime/unsubscribe'),
      params: z.object({ subscriptionId: identifier }).strict(),
    })
    .strict(),
  z
    .object({ ...requestBase, method: z.literal('server/ping'), params: z.object({}).strict() })
    .strict(),
  ...RUNTIME_PROTOCOL_SERVER_CONTROL_METHOD_SCHEMA_.options.map((method) =>
    z
      .object({
        ...requestBase,
        method: z.literal(method),
        params: z.object({ request: jsonRecord }).strict(),
      })
      .strict(),
  ),
]);
export type RuntimeProtocolRequest = z.infer<typeof RUNTIME_PROTOCOL_REQUEST_SCHEMA_>;

export const RUNTIME_PROTOCOL_ERROR_NUMBERS = Object.freeze({
  parse_error: -32700,
  invalid_request: -32600,
  method_not_found: -32601,
  invalid_params: -32602,
  internal_error: -32603,
  overloaded: -32001,
  not_initialized: -32002,
  already_initialized: -32003,
  protocol_version_mismatch: -32004,
  unauthorized: -32005,
  subscription_unavailable: -32006,
  resync_required: -32007,
} as const);
export const RUNTIME_PROTOCOL_ERROR_CODE_SCHEMA_ = z.enum([
  'parse_error',
  'invalid_request',
  'method_not_found',
  'invalid_params',
  'internal_error',
  'overloaded',
  'not_initialized',
  'already_initialized',
  'protocol_version_mismatch',
  'unauthorized',
  'subscription_unavailable',
  'resync_required',
]);
export type RuntimeProtocolErrorCode = z.infer<typeof RUNTIME_PROTOCOL_ERROR_CODE_SCHEMA_>;
export const RUNTIME_PROTOCOL_ERROR_SCHEMA_ = z
  .object({
    code: z.union([
      z.literal(-32700),
      z.literal(-32600),
      z.literal(-32601),
      z.literal(-32602),
      z.literal(-32603),
      z.literal(-32001),
      z.literal(-32002),
      z.literal(-32003),
      z.literal(-32004),
      z.literal(-32005),
      z.literal(-32006),
      z.literal(-32007),
    ]),
    message: z.string().min(1).max(256),
    data: z
      .object({ code: RUNTIME_PROTOCOL_ERROR_CODE_SCHEMA_, retryable: z.boolean().optional() })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (RUNTIME_PROTOCOL_ERROR_NUMBERS[value.data.code] !== value.code)
      context.addIssue({
        code: 'custom',
        message: 'JSON-RPC error number does not match its stable code',
        path: ['code'],
      });
  });
export type RuntimeProtocolError = z.infer<typeof RUNTIME_PROTOCOL_ERROR_SCHEMA_>;

const evidenceSummary = z
  .object({
    kind: shortText,
    status: z.enum(['pending', 'accepted', 'rejected', 'unavailable']),
    digest: identifier.optional(),
  })
  .strict();
const activeTurn = z
  .object({
    turnId: identifier,
    status: z.enum(['queued', 'running', 'waiting', 'completed', 'cancelled', 'failed']),
    summary: shortText.optional(),
    interaction: interaction.optional(),
    evidence: z.array(evidenceSummary).max(256).optional(),
  })
  .strict();
const activeWork = z
  .object({
    workId: identifier,
    phase: z.enum(['planning', 'building']),
    status: z.enum(['queued', 'running', 'waiting', 'completed', 'cancelled', 'failed']),
    title: shortText.optional(),
    activeTurn: activeTurn.optional(),
  })
  .strict();
const interactionQueue = z
  .object({
    revision: safeRevision,
    activeInteractionId: identifier.optional(),
    interactions: z.array(interaction).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.interactions.map((entry) => entry.interactionId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'interaction queue identities must be unique' });
    }
    if (value.activeInteractionId !== undefined && !ids.includes(value.activeInteractionId)) {
      context.addIssue({
        code: 'custom',
        message: 'active interaction must exist in the interaction queue',
      });
    }
    if (value.interactions.some((entry) => entry.sessionRevision !== value.revision)) {
      context.addIssue({
        code: 'custom',
        message: 'interaction revisions must match the interaction queue revision',
      });
    }
  });
export const RUNTIME_PROTOCOL_SESSION_SCHEMA_ = z
  .object({
    schema: z.literal('kite.runtime-projection.v1'),
    sessionId: identifier,
    revision: safeRevision,
    displayName: z.string().max(256).optional(),
    updatedAt: z.string().max(128).optional(),
    lifecycle: z.enum(['open', 'closed', 'unavailable']),
    model: z
      .object({
        provider: shortText,
        name: shortText,
        reasoningEnabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    sessionCommandGrantCount: safeRevision,
    interactionQueue,
    activeWork: activeWork.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.interactionQueue.revision !== value.revision) {
      context.addIssue({
        code: 'custom',
        message: 'interaction queue revision must match the session projection revision',
      });
    }
    const turnInteraction = value.activeWork?.activeTurn?.interaction;
    const queuedInteraction =
      value.interactionQueue.activeInteractionId === undefined
        ? undefined
        : value.interactionQueue.interactions.find(
            (candidate) => candidate.interactionId === value.interactionQueue.activeInteractionId,
          );
    if (
      value.interactionQueue.activeInteractionId !== turnInteraction?.interactionId ||
      (turnInteraction !== undefined &&
        (queuedInteraction === undefined ||
          turnInteraction.sessionRevision !== value.revision ||
          queuedInteraction.sessionRevision !== turnInteraction.sessionRevision ||
          !sameRuntimeClientInteractionIdentity(queuedInteraction, turnInteraction)))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'active turn interaction must match the interaction queue focus',
      });
    }
  });
const checkpoint = z
  .object({
    checkpointId: identifier,
    sessionId: identifier,
    revision: safeRevision,
    eventPosition: safeRevision,
    createdAt: safeRevision,
    targetMessage: shortText.optional(),
    targetMessageCreatedAt: safeRevision.optional(),
    affectedFileCount: safeRevision,
  })
  .strict();
const rewindPreview = z
  .object({
    checkpointId: identifier,
    sessionId: identifier,
    revision: safeRevision,
    files: z
      .array(
        z
          .object({ path: shortText, addedLines: safeRevision, removedLines: safeRevision })
          .strict(),
      )
      .max(256),
    lineStatsAvailable: z.boolean(),
    addedLines: safeRevision,
    removedLines: safeRevision,
    conflictCount: safeRevision,
    failureCount: safeRevision,
  })
  .strict();
const contextStatus = z
  .object({
    sessionId: identifier,
    revision: safeRevision,
    usedTokens: safeRevision.optional(),
    availableTokens: safeRevision.optional(),
    compactionAvailable: z.boolean(),
  })
  .strict();
const runTerminal = z
  .object({
    reasonCode: identifier,
    safeRetry: z.boolean(),
    recoveryEntry: z.enum(['none', 'retry', 'reconcile', 'new_run', 'operator_action']),
    outcomeId: identifier.optional(),
  })
  .strict();
const runProjection = z
  .object({
    schema: z.literal('kite.runtime-run.v1'),
    sessionId: identifier,
    runId: identifier,
    originSessionId: identifier.optional(),
    originRunId: identifier.optional(),
    phase: z.enum(['planning', 'building']),
    status: z.enum(['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'unknown']),
    createdRevision: safeRevision,
    lastRevision: safeRevision,
    createdAtMs: safeRevision,
    startedAtMs: safeRevision.optional(),
    finishedAtMs: safeRevision.optional(),
    terminal: runTerminal.optional(),
  })
  .strict()
  .superRefine((run, context) => {
    const terminal = ['completed', 'failed', 'cancelled', 'unknown'].includes(run.status);
    if ((run.originSessionId === undefined) !== (run.originRunId === undefined)) {
      context.addIssue({ code: 'custom', message: 'Run origin identity must be complete' });
    }
    if (run.lastRevision < run.createdRevision) {
      context.addIssue({ code: 'custom', message: 'Run revision order is invalid' });
    }
    if ((run.status === 'queued') !== (run.startedAtMs === undefined)) {
      context.addIssue({ code: 'custom', message: 'Run started time does not match status' });
    }
    if (terminal !== (run.finishedAtMs !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Run finished time does not match status' });
    }
    if (
      (run.startedAtMs !== undefined && run.startedAtMs < run.createdAtMs) ||
      (run.finishedAtMs !== undefined && run.finishedAtMs < (run.startedAtMs ?? run.createdAtMs))
    ) {
      context.addIssue({ code: 'custom', message: 'Run timestamps are not monotonic' });
    }
    if (!terminal && run.terminal !== undefined) {
      context.addIssue({ code: 'custom', message: 'Active Run cannot carry terminal detail' });
    }
    if (
      (run.status === 'failed' || run.status === 'cancelled' || run.status === 'unknown') &&
      run.terminal === undefined
    ) {
      context.addIssue({ code: 'custom', message: 'Non-success terminal Run needs detail' });
    }
  });
const runResource = z
  .object({ kind: z.literal('run'), run: runProjection })
  .strict()
  .superRefine((resource, context) => {
    if (
      resource.run.status !== 'queued' ||
      resource.run.lastRevision !== resource.run.createdRevision
    ) {
      context.addIssue({ code: 'custom', message: 'Original Run resource must be queued' });
    }
  });
const commandErrorCode = z.enum([
  'invalid_command',
  'invalid_session',
  'session_not_found',
  'revision_conflict',
  'turn_not_found',
  'run_not_found',
  'interaction_mismatch',
  'checkpoint_unavailable',
  'policy_denied',
  'runtime_busy',
  'session_unavailable',
  'unsupported',
  'already_closed',
]);
export const RUNTIME_COMMAND_RECEIPT_SCHEMA_ = z.union([
  z
    .object({
      status: z.literal('applied'),
      commandId: identifier,
      sessionId: identifier,
      revision: safeRevision,
      resource: runResource.optional(),
    })
    .strict(),
  z
    .object({
      status: z.enum(['conflict', 'rejected', 'not_found']),
      commandId: identifier,
      code: commandErrorCode,
      currentRevision: safeRevision.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('idempotent_replay'),
      commandId: identifier,
      sessionId: identifier,
      originalRevision: safeRevision,
      resource: runResource.optional(),
    })
    .strict(),
]);
export const RUNTIME_QUERY_RESULT_SCHEMA_ = z.union([
  z
    .object({
      status: z.literal('ok'),
      queryType: z.literal('list_sessions'),
      revision: safeRevision.optional(),
      sessions: z.array(RUNTIME_PROTOCOL_SESSION_SCHEMA_).max(10_000),
    })
    .strict(),
  z
    .object({
      status: z.literal('ok'),
      queryType: z.literal('get_session_projection'),
      revision: safeRevision.optional(),
      session: RUNTIME_PROTOCOL_SESSION_SCHEMA_,
    })
    .strict(),
  z
    .object({
      status: z.literal('ok'),
      queryType: z.literal('get_context_status'),
      revision: safeRevision.optional(),
      context: contextStatus,
    })
    .strict(),
  z
    .object({
      status: z.literal('ok'),
      queryType: z.literal('list_checkpoints'),
      revision: safeRevision.optional(),
      checkpoints: z.array(checkpoint).max(10_000),
    })
    .strict(),
  z
    .object({
      status: z.literal('ok'),
      queryType: z.literal('get_rewind_preview'),
      revision: safeRevision.optional(),
      rewindPreview,
    })
    .strict(),
  z
    .object({
      status: z.literal('ok'),
      queryType: z.literal('get_run'),
      revision: safeRevision.optional(),
      run: runProjection,
    })
    .strict(),
  z
    .object({
      status: z.literal('ok'),
      queryType: z.literal('list_runs'),
      revision: safeRevision.optional(),
      runs: z.array(runProjection).max(200),
      nextRunCursor: z
        .object({ createdRevision: safeRevision, runId: identifier })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      status: z.enum(['not_found', 'rejected', 'unavailable']),
      queryType: z.enum([
        'list_sessions',
        'get_session_projection',
        'get_context_status',
        'list_checkpoints',
        'get_rewind_preview',
        'get_run',
        'list_runs',
      ]),
      code: commandErrorCode,
    })
    .strict(),
]);
export const INITIALIZE_RESULT_SCHEMA_ = z
  .object({
    protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    protocolSchema: z.literal(RUNTIME_PROTOCOL_SCHEMA),
    serverInfo: z.object({ version: z.string().min(1).max(128), instanceId: identifier }).strict(),
    capabilities: z
      .object({
        methods: z
          .array(RUNTIME_PROTOCOL_METHOD_SCHEMA_)
          .min(1)
          .max(RUNTIME_PROTOCOL_METHOD_SCHEMA_.options.length),
        subscriptions: z.array(z.enum(['session', 'sessions'])).max(2),
      })
      .strict(),
    limits: z
      .object({
        maxMessageBytes: safeRevision,
        maxDepth: safeRevision,
        maxInFlightRequests: safeRevision,
        maxSubscriptions: safeRevision,
        maxOutboundMessages: safeRevision,
      })
      .strict(),
  })
  .strict();
export type InitializeResult = z.infer<typeof INITIALIZE_RESULT_SCHEMA_>;
const subscribeResult = z.object({ subscriptionId: identifier, generation: safeRevision }).strict();
const unsubscribeResult = z.object({ unsubscribed: z.boolean() }).strict();
const pingResult = z.object({ status: z.literal('ok') }).strict();
const historySessionEntry = z
  .object({
    sessionId: identifier,
    displayName: shortText,
    needsSmartName: z.boolean(),
    updatedAt: safeRevision,
    lastSequence: safeRevision,
    model: z.object({ provider: identifier, name: shortText }).strict().optional(),
  })
  .strict();
const historySessionPage = z
  .object({
    entries: z.array(historySessionEntry).max(100),
    nextCursor: z.object({ updatedAt: safeRevision, sessionId: identifier }).strict().optional(),
    hasMore: z.boolean(),
  })
  .strict();
const historyEventDetail = z
  .object({
    kind: z.enum([
      'message',
      'model',
      'tool',
      'interaction',
      'subagent',
      'verification',
      'artifact',
      'unavailable',
    ]),
    fields: z
      .record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()]))
      .optional(),
    artifact: z
      .object({ kind: shortText, availability: z.enum(['available', 'unavailable']) })
      .strict()
      .optional(),
  })
  .strict();
const historyEventEntry = z
  .object({
    sessionId: identifier,
    sequence: safeRevision,
    eventId: identifier,
    causationId: identifier.optional(),
    occurredAt: shortText.optional(),
    createdAt: safeRevision,
    type: shortText.max(160),
    category: z.enum([
      'session',
      'turn',
      'model',
      'tool',
      'interaction',
      'subagent',
      'verification',
      'recovery',
      'other',
    ]),
    status: z.enum(['ok', 'running', 'waiting', 'cancelled', 'failed', 'unknown']),
    summary: outputText.optional(),
    detail: historyEventDetail.optional(),
  })
  .strict();
const historyEventPage = z
  .object({
    entries: z.array(historyEventEntry).max(200),
    nextCursor: safeRevision.optional(),
    hasMore: z.boolean(),
    observedLastSequence: safeRevision,
  })
  .strict();
const historyTranscript = z
  .object({
    session: historySessionEntry,
    records: z
      .array(
        z
          .object({
            sequence: safeRevision,
            events: z.array(z.lazy(() => RUNTIME_PROTOCOL_EVENT_SCHEMA_)),
          })
          .strict(),
      )
      .max(RUNTIME_PROTOCOL_LIMITS.maxArrayLength),
    events: z.array(z.lazy(() => RUNTIME_PROTOCOL_EVENT_SCHEMA_)),
    interactionMode: z.enum(['accept_edits', 'auto', 'full']),
    recovery: z.enum(['normal', 'pending_interaction']),
  })
  .strict();
const appControlResult = z
  .object({
    method: RUNTIME_PROTOCOL_APP_METHOD_SCHEMA_,
    response: jsonRecord,
  })
  .strict();
const serverControlResult = z
  .object({
    method: RUNTIME_PROTOCOL_SERVER_CONTROL_METHOD_SCHEMA_,
    response: jsonRecord,
  })
  .strict();
export const RUNTIME_PROTOCOL_RESULT_SCHEMA_ = z.union([
  INITIALIZE_RESULT_SCHEMA_,
  RUNTIME_COMMAND_RECEIPT_SCHEMA_,
  RUNTIME_QUERY_RESULT_SCHEMA_,
  subscribeResult,
  unsubscribeResult,
  pingResult,
  historySessionPage,
  historyEventPage,
  historyTranscript,
  appControlResult,
  serverControlResult,
]);
export type RuntimeProtocolResult = z.infer<typeof RUNTIME_PROTOCOL_RESULT_SCHEMA_>;

/** Kept separate from command/query codecs while Contract finalizes its event/index unions. */
export const RUNTIME_PROTOCOL_EVENT_SCHEMA_ = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('user.message'),
      messageId: identifier,
      kind: z.enum(['task', 'answer', 'resume_context']),
      text: inputText,
    })
    .strict(),
  z.object({ type: z.literal('model.requested'), requestId: identifier }).strict(),
  z
    .object({ type: z.literal('model.text_delta'), requestId: identifier, text: inputText })
    .strict(),
  z
    .object({
      type: z.literal('model.responded'),
      requestId: identifier,
      messageId: identifier,
      durationMs: safeRevision.optional(),
      toolCallCount: safeRevision,
      summary: outputText.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('model.retry'),
      requestId: identifier,
      attempt: safeRevision.min(1),
      delayMs: safeRevision.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('model.cache'),
      inputTokens: safeRevision,
      cacheHitTokens: safeRevision,
      cacheMissTokens: safeRevision,
      outputTokens: safeRevision.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool.queued'),
      toolId: identifier,
      presentationGroupId: identifier.optional(),
      toolName: runtimeToolDisplayName.optional(),
      displayLabel: displayLabel.optional(),
      presentation: runtimeToolPresentation,
      arguments: jsonRecord,
      summary: shortText,
    })
    .strict(),
  z
    .object({ type: z.literal('tool.started'), toolId: identifier, summary: shortText.optional() })
    .strict(),
  z
    .object({
      type: z.literal('tool.progress'),
      toolId: identifier,
      summary: shortText,
      stream: z.enum(['stdout', 'stderr']).optional(),
      lineCount: safeRevision.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool.finished'),
      toolId: identifier,
      toolName: runtimeToolDisplayName.optional(),
      displayLabel: displayLabel.optional(),
      presentation: runtimeToolPresentation,
      result: toolResult,
      summary: shortText,
    })
    .strict(),
  z.object({ type: z.literal('tool.failed'), toolId: identifier, summary: shortText }).strict(),
  z.object({ type: z.literal('tool.rejected'), toolId: identifier, summary: shortText }).strict(),
  z
    .object({
      type: z.literal('tool.cancelled'),
      toolId: identifier,
      summary: shortText.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool.file_changed'),
      toolId: identifier,
      change: z.enum(['added', 'modified', 'deleted']),
      summary: shortText.optional(),
    })
    .strict(),
  z.object({ type: z.literal('interaction.available'), interaction }).strict(),
  z
    .object({
      type: z.literal('reasoning.activity'),
      requestId: identifier,
      state: z.enum(['streaming', 'completed']),
      segmentId: identifier,
      text: inputText,
    })
    .strict(),
  z
    .object({
      type: z.literal('interaction.settled'),
      interactionId: identifier,
      sessionRevision: safeRevision,
      outcome: z.enum(['completed', 'rejected', 'cancelled', 'expired']),
    })
    .strict(),
  z.object({ type: z.literal('planning.entered'), taskId: identifier }).strict(),
  z.object({ type: z.literal('planning.exited'), taskId: identifier }).strict(),
  z
    .object({
      type: z.literal('interaction_mode.changed'),
      mode: z.enum(['accept_edits', 'auto', 'full']),
    })
    .strict(),
  z
    .object({
      type: z.literal('approval.queued'),
      interaction: interaction.options[0],
      queueSequence: safeRevision,
    })
    .strict(),
  z
    .object({
      type: z.literal('run.failure'),
      runId: identifier,
      code: identifier,
      retryable: z.boolean(),
      recoveryEntry: z.enum(['none', 'retry', 'reconcile', 'new_run', 'operator_action']),
    })
    .strict(),
  z
    .object({
      type: z.literal('approval.granted'),
      interactionId: identifier,
      generation: safeRevision,
    })
    .strict(),
  z
    .object({
      type: z.literal('approval.rejected'),
      interactionId: identifier,
      generation: safeRevision,
      summary: shortText.optional(),
    })
    .strict(),
  z.object({ type: z.literal('input.requested'), interaction: interaction.options[1] }).strict(),
  z
    .object({
      type: z.literal('input.answered'),
      interactionId: identifier,
      summary: shortText.optional(),
    })
    .strict(),
  z.object({ type: z.literal('input.cancelled'), interactionId: identifier }).strict(),
  z
    .object({ type: z.literal('plan.review_requested'), interaction: interaction.options[2] })
    .strict(),
  z
    .object({
      type: z.literal('plan.approved'),
      interactionId: identifier,
      sessionRevision: safeRevision,
      mode: z.enum(['accept_edits', 'auto']),
    })
    .strict(),
  z
    .object({
      type: z.literal('plan.progress'),
      planId: identifier,
      version: safeRevision.min(1),
      structuralDigest: identifier,
      status: z.enum(['pending', 'in_progress', 'completed', 'skipped']),
      summary: shortText.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('plan.completed'),
      planId: identifier,
      version: safeRevision.min(1),
      structuralDigest: identifier,
      summary: shortText.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('provider.action'),
      interaction: interaction.options[3],
      status: z.enum(['required', 'started', 'completed', 'deferred', 'failed']),
      summary: shortText.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('verification.status'),
      interaction: interaction.options[4],
      status: z.enum(['pending', 'running', 'passed', 'failed', 'waived']),
      summary: shortText.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('subagent.started'),
      subagentId: identifier,
      role: z.enum(['explore', 'plan', 'code', 'review']),
      name: shortText,
      concurrencyGroupId: identifier.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('subagent.step'),
      subagentId: identifier,
      toolName: shortText,
      status: z.enum(['started', 'completed', 'failed']),
      displayLabel: displayLabel.optional(),
      arguments: jsonRecord.optional(),
      result: subagentToolResult.optional(),
      totalLines: safeRevision.optional(),
      durationMs: safeRevision.optional(),
      summary: shortText.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('subagent.completed'),
      subagentId: identifier,
      summary: shortText,
      toolCallCount: safeRevision,
      durationMs: safeRevision,
    })
    .strict(),
  z
    .object({
      type: z.literal('subagent.failed'),
      subagentId: identifier,
      summary: shortText,
      toolCallCount: safeRevision.optional(),
      durationMs: safeRevision.optional(),
      diagnostic: z
        .object({
          code: z.enum([
            'aborted',
            'timed_out',
            'invalid_input',
            'consumer_protocol',
            'model_step_failed',
            'internal_error',
          ]),
          stage: z.enum([
            'initialization',
            'next_round_preparation',
            'model_step',
            'model_response_validation',
            'tool_consumption',
            'transcript_validation',
            'terminal_projection',
          ]),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('context.compaction'),
      status: z.enum(['requested', 'completed', 'failed', 'reset']),
      usedTokens: safeRevision.optional(),
      availableTokens: safeRevision.optional(),
      summary: shortText.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('task.terminal'),
      taskId: identifier,
      status: z.enum(['completed', 'cancelled', 'failed']),
      summary: shortText.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('turn.terminal'),
      turnId: identifier,
      status: z.enum(['completed', 'aborted', 'failed', 'cancelled']),
      cause: z.enum(['user', 'error']).optional(),
      summary: shortText.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('run.terminal'),
      runId: identifier,
      status: z.enum(['completed', 'failed', 'cancelled']),
      summary: shortText.optional(),
      outcome: z
        .object({
          status: z.enum([
            'completed',
            'aborted',
            'blocked',
            'unknown',
            'budget_exhausted',
            'resource_saturated',
          ]),
          reasonCode: identifier,
          safeRetry: z.boolean(),
          recoveryEntry: z.enum(['none', 'retry', 'reconcile', 'new_run', 'operator_action']),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('rewind.terminal'),
      rewindId: identifier,
      commandId: identifier,
      sourceSessionId: identifier,
      targetSessionId: identifier,
      status: z.enum(['completed', 'failed']),
      fileOutcome: z
        .object({
          restored: z.array(shortText).max(10_000),
          deleted: z.array(shortText).max(10_000),
          failed: z.array(z.object({ path: shortText, error: shortText }).strict()).max(10_000),
          conflicts: z
            .array(
              z
                .object({
                  path: shortText,
                  reason: z.enum(['modified_after_kite_write', 'unverified_postimage']),
                })
                .strict(),
            )
            .max(10_000),
        })
        .strict()
        .optional(),
      failureCode: z.enum(['checkpoint_unavailable', 'execution_failed']).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.notice'),
      code: z.enum(['reconnected', 'history_gap', 'session_closed']),
      message: shortText.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('unavailable'),
      reason: z.enum(['unknown_event', 'redacted', 'unsupported_version']),
    })
    .strict(),
]);
export type RuntimeProtocolEvent = z.infer<typeof RUNTIME_PROTOCOL_EVENT_SCHEMA_>;
export const RUNTIME_SUBSCRIPTION_MESSAGE_SCHEMA_ = z.union([
  z.object({ type: z.literal('ready'), scope: z.enum(['session', 'sessions']) }).strict(),
  z
    .object({
      type: z.literal('reset'),
      sessions: z.array(RUNTIME_PROTOCOL_SESSION_SCHEMA_).max(10_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('notification'),
      durability: z.literal('durable'),
      sessionId: identifier,
      revision: safeRevision,
      event: RUNTIME_PROTOCOL_EVENT_SCHEMA_.optional(),
      session: RUNTIME_PROTOCOL_SESSION_SCHEMA_,
    })
    .strict(),
  z
    .object({
      type: z.literal('notification'),
      durability: z.literal('ephemeral'),
      sessionId: identifier,
      workId: identifier,
      turnId: identifier,
      actorId: identifier,
      attemptId: identifier,
      compositionRevision: identifier,
      streamId: identifier,
      sequence: safeRevision,
      event: RUNTIME_PROTOCOL_EVENT_SCHEMA_,
    })
    .strict(),
  z
    .object({
      type: z.literal('index_reset_begin'),
      serverInstanceId: identifier,
      generation: safeRevision,
      indexRevision: safeRevision,
    })
    .strict(),
  z
    .object({
      type: z.literal('session_upsert'),
      serverInstanceId: identifier,
      generation: safeRevision,
      indexRevision: safeRevision,
      session: RUNTIME_PROTOCOL_SESSION_SCHEMA_,
    })
    .strict(),
  z
    .object({
      type: z.literal('session_remove'),
      serverInstanceId: identifier,
      generation: safeRevision,
      indexRevision: safeRevision,
      sessionId: identifier,
    })
    .strict(),
  z
    .object({
      type: z.literal('index_reset_end'),
      serverInstanceId: identifier,
      generation: safeRevision,
      indexRevision: safeRevision,
    })
    .strict(),
]);
export type RuntimeSubscriptionMessage = z.infer<typeof RUNTIME_SUBSCRIPTION_MESSAGE_SCHEMA_>;
export const RUNTIME_PROTOCOL_NOTIFICATION_SCHEMA_ = z.discriminatedUnion('method', [
  z
    .object({
      jsonrpc: z.literal('2.0'),
      method: z.literal('runtime/subscription'),
      params: z
        .object({
          subscriptionId: identifier,
          generation: safeRevision,
          message: RUNTIME_SUBSCRIPTION_MESSAGE_SCHEMA_,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal('2.0'),
      method: z.literal('server/draining'),
      params: z.object({ retryAfterMs: safeRevision.optional() }).strict(),
    })
    .strict(),
]);
export type RuntimeProtocolNotification = z.infer<typeof RUNTIME_PROTOCOL_NOTIFICATION_SCHEMA_>;
export const RUNTIME_PROTOCOL_RESPONSE_SCHEMA_ = z.union([
  z
    .object({ jsonrpc: z.literal('2.0'), id: rpcId, result: RUNTIME_PROTOCOL_RESULT_SCHEMA_ })
    .strict(),
  z
    .object({
      jsonrpc: z.literal('2.0'),
      id: z.union([rpcId, z.null()]),
      error: RUNTIME_PROTOCOL_ERROR_SCHEMA_,
    })
    .strict(),
]);
export type RuntimeProtocolResponse = z.infer<typeof RUNTIME_PROTOCOL_RESPONSE_SCHEMA_>;
export const RUNTIME_PROTOCOL_MESSAGE_SCHEMA_ = z.union([
  RUNTIME_PROTOCOL_REQUEST_SCHEMA_,
  RUNTIME_PROTOCOL_RESPONSE_SCHEMA_,
  RUNTIME_PROTOCOL_NOTIFICATION_SCHEMA_,
]);
export type RuntimeProtocolMessage = z.infer<typeof RUNTIME_PROTOCOL_MESSAGE_SCHEMA_>;
