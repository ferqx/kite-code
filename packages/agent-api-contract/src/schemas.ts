import { z } from 'zod';
import { AGENT_API_LIMITS } from './limits';
import {
  agentApiAccessTokenSchema,
  agentApiDetailTextSchema,
  agentApiEtagSchema,
  agentApiIdempotencyKeySchema,
  agentApiIdentifierSchema,
  agentApiJsonObjectSchema,
  agentApiOpaqueTokenSchema,
  agentApiPageLimitSchema,
  agentApiPositiveRevisionSchema,
  agentApiRevisionSchema,
  agentApiRunInputSchema,
  agentApiShortTextSchema,
  agentApiTimestampSchema,
  agentApiWaitMillisecondsSchema,
  boundedText,
  uniqueLexicalValues,
} from './scalars';

export const AGENT_API_VERSION = 'v1' as const;
export const AGENT_API_SCHEMA_DIGEST_HEADER = 'Kite-Agent-API-Schema-Digest' as const;
export const AGENT_API_VERSION_HEADER = 'Kite-Agent-API-Version' as const;

export const AGENT_API_CAPABILITIES = [
  'checkpoints',
  'history',
  'interactions',
  'runs',
  'session_stream',
  'sessions',
  'workspaces',
] as const;
export const agentApiCapabilitySchema = z.enum(AGENT_API_CAPABILITIES);
export type AgentApiCapability = z.infer<typeof agentApiCapabilitySchema>;

const capabilityListSchema = z
  .array(agentApiCapabilitySchema)
  .max(AGENT_API_LIMITS.maxCapabilities)
  .superRefine(uniqueLexicalValues);

export const AGENT_API_SERVER_INFO_SCHEMA = 'kite.agent-api.server-info.v1' as const;
export const AGENT_API_CONTEXT_SCHEMA = 'kite.agent-api.context.v1' as const;
export const AGENT_API_EXCHANGE_SCHEMA = 'kite.agent-api.exchange.v1' as const;
export const AGENT_API_WORKSPACE_SCHEMA = 'kite.agent-api.workspace.v1' as const;
export const AGENT_API_SESSION_SCHEMA = 'kite.agent-api.session.v1' as const;
export const AGENT_API_RUN_SCHEMA = 'kite.agent-api.run.v1' as const;
export const AGENT_API_INTERACTION_SCHEMA = 'kite.agent-api.interaction.v1' as const;
export const AGENT_API_INTERACTION_QUEUE_SCHEMA = 'kite.agent-api.interaction-queue.v1' as const;
export const AGENT_API_CHECKPOINT_SCHEMA = 'kite.agent-api.checkpoint.v1' as const;
export const AGENT_API_CHECKPOINT_PREVIEW_SCHEMA = 'kite.agent-api.checkpoint-preview.v1' as const;
export const AGENT_API_HISTORY_ITEM_SCHEMA = 'kite.agent-api.history-item.v1' as const;
export const AGENT_API_LOG_ITEM_SCHEMA = 'kite.agent-api.log-item.v1' as const;
export const AGENT_API_MODEL_CONTEXT_SCHEMA = 'kite.agent-api.model-context.v1' as const;
export const AGENT_API_EVENT_SCHEMA = 'kite.agent-api.event.v1' as const;
export const AGENT_API_RESYNC_SCHEMA = 'kite.agent-api.resync.v1' as const;
export const AGENT_API_PROBLEM_SCHEMA = 'kite.agent-api.problem.v1' as const;
export const AGENT_API_MUTATION_RESULT_SCHEMA = 'kite.agent-api.mutation-result.v1' as const;

export const agentApiServerInfoSchema = z.object({
  schema: z.literal(AGENT_API_SERVER_INFO_SCHEMA),
  api_version: z.literal(AGENT_API_VERSION),
  server_version: agentApiIdentifierSchema,
  build_id: agentApiIdentifierSchema,
  capabilities: capabilityListSchema,
});
export type AgentApiServerInfo = z.infer<typeof agentApiServerInfoSchema>;

export const agentApiExchangeRequestSchema = z.object({
  schema: z.literal(AGENT_API_EXCHANGE_SCHEMA),
  api_version: z.literal(AGENT_API_VERSION),
  required_capabilities: capabilityListSchema,
});
export type AgentApiExchangeRequest = z.infer<typeof agentApiExchangeRequestSchema>;

export const agentApiWorkspaceSchema = z.object({
  schema: z.literal(AGENT_API_WORKSPACE_SCHEMA),
  workspace_id: agentApiIdentifierSchema,
  display_name: agentApiShortTextSchema,
  session_count: agentApiRevisionSchema,
});
export type AgentApiWorkspace = z.infer<typeof agentApiWorkspaceSchema>;

export const agentApiContextSchema = z.object({
  schema: z.literal(AGENT_API_CONTEXT_SCHEMA),
  access_token: agentApiAccessTokenSchema,
  token_type: z.literal('Bearer'),
  expires_at: agentApiTimestampSchema,
  role: z.enum(['observer', 'controller']),
  api_version: z.literal(AGENT_API_VERSION),
  capabilities: capabilityListSchema,
});
export type AgentApiContext = z.infer<typeof agentApiContextSchema>;

export const agentApiInteractionKindSchema = z.enum([
  'approval',
  'input',
  'plan_review',
  'provider_action',
  'verification',
]);
export type AgentApiInteractionKind = z.infer<typeof agentApiInteractionKindSchema>;

export const agentApiInteractionSummarySchema = z.object({
  interaction_id: agentApiIdentifierSchema,
  session_revision: agentApiRevisionSchema,
  kind: agentApiInteractionKindSchema,
});
export type AgentApiInteractionSummary = z.infer<typeof agentApiInteractionSummarySchema>;

const interactionBase = {
  schema: z.literal(AGENT_API_INTERACTION_SCHEMA),
  interaction_id: agentApiIdentifierSchema,
  session_revision: agentApiRevisionSchema,
  title: agentApiShortTextSchema.optional(),
  summary: agentApiDetailTextSchema.optional(),
};

const agentApiApprovalInteractionSchema = z.object({
  ...interactionBase,
  kind: z.literal('approval'),
  generation: agentApiPositiveRevisionSchema,
  grants: z
    .array(z.enum(['approve_once', 'same_command']))
    .min(1)
    .max(2)
    .superRefine(uniqueLexicalValues),
  command: boundedText(16_384).optional(),
});
const agentApiInputInteractionSchema = z.object({
  ...interactionBase,
  kind: z.literal('input'),
  question: boundedText(8_192, { minimumBytes: 1 }),
  allow_free_text: z.boolean(),
  options: z
    .array(
      z.object({
        option_id: agentApiIdentifierSchema,
        label: agentApiShortTextSchema,
        description: agentApiDetailTextSchema.optional(),
      }),
    )
    .max(AGENT_API_LIMITS.maxArrayLength)
    .optional(),
});
const agentApiPlanReviewInteractionSchema = z.object({
  ...interactionBase,
  kind: z.literal('plan_review'),
  plan: z.object({
    plan_id: agentApiIdentifierSchema,
    version: agentApiPositiveRevisionSchema,
    structural_digest: agentApiIdentifierSchema,
  }),
});
const agentApiProviderActionInteractionSchema = z.object({
  ...interactionBase,
  kind: z.literal('provider_action'),
  provider: z.object({
    provider_id: agentApiIdentifierSchema,
    directory_revision: agentApiIdentifierSchema.optional(),
  }),
  action: z.enum(['login', 'approve', 'retry']),
});
const agentApiVerificationInteractionSchema = z.object({
  ...interactionBase,
  kind: z.literal('verification'),
  verification: z.object({
    verification_id: agentApiIdentifierSchema,
    revision: agentApiIdentifierSchema,
  }),
});

export const agentApiInteractionSchema = z.discriminatedUnion('kind', [
  agentApiApprovalInteractionSchema,
  agentApiInputInteractionSchema,
  agentApiPlanReviewInteractionSchema,
  agentApiProviderActionInteractionSchema,
  agentApiVerificationInteractionSchema,
]);
export type AgentApiInteraction = z.infer<typeof agentApiInteractionSchema>;

export const agentApiInteractionQueueSchema = z
  .object({
    schema: z.literal(AGENT_API_INTERACTION_QUEUE_SCHEMA),
    session_id: agentApiIdentifierSchema,
    revision: agentApiRevisionSchema,
    interactions: z.array(agentApiInteractionSchema).max(AGENT_API_LIMITS.maxInteractions),
    active_interaction_id: agentApiIdentifierSchema.optional(),
  })
  .superRefine((value, context) => {
    const identities = value.interactions.map((interaction) => interaction.interaction_id);
    if (new Set(identities).size !== identities.length) {
      context.addIssue({ code: 'custom', message: 'interaction identities must be unique' });
    }
    if (value.interactions.some((interaction) => interaction.session_revision !== value.revision)) {
      context.addIssue({
        code: 'custom',
        message: 'every interaction revision must equal the queue revision',
      });
    }
    if (
      value.active_interaction_id !== undefined &&
      !identities.includes(value.active_interaction_id)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'active interaction must identify a queue member',
      });
    }
  });
export type AgentApiInteractionQueue = z.infer<typeof agentApiInteractionQueueSchema>;

export const agentApiSessionLifecycleSchema = z.enum(['open', 'closed', 'unavailable']);
export const agentApiSessionStatusSchema = z.enum([
  'idle',
  'queued',
  'running',
  'waiting',
  'error',
  'unavailable',
]);

export const agentApiSessionSchema = z
  .object({
    schema: z.literal(AGENT_API_SESSION_SCHEMA),
    session_id: agentApiIdentifierSchema,
    revision: agentApiRevisionSchema,
    display_name: agentApiShortTextSchema.optional(),
    lifecycle: agentApiSessionLifecycleSchema,
    status: agentApiSessionStatusSchema,
    active_run_id: agentApiIdentifierSchema.optional(),
    active_interaction: agentApiInteractionSummarySchema.optional(),
    model: z
      .object({
        provider: agentApiIdentifierSchema,
        name: agentApiIdentifierSchema,
        reasoning_enabled: z.boolean().optional(),
      })
      .optional(),
    created_at: agentApiTimestampSchema.optional(),
    updated_at: agentApiTimestampSchema.optional(),
    last_sequence: agentApiRevisionSchema.optional(),
  })
  .superRefine((value, context) => {
    if (
      value.active_interaction?.session_revision !== undefined &&
      value.active_interaction.session_revision !== value.revision
    ) {
      context.addIssue({
        code: 'custom',
        message: 'active interaction revision must equal Session revision',
      });
    }
    if (value.active_interaction && !['waiting', 'unavailable'].includes(value.status)) {
      context.addIssue({
        code: 'custom',
        message: 'active interaction requires waiting or unavailable status',
      });
    }
    if (value.lifecycle === 'unavailable' && value.status !== 'unavailable') {
      context.addIssue({
        code: 'custom',
        message: 'unavailable lifecycle requires unavailable status',
      });
    }
  });
export type AgentApiSession = z.infer<typeof agentApiSessionSchema>;

export const agentApiRunStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'unknown',
]);
export const agentApiRunPhaseSchema = z.enum(['planning', 'building']);
export const agentApiRecoveryEntrySchema = z.enum([
  'none',
  'retry',
  'reconcile',
  'new_run',
  'operator_action',
]);
const terminalRunStatuses = new Set(['completed', 'failed', 'cancelled', 'unknown']);

export const agentApiRunSchema = z
  .object({
    schema: z.literal(AGENT_API_RUN_SCHEMA),
    run_id: agentApiIdentifierSchema,
    session_id: agentApiIdentifierSchema,
    status: agentApiRunStatusSchema,
    phase: agentApiRunPhaseSchema,
    created_at: agentApiTimestampSchema,
    started_at: agentApiTimestampSchema.optional(),
    finished_at: agentApiTimestampSchema.optional(),
    terminal: z
      .object({
        reason_code: agentApiIdentifierSchema,
        safe_retry: z.boolean(),
        recovery_entry: agentApiRecoveryEntrySchema,
      })
      .optional(),
  })
  .superRefine((value, context) => {
    const terminal = terminalRunStatuses.has(value.status);
    if (terminal !== (value.finished_at !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'finished_at must exist exactly for a terminal or unknown Run',
      });
    }
    if (['failed', 'cancelled', 'unknown'].includes(value.status) && !value.terminal) {
      context.addIssue({
        code: 'custom',
        message: 'non-success terminal Run needs terminal detail',
      });
    }
    if (!terminal && value.terminal) {
      context.addIssue({ code: 'custom', message: 'active Run cannot carry terminal detail' });
    }
    if (value.status !== 'queued' && !value.started_at) {
      context.addIssue({ code: 'custom', message: 'non-queued Run needs started_at' });
    }
    if (value.status === 'queued' && value.started_at) {
      context.addIssue({ code: 'custom', message: 'queued Run cannot have started_at' });
    }
    const created = Date.parse(value.created_at);
    const started = value.started_at ? Date.parse(value.started_at) : undefined;
    const finished = value.finished_at ? Date.parse(value.finished_at) : undefined;
    if (
      (started !== undefined && started < created) ||
      (finished !== undefined && finished < (started ?? created))
    ) {
      context.addIssue({ code: 'custom', message: 'Run timestamps must be monotonic' });
    }
  });
export type AgentApiRun = z.infer<typeof agentApiRunSchema>;

export const agentApiCheckpointSchema = z.object({
  schema: z.literal(AGENT_API_CHECKPOINT_SCHEMA),
  checkpoint_id: agentApiIdentifierSchema,
  session_id: agentApiIdentifierSchema,
  revision: agentApiRevisionSchema,
  scope: z.enum(['conversation_only', 'conversation_and_workspace', 'code_only']),
  created_at: agentApiTimestampSchema.optional(),
  label: agentApiShortTextSchema.optional(),
});
export type AgentApiCheckpoint = z.infer<typeof agentApiCheckpointSchema>;

export const agentApiCheckpointPreviewSchema = z.object({
  schema: z.literal(AGENT_API_CHECKPOINT_PREVIEW_SCHEMA),
  checkpoint: agentApiCheckpointSchema,
  current_revision: agentApiRevisionSchema,
  files: z.object({
    changed: agentApiRevisionSchema,
    conflicted: agentApiRevisionSchema,
    additions: agentApiRevisionSchema,
    deletions: agentApiRevisionSchema,
  }),
  conflict_summaries: z.array(agentApiDetailTextSchema).max(32),
});
export type AgentApiCheckpointPreview = z.infer<typeof agentApiCheckpointPreviewSchema>;

const historyContent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('user.message'),
    message_id: agentApiIdentifierSchema,
    text: boundedText(65_536),
  }),
  z.object({
    type: z.literal('model.message'),
    message_id: agentApiIdentifierSchema,
    text: boundedText(65_536),
  }),
  z.object({
    type: z.literal('model.reasoning'),
    request_id: agentApiIdentifierSchema,
    text: boundedText(65_536),
  }),
  z.object({
    type: z.literal('tool.lifecycle'),
    tool_call_id: agentApiIdentifierSchema,
    label: agentApiShortTextSchema,
    status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
    summary: agentApiDetailTextSchema.optional(),
  }),
  z.object({
    type: z.literal('run.status'),
    status: agentApiRunStatusSchema,
    reason_code: agentApiIdentifierSchema.optional(),
  }),
]);

export const agentApiHistoryItemSchema = z.object({
  schema: z.literal(AGENT_API_HISTORY_ITEM_SCHEMA),
  session_id: agentApiIdentifierSchema,
  run_id: agentApiIdentifierSchema.optional(),
  sequence: agentApiPositiveRevisionSchema,
  public_ordinal: agentApiRevisionSchema,
  occurred_at: agentApiTimestampSchema,
  content: historyContent,
});
export type AgentApiHistoryItem = z.infer<typeof agentApiHistoryItemSchema>;

const agentApiLogDetailSchema = z.object({
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
    .array(
      z.object({
        name: agentApiIdentifierSchema,
        value: boundedText(65_536),
      }),
    )
    .max(32),
  artifact: z
    .object({
      kind: agentApiShortTextSchema,
      availability: z.enum(['available', 'unavailable']),
    })
    .optional(),
});

export const agentApiLogItemSchema = z.object({
  schema: z.literal(AGENT_API_LOG_ITEM_SCHEMA),
  session_id: agentApiIdentifierSchema,
  sequence: agentApiPositiveRevisionSchema,
  occurred_at: agentApiTimestampSchema,
  event_type: boundedText(160, { minimumBytes: 1 }),
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
  summary: agentApiDetailTextSchema.optional(),
  detail: agentApiLogDetailSchema,
});
export type AgentApiLogItem = z.infer<typeof agentApiLogItemSchema>;

const agentApiModelContextPartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: boundedText(65_536),
    truncated: z.boolean(),
  }),
  z.object({
    type: z.literal('reasoning'),
    text: boundedText(65_536),
    truncated: z.boolean(),
  }),
  z.object({
    type: z.literal('tool_call'),
    tool_call_id: agentApiIdentifierSchema,
    tool_name: agentApiShortTextSchema,
    input_json: boundedText(32_768),
    truncated: z.boolean(),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_call_id: agentApiIdentifierSchema,
    tool_name: agentApiShortTextSchema,
    output: boundedText(65_536),
    truncated: z.boolean(),
  }),
]);

const agentApiModelContextMessageSchema = z.object({
  index: agentApiRevisionSchema,
  role: z.enum(['user', 'assistant', 'tool']),
  parts: z.array(agentApiModelContextPartSchema).max(AGENT_API_LIMITS.maxArrayLength),
});

const agentApiModelContextToolSchema = z.object({
  name: agentApiShortTextSchema,
  description: boundedText(4_096).optional(),
  input_schema_json: boundedText(32_768),
  truncated: z.boolean(),
});

export const agentApiModelContextSchema = z.object({
  schema: z.literal(AGENT_API_MODEL_CONTEXT_SCHEMA),
  session_id: agentApiIdentifierSchema,
  invocation_id: agentApiIdentifierSchema,
  sequence: agentApiPositiveRevisionSchema,
  purpose: z.enum(['primary_agent', 'context_compaction', 'auto_review', 'subagent']),
  model: z.object({
    provider: agentApiShortTextSchema,
    name: agentApiShortTextSchema,
  }),
  system_prompt: z.object({
    text: boundedText(AGENT_API_LIMITS.maxRunInputBytes),
    truncated: z.boolean(),
  }),
  messages: z.array(agentApiModelContextMessageSchema).max(AGENT_API_LIMITS.maxPageLimit),
  messages_truncated: z.boolean(),
  tools: z.array(agentApiModelContextToolSchema).max(AGENT_API_LIMITS.maxPageLimit),
  tools_truncated: z.boolean(),
  request_settings: z.object({
    transport: z.enum(['stream', 'generate']),
    temperature: z.number().finite(),
    max_output_tokens: agentApiRevisionSchema.nullable(),
    stop_policy: z.object({
      kind: z.literal('single_step'),
      max_steps: z.literal(1),
    }),
    message_count: agentApiRevisionSchema,
    tool_count: agentApiRevisionSchema,
  }),
});
export type AgentApiModelContext = z.infer<typeof agentApiModelContextSchema>;

export const AGENT_API_SSE_CHANNELS = [
  'interactions',
  'lifecycle',
  'messages',
  'session',
  'tools',
] as const;
export const agentApiSseChannelSchema = z.enum(AGENT_API_SSE_CHANNELS);
const sseChannelsSchema = z
  .array(agentApiSseChannelSchema)
  .min(1)
  .max(AGENT_API_LIMITS.maxSseChannels)
  .superRefine(uniqueLexicalValues);

const publicEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.status'), status: agentApiRunStatusSchema }),
  z.object({
    type: z.literal('message.appended'),
    role: z.enum(['user', 'assistant']),
    message_id: agentApiIdentifierSchema,
    text: boundedText(65_536),
  }),
  z.object({
    type: z.literal('reasoning.appended'),
    request_id: agentApiIdentifierSchema,
    text: boundedText(65_536),
  }),
  z.object({
    type: z.literal('tool.updated'),
    tool_call_id: agentApiIdentifierSchema,
    label: agentApiShortTextSchema,
    status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
    summary: agentApiDetailTextSchema.optional(),
  }),
  z.object({ type: z.literal('interactions.replaced'), queue: agentApiInteractionQueueSchema }),
  z.object({ type: z.literal('session.replaced'), session: agentApiSessionSchema }),
]);

export const agentApiEventSchema = z.object({
  schema: z.literal(AGENT_API_EVENT_SCHEMA),
  session_id: agentApiIdentifierSchema,
  run_id: agentApiIdentifierSchema.optional(),
  channel: agentApiSseChannelSchema,
  durability: z.enum(['durable', 'ephemeral']),
  session_revision: agentApiRevisionSchema,
  event: publicEvent,
});
export type AgentApiEvent = z.infer<typeof agentApiEventSchema>;

export const agentApiResyncSchema = z
  .object({
    schema: z.literal(AGENT_API_RESYNC_SCHEMA),
    reason: z.enum([
      'initial',
      'cursor_invalid',
      'cursor_too_old',
      'generation_changed',
      'filter_changed',
      'ephemeral_cursor',
      'buffer_gap',
      'codec_changed',
    ]),
    stream_generation: agentApiIdentifierSchema,
    history_through_sequence: agentApiRevisionSchema,
    snapshot_revision: agentApiRevisionSchema,
    session: agentApiSessionSchema,
    interactions: agentApiInteractionQueueSchema,
    resume_after_event_id: agentApiOpaqueTokenSchema,
  })
  .superRefine((value, context) => {
    if (
      value.session.session_id !== value.interactions.session_id ||
      value.session.revision !== value.snapshot_revision ||
      value.interactions.revision !== value.snapshot_revision
    ) {
      context.addIssue({
        code: 'custom',
        message: 'resync replacement facts must share identity and revision',
      });
    }
  });
export type AgentApiResync = z.infer<typeof agentApiResyncSchema>;

const pageBase = {
  next_cursor: agentApiOpaqueTokenSchema.optional(),
};
export const agentApiSessionPageSchema = z.object({
  schema: z.literal('kite.agent-api.session-page.v1'),
  workspace_id: agentApiIdentifierSchema.optional(),
  items: z.array(agentApiSessionSchema).max(AGENT_API_LIMITS.maxPageLimit),
  ...pageBase,
});
export const agentApiWorkspacePageSchema = z.object({
  schema: z.literal('kite.agent-api.workspace-page.v1'),
  items: z.array(agentApiWorkspaceSchema).max(AGENT_API_LIMITS.maxPageLimit),
  ...pageBase,
});
export const agentApiRunPageSchema = z
  .object({
    schema: z.literal('kite.agent-api.run-page.v1'),
    session_id: agentApiIdentifierSchema,
    items: z.array(agentApiRunSchema).max(AGENT_API_LIMITS.maxPageLimit),
    ...pageBase,
  })
  .superRefine((value, context) => {
    if (value.items.some((item) => item.session_id !== value.session_id)) {
      context.addIssue({ code: 'custom', message: 'Run page contains a different Session' });
    }
  });
export const agentApiHistoryPageSchema = z
  .object({
    schema: z.literal('kite.agent-api.history-page.v1'),
    session_id: agentApiIdentifierSchema,
    through_sequence: agentApiRevisionSchema,
    items: z.array(agentApiHistoryItemSchema).max(AGENT_API_LIMITS.maxHistoryItems),
    ...pageBase,
  })
  .superRefine((value, context) => {
    if (
      value.items.some(
        (item) => item.session_id !== value.session_id || item.sequence > value.through_sequence,
      )
    ) {
      context.addIssue({ code: 'custom', message: 'History page exceeds its Session watermark' });
    }
  });
export const agentApiLogPageSchema = z
  .object({
    schema: z.literal('kite.agent-api.log-page.v1'),
    session_id: agentApiIdentifierSchema,
    through_sequence: agentApiRevisionSchema,
    items: z.array(agentApiLogItemSchema).max(AGENT_API_LIMITS.maxHistoryItems),
    ...pageBase,
  })
  .superRefine((value, context) => {
    if (
      value.items.some(
        (item) => item.session_id !== value.session_id || item.sequence > value.through_sequence,
      )
    ) {
      context.addIssue({ code: 'custom', message: 'Log page exceeds its Session watermark' });
    }
  });
export const agentApiCheckpointPageSchema = z
  .object({
    schema: z.literal('kite.agent-api.checkpoint-page.v1'),
    session_id: agentApiIdentifierSchema,
    items: z.array(agentApiCheckpointSchema).max(AGENT_API_LIMITS.maxPageLimit),
    ...pageBase,
  })
  .superRefine((value, context) => {
    if (value.items.some((item) => item.session_id !== value.session_id)) {
      context.addIssue({ code: 'custom', message: 'Checkpoint page contains a different Session' });
    }
  });
export type AgentApiSessionPage = z.infer<typeof agentApiSessionPageSchema>;
export type AgentApiWorkspacePage = z.infer<typeof agentApiWorkspacePageSchema>;
export type AgentApiRunPage = z.infer<typeof agentApiRunPageSchema>;
export type AgentApiHistoryPage = z.infer<typeof agentApiHistoryPageSchema>;
export type AgentApiLogPage = z.infer<typeof agentApiLogPageSchema>;
export type AgentApiCheckpointPage = z.infer<typeof agentApiCheckpointPageSchema>;

export const AGENT_API_PROBLEM_CODES = [
  'checkpoint_unavailable',
  'controller_conflict',
  'cursor_invalidated',
  'forbidden',
  'idempotency_conflict',
  'incompatible',
  'interaction_mismatch',
  'invalid_cursor',
  'invalid_request',
  'method_not_allowed',
  'not_acceptable',
  'not_found',
  'outcome_unknown',
  'overloaded',
  'payload_too_large',
  'precondition_required',
  'revision_conflict',
  'run_not_active',
  'session_busy',
  'temporarily_unavailable',
  'unauthorized',
  'unsupported_media_type',
] as const;
export const agentApiProblemCodeSchema = z.enum(AGENT_API_PROBLEM_CODES);

const problemStatus = Object.freeze({
  invalid_request: 400,
  invalid_cursor: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  not_acceptable: 406,
  idempotency_conflict: 409,
  session_busy: 409,
  interaction_mismatch: 409,
  controller_conflict: 409,
  run_not_active: 409,
  checkpoint_unavailable: 409,
  cursor_invalidated: 409,
  revision_conflict: 412,
  payload_too_large: 413,
  unsupported_media_type: 415,
  incompatible: 426,
  precondition_required: 428,
  overloaded: 429,
  temporarily_unavailable: 503,
  outcome_unknown: 503,
} satisfies Readonly<Record<z.infer<typeof agentApiProblemCodeSchema>, number>>);

export const agentApiProblemSchema = z
  .object({
    schema: z.literal(AGENT_API_PROBLEM_SCHEMA),
    type: z.string().regex(/^urn:kite:agent-api:problem:[a-z_]+$/u),
    title: agentApiShortTextSchema,
    status: z.number().int().min(400).max(599),
    code: agentApiProblemCodeSchema,
    request_id: agentApiIdentifierSchema,
    retryable: z.boolean(),
    detail: agentApiDetailTextSchema.optional(),
    field: agentApiIdentifierSchema.optional(),
    current_revision: agentApiRevisionSchema.optional(),
    limit_bytes: agentApiPositiveRevisionSchema.optional(),
    required_header: z.literal('If-Match').optional(),
    supported_api_versions: z.array(z.literal(AGENT_API_VERSION)).max(1).optional(),
    missing_capabilities: capabilityListSchema.optional(),
    recovery_entry: agentApiRecoveryEntrySchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.type !== `urn:kite:agent-api:problem:${value.code}`) {
      context.addIssue({ code: 'custom', message: 'Problem type must identify its code' });
    }
    if (value.status !== problemStatus[value.code]) {
      context.addIssue({ code: 'custom', message: 'Problem status does not match its code' });
    }
    const retryable = ['overloaded', 'temporarily_unavailable', 'outcome_unknown'].includes(
      value.code,
    );
    if (value.retryable !== retryable) {
      context.addIssue({ code: 'custom', message: 'Problem retryable does not match its code' });
    }
    if (value.code === 'revision_conflict' && value.current_revision === undefined) {
      context.addIssue({ code: 'custom', message: 'revision conflict needs current_revision' });
    }
    if (value.code === 'precondition_required' && value.required_header !== 'If-Match') {
      context.addIssue({ code: 'custom', message: 'precondition problem needs If-Match' });
    }
    if (value.code === 'payload_too_large' && value.limit_bytes === undefined) {
      context.addIssue({ code: 'custom', message: 'payload limit problem needs limit_bytes' });
    }
    if (value.code === 'incompatible' && !value.supported_api_versions) {
      context.addIssue({
        code: 'custom',
        message: 'incompatible problem needs supported versions',
      });
    }
  });
export type AgentApiProblem = z.infer<typeof agentApiProblemSchema>;

export const agentApiDeletedSessionSchema = z.object({
  schema: z.literal('kite.agent-api.deleted-session.v1'),
  session_id: agentApiIdentifierSchema,
  deleted_revision: agentApiRevisionSchema,
});

const mutationBase = {
  schema: z.literal(AGENT_API_MUTATION_RESULT_SCHEMA),
  mutation_id: agentApiIdentifierSchema,
  replayed: z.boolean(),
  applied_revision: agentApiRevisionSchema,
  stream_consistency: z.literal('refetch_required'),
};
export const agentApiMutationResultSchema = z.discriminatedUnion('operation', [
  z.object({
    ...mutationBase,
    operation: z.literal('create_session'),
    resource: agentApiSessionSchema,
  }),
  z.object({
    ...mutationBase,
    operation: z.literal('resume_session'),
    resource: agentApiSessionSchema,
  }),
  z.object({
    ...mutationBase,
    operation: z.literal('close_session'),
    resource: agentApiSessionSchema,
  }),
  z.object({
    ...mutationBase,
    operation: z.literal('rewind_session'),
    resource: agentApiSessionSchema,
  }),
  z.object({
    ...mutationBase,
    operation: z.literal('delete_session'),
    resource: agentApiDeletedSessionSchema,
  }),
  z.object({
    ...mutationBase,
    operation: z.literal('create_run'),
    resource: agentApiRunSchema,
  }),
  z.object({
    ...mutationBase,
    operation: z.literal('cancel_run'),
    resource: agentApiRunSchema,
  }),
  z.object({
    ...mutationBase,
    operation: z.literal('respond_interaction'),
    resource: agentApiInteractionQueueSchema,
  }),
  z.object({
    ...mutationBase,
    operation: z.literal('fork_session'),
    resource: agentApiSessionSchema,
  }),
]);
export type AgentApiMutationResult = z.infer<typeof agentApiMutationResultSchema>;

export const agentApiSessionListQuerySchema = z.object({
  lifecycle: agentApiSessionLifecycleSchema.optional(),
  status: agentApiSessionStatusSchema.optional(),
  limit: agentApiPageLimitSchema.default(AGENT_API_LIMITS.defaultPageLimit),
  cursor: agentApiOpaqueTokenSchema.optional(),
});
export const agentApiRunListQuerySchema = z.object({
  status: agentApiRunStatusSchema.optional(),
  phase: agentApiRunPhaseSchema.optional(),
  limit: agentApiPageLimitSchema.default(AGENT_API_LIMITS.defaultPageLimit),
  cursor: agentApiOpaqueTokenSchema.optional(),
});
export const agentApiPageQuerySchema = z.object({
  limit: agentApiPageLimitSchema.default(AGENT_API_LIMITS.defaultPageLimit),
  cursor: agentApiOpaqueTokenSchema.optional(),
});
export const agentApiWaitQuerySchema = z.object({
  timeout_ms: agentApiWaitMillisecondsSchema.default(0),
});
export const agentApiStreamQuerySchema = z.object({
  channels: sseChannelsSchema.default([...AGENT_API_SSE_CHANNELS]),
});
export const agentApiMutationHeadersSchema = z.object({
  idempotency_key: agentApiIdempotencyKeySchema,
  if_match: agentApiEtagSchema.optional(),
});

export const agentApiCreateSessionRequestSchema = z.object({
  schema: z.literal('kite.agent-api.create-session.v1'),
  display_name: agentApiShortTextSchema.optional(),
});
export const agentApiResumeSessionRequestSchema = z.object({
  schema: z.literal('kite.agent-api.resume-session.v1'),
  after_revision: agentApiRevisionSchema,
});
export const agentApiCloseSessionRequestSchema = z.object({
  schema: z.literal('kite.agent-api.close-session.v1'),
});
export const agentApiCancelRunRequestSchema = z.object({
  schema: z.literal('kite.agent-api.cancel-run.v1'),
});
export const agentApiCreateRunRequestSchema = z.object({
  schema: z.literal('kite.agent-api.create-run.v1'),
  input: agentApiRunInputSchema,
  phase: agentApiRunPhaseSchema,
  initial_skills: z
    .array(
      z.object({
        skill_id: agentApiIdentifierSchema,
        input: agentApiJsonObjectSchema,
      }),
    )
    .max(AGENT_API_LIMITS.maxInitialSkills)
    .optional(),
});
export const agentApiRewindSessionRequestSchema = z.object({
  schema: z.literal('kite.agent-api.rewind-session.v1'),
  checkpoint_id: agentApiIdentifierSchema,
});
export const agentApiForkSessionRequestSchema = z.object({
  schema: z.literal('kite.agent-api.fork-session.v1'),
  checkpoint_id: agentApiIdentifierSchema,
  display_name: agentApiShortTextSchema.optional(),
});

const approvalResponseSchema = z.object({
  kind: z.literal('approval'),
  decision: z.enum(['approve_once', 'same_command', 'reject']),
});
const inputResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), value: boundedText(8_192, { minimumBytes: 1 }) }),
  z.object({ kind: z.literal('input_cancel') }),
]);
const planReviewResponseSchema = z.object({
  kind: z.literal('plan_review'),
  decision: z.enum(['auto', 'accept_edits', 'feedback', 'cancel']),
  feedback: agentApiDetailTextSchema.optional(),
});
const providerActionResponseSchema = z.object({
  kind: z.literal('provider_action'),
  outcome: z.enum(['completed', 'deferred', 'cancelled']),
  detail: agentApiDetailTextSchema.optional(),
});
const verificationResponseSchema = z.object({
  kind: z.literal('verification'),
  decision: z.enum(['replan', 'waive', 'compensate']),
  detail: agentApiDetailTextSchema,
});

export const agentApiInteractionResponseRequestSchema = z.union([
  z.object({
    schema: z.literal('kite.agent-api.interaction-response.v1'),
    interaction: agentApiApprovalInteractionSchema,
    response: approvalResponseSchema,
  }),
  z.object({
    schema: z.literal('kite.agent-api.interaction-response.v1'),
    interaction: agentApiInputInteractionSchema,
    response: inputResponseSchema,
  }),
  z.object({
    schema: z.literal('kite.agent-api.interaction-response.v1'),
    interaction: agentApiPlanReviewInteractionSchema,
    response: planReviewResponseSchema,
  }),
  z.object({
    schema: z.literal('kite.agent-api.interaction-response.v1'),
    interaction: agentApiProviderActionInteractionSchema,
    response: providerActionResponseSchema,
  }),
  z.object({
    schema: z.literal('kite.agent-api.interaction-response.v1'),
    interaction: agentApiVerificationInteractionSchema,
    response: verificationResponseSchema,
  }),
]);

export type AgentApiCreateSessionRequest = z.infer<typeof agentApiCreateSessionRequestSchema>;
export type AgentApiResumeSessionRequest = z.infer<typeof agentApiResumeSessionRequestSchema>;
export type AgentApiCreateRunRequest = z.infer<typeof agentApiCreateRunRequestSchema>;
export type AgentApiInteractionResponseRequest = z.infer<
  typeof agentApiInteractionResponseRequestSchema
>;
