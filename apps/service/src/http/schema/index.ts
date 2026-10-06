import { z } from 'zod';
import {
  FileCheckpointArtifactSchema,
  FileCheckpointBaselineSchema,
  FileCheckpointBoundarySchema,
  FileCheckpointDetailSchema,
  FileCheckpointListQuerySchema,
  FileCheckpointPageSchema,
  FileCheckpointRecoveryBoundarySchema,
  FileCheckpointRestoreJournalSchema,
  FileCheckpointSchema,
  FileRestoreStatusSchema,
} from './file-checkpoints';
import { HostStatusQuerySchema, HostStatusSchema } from './host-status';
import {
  BrowserSessionLogQuerySchema,
  SessionLogDetailsSchema,
  SessionLogEntrySchema,
  SessionLogPageSchema,
  SessionLogQuerySchema,
} from './session-logs';
import { SkillCataloguePageSchema, SkillCatalogueQuerySchema } from './skill-catalogue';

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const definitionId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.-]+$/);
const sequence = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const json = z.json();
const additionalInputContent = z
  .string()
  .min(1)
  .max(1048576)
  .refine(
    (content) =>
      content.trim().length > 0 && new TextEncoder().encode(content).byteLength <= 1048576,
  );
const steerInput = z.strictObject({
  kind: z.literal('input.steer'),
  content: additionalInputContent,
  targetRunId: id,
  contextSelectionId: id,
});
const extensionInputs = z.array(
  z.strictObject({
    extensionId: definitionId,
    definitionVersion: z.string().min(1).max(128),
    input: json,
  }),
);
const selectedSkills = z.array(z.string().min(1).max(128)).max(256);
const followUpInput = z.strictObject({
  kind: z.literal('input.follow_up'),
  content: additionalInputContent,
  afterRunId: id.nullable(),
  contextSelectionId: id,
  modelId: z.string().min(1).max(256).optional(),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  selectedSkills: selectedSkills.optional(),
  extensionInputs: extensionInputs.optional(),
});
const interactionAnswer = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('approval'),
    decision: z.enum(['approve', 'deny']),
    grant: z.enum(['approve_once', 'same_command']).optional(),
  }),
  z.strictObject({ kind: z.literal('question'), answers: json }),
  z.strictObject({
    kind: z.literal('plan_review'),
    decision: z.enum(['approve', 'deny', 'revise']),
    feedback: z.string().max(8192).optional(),
    mode: z.string().max(128).optional(),
  }),
]);
const interaction = z.object({
  id,
  originStoreId: id,
  sessionId: id,
  runId: id.nullable(),
  executionId: id,
  attempt: z.number().int().min(1),
  presentationSessionId: id,
  ancestry: z.array(id),
  kind: z.enum(['approval', 'question', 'plan_review']),
  definitionId: z.string().min(1).max(512),
  definitionVersion: z.string().min(1),
  inputDigest: z.string(),
  policyRevision: z.string(),
  requiredRefs: z.array(
    z.object({
      extensionId: z.string().min(1).max(128),
      definitionVersion: z.string(),
      requirementId: z.string().min(1).max(512),
      revision: sequence,
      phase: z.enum(['dispatch', 'completion', 'both']),
      sessionId: id,
      runId: id,
      executionId: id.optional(),
      attempt: z.number().int().optional(),
      recordKey: z.string(),
    }),
  ),
  request: json,
  answer: interactionAnswer.nullable(),
  revision: sequence,
  acceptedDecisionRevision: sequence.nullable(),
  state: z.enum(['pending', 'answered', 'cancelled']),
});
const runStatus = z.enum([
  'running',
  'waiting_interaction',
  'waiting_execution',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
const toolCall = z.object({ id, name: z.string(), arguments: z.string() });
const lifecycleProfile = z.strictObject({
  dataRoot: z.string().min(1).max(8192),
  name: z.string().min(1).max(64),
  accessKey: z.string().min(1).max(256),
});
const serviceLifecycle = z.strictObject({
  lifecycleVersion: z.literal(1),
  profile: lifecycleProfile,
  instanceId: id,
  buildId: z.string().min(1).max(256),
  apiMajor: z.number().int().min(1).max(2147483647),
  capabilities: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,127}$/)).max(64),
  dataAvailability: z.enum(['available', 'unavailable']),
  state: z.enum(['accepting', 'draining', 'closed', 'drain_failed']),
  busy: z.boolean(),
  reasons: z.array(z.enum(['admission', 'dispatch', 'execution', 'background', 'cleanup'])).max(5),
});
const serverIdentity = z.object({
  subjectId: z.string().min(1).max(256).optional(),
  instanceId: id,
  buildId: z.string().min(1),
  apiMajor: z.number().int(),
  capabilities: z.array(z.string()),
  profile: z.object({ dataRoot: z.string(), name: z.string(), accessKey: z.string() }),
});
const executionOutputRecord = z.object({
  executionId: id,
  seq: sequence,
  throughSeq: sequence,
  stream: z.enum(['stdout', 'stderr', 'progress']),
  content: z.string(),
  droppedBytes: sequence.nullable(),
});
const executionStatus = z.enum([
  'planned',
  'dispatching',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'outcome_unknown',
]);
const modelInputItem = z.object({
  seq: sequence,
  executionId: id,
  sessionId: id,
  runId: id,
  originCommandId: id,
  rootWorkCommandId: id,
  rootWorkSeq: sequence,
  attempt: z.number().int().min(1),
  status: executionStatus,
  confirmation: z.enum(['succeeded', 'unconfirmed']),
  modelId: z.string().min(1),
});
const modelRequest = z.object({
  modelId: z.string().min(1),
  requestId: id,
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant', 'tool']),
      content: z.string(),
      toolCalls: z.array(toolCall).optional(),
      toolCallId: z.string().optional(),
      sourceIds: z.array(z.string()).optional(),
    }),
  ),
  tools: z.array(
    z.object({
      id: z.string().min(1),
      definitionVersion: z.string().min(1),
      description: z.string().optional(),
      inputSchema: z.record(z.string(), json),
    }),
  ),
});

const etag = z.string().regex(/^[a-f0-9]{64}$/);
const modelAdapterMetadata = z.discriminatedUnion('availability', [
  z.object({
    availability: z.literal('available'),
    adapterId: z.string(),
    adapterVersion: z.string(),
    provider: z.discriminatedUnion('availability', [
      z.object({ availability: z.literal('available'), family: z.string(), modelId: z.string() }),
      z.object({ availability: z.literal('unavailable'), reason: z.string() }),
    ]),
    settings: z.object({
      temperature: z.number().optional(),
      topP: z.number().optional(),
      maxOutputTokens: z.number().optional(),
      reasoningEffort: z
        .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
        .optional(),
      maxRetries: z.number().int().min(0),
      maxSteps: z.number().int().min(1),
      allowSystemInMessages: z.boolean(),
      includeUsage: z.boolean().optional(),
    }),
    transformation: z.object({ id: z.string(), version: z.string() }),
  }),
  z.object({ availability: z.literal('unavailable'), reason: z.literal('adapter_opaque') }),
]);
const modelAuthorizationMetadata = z.discriminatedUnion('availability', [
  z.object({ availability: z.literal('unavailable'), reason: z.literal('not_dispatched') }),
  z.object({
    availability: z.literal('available'),
    allowed: z.literal(true),
    revision: z.string(),
    definitionVersion: z.string(),
    inputDigest: etag,
    controlReads: z
      .array(
        z.object({
          kind: z.enum(['permission.mode', 'workspace.trust']),
          scope: z.string(),
          revision: sequence,
        }),
      )
      .max(3)
      .optional(),
    policy: z.object({ namespace: z.string(), version: z.string(), data: json }).nullable(),
  }),
]);
const modelInputMetadata = z.union([
  z.object({
    version: z.literal(1),
    adapter: modelAdapterMetadata,
    assembly: z.object({
      extensions: z.array(z.object({ id: z.string(), version: z.string() })),
      tools: z.array(
        z.object({ id: z.string(), definitionVersion: z.string(), extensionId: z.string() }),
      ),
      capabilitySnapshotDigest: etag.nullable(),
    }),
    context: z.object({
      transformationId: z.literal('kite.model-request'),
      transformationVersion: z.literal('1'),
      messageOrder: z.literal('request.messages'),
      sourceOrder: z.literal('request.messages[].sourceIds'),
      sources: z.array(z.object({ id: z.string(), digest: z.string() })),
    }),
    authorization: modelAuthorizationMetadata,
  }),
  z.object({
    version: z.literal(1),
    adapter: z.object({
      availability: z.literal('unavailable'),
      reason: z.enum(['not_recorded', 'unsupported_version']),
    }),
    assembly: z.null(),
    context: z.null(),
    authorization: modelAuthorizationMetadata,
  }),
]);
const permissionMode = z.enum(['ask', 'accept_edits', 'auto', 'full']);
const permissionFailure = z.strictObject({
  status: z.enum(['failed', 'outcome_unknown']),
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,127}$/)
    .optional(),
});
function permissionMutation<
  K extends 'permission.mode' | 'workspace.trust' | 'permission.grants.clear',
  T extends z.ZodType,
>(kind: K, applied: T) {
  const identity = { commandId: id, kind: z.literal(kind) };
  return z.discriminatedUnion('state', [
    z.object({ ...identity, state: z.literal('pending'), receipt: z.strictObject({}) }),
    z.object({ ...identity, state: z.literal('applied'), receipt: applied }),
    z.object({
      ...identity,
      state: z.literal('failed'),
      receipt: permissionFailure.extend({ status: z.literal('failed') }),
    }),
    z.object({
      ...identity,
      state: z.literal('outcome_unknown'),
      receipt: permissionFailure.extend({ status: z.literal('outcome_unknown') }),
    }),
  ]);
}
const opaqueCredentialRef = z.string().regex(/^credential:[0-9a-f-]{36}$/);
const configurationEdit = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('set'),
    path: z
      .array(
        z.union([
          z
            .string()
            .min(1)
            .max(128)
            // biome-ignore lint/suspicious/noControlCharactersInRegex: Configuration property names must reject control characters.
            .regex(/^(?!(?:__proto__|constructor|prototype)$)[^\u0000-\u001f\u007f]+$/),
          z.number().int().min(0).max(4096),
        ]),
      )
      .min(1)
      .max(32),
    value: json,
  }),
  z.strictObject({
    kind: z.literal('remove'),
    path: z
      .array(
        z.union([
          z
            .string()
            .min(1)
            .max(128)
            // biome-ignore lint/suspicious/noControlCharactersInRegex: Configuration property names must reject control characters.
            .regex(/^(?!(?:__proto__|constructor|prototype)$)[^\u0000-\u001f\u007f]+$/),
          z.number().int().min(0).max(4096),
        ]),
      )
      .min(1)
      .max(32),
  }),
]);

const modelSettingsReadSet = z.strictObject({
  userEtag: etag,
  workspaceEtag: etag.nullable(),
  explicitDigest: etag,
  effectiveDigest: etag,
});
const modelSettingsOperation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('enabled'), modelId: definitionId, enabled: z.boolean() }),
  z.strictObject({ kind: z.literal('default'), modelId: definitionId }),
  z.strictObject({
    kind: z.literal('effort'),
    modelId: definitionId,
    reasoningEffort: z
      .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
      .nullable(),
  }),
]);
const modelSettingsMarker = z.strictObject({
  expectedReadSet: modelSettingsReadSet,
  operation: modelSettingsOperation,
});
const providerSettingsOperation = z.strictObject({
  provider: z.enum(['openai', 'deepseek', 'compatible', 'ollama']),
  connectionId: etag.nullable(),
  baseURL: z.string().min(1).max(4096),
  modelNames: z.array(z.string().min(1).max(256)),
  credential: z.enum(['keep', 'replace', 'none']),
});
const providerSettingsMarker = z.strictObject({
  expectedReadSet: modelSettingsReadSet,
  operation: providerSettingsOperation,
});
export const schemas = {
  ModelInputMetadata: modelInputMetadata,
  PermissionControlQuery: z.strictObject({ storeId: id }),
  PermissionModeState: z.object({
    storeId: id,
    sessionId: id,
    scopeSessionId: id,
    mode: permissionMode,
    revision: sequence,
    defaultMode: permissionMode,
    defaultRevision: sequence,
  }),
  WorkspaceTrustState: z.object({
    storeId: id,
    workspaceId: id,
    status: z.enum(['trusted', 'untrusted', 'scope_changed']),
    trusted: z.boolean(),
    revision: sequence,
    canonicalIdentity: etag,
    externalReadScopeDigest: etag,
    readScopes: z
      .array(z.object({ kind: definitionId, description: z.string().min(1).max(2048) }))
      .min(1)
      .max(16),
  }),
  SetPermissionModeRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    mode: permissionMode,
    ifRevision: sequence,
    makeDefault: z.boolean(),
    ifDefaultRevision: sequence,
  }),
  SetWorkspaceTrustRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    canonicalIdentity: etag,
    externalReadScopeDigest: etag,
    trusted: z.boolean(),
    ifRevision: sequence,
  }),
  PermissionGrantQuery: z.strictObject({
    storeId: id,
    afterSeq: sequence.optional(),
    upperSeq: sequence.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  PermissionGrantPage: z.object({
    storeId: id,
    sessionId: id,
    revision: sequence,
    items: z
      .array(
        z.object({
          seq: sequence,
          grant: z.object({
            id,
            originStoreId: id,
            sessionId: id,
            workspaceId: id,
            kind: z.enum(['tool', 'job']),
            definitionId: z.string().min(1).max(512),
            definitionVersion: z.string().min(1).max(128),
            inputDigest: etag,
            commandDigest: etag.optional(),
            interactionId: id,
            decisionRevision: sequence,
            executionId: id,
          }),
        }),
      )
      .max(200),
    highWaterSeq: sequence,
    upperSeq: sequence,
    nextAfterSeq: sequence.nullable(),
    snapshotCursor: sequence,
  }),
  ClearPermissionGrantsRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    ifRevision: sequence,
  }),
  PermissionMutation: z.union([
    permissionMutation(
      'permission.mode',
      z.strictObject({
        status: z.literal('applied'),
        mode: permissionMode,
        revision: sequence,
        makeDefault: z.boolean(),
        defaultRevision: sequence,
      }),
    ),
    permissionMutation(
      'workspace.trust',
      z.strictObject({
        status: z.literal('applied'),
        trusted: z.boolean(),
        revision: sequence,
        canonicalIdentity: etag,
        externalReadScopeDigest: etag,
      }),
    ),
    permissionMutation(
      'permission.grants.clear',
      z.strictObject({
        status: z.literal('applied'),
        sessionId: id,
        revision: sequence,
      }),
    ),
  ]),
  ModelInputQuery: z.strictObject({
    storeId: id,
    afterSeq: sequence.optional(),
    upperSeq: sequence.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  ModelInputPage: z.object({
    storeId: id,
    sessionId: id,
    rootSessionId: id,
    items: z.array(modelInputItem).max(200),
    highWaterSeq: sequence,
    upperSeq: sequence,
    nextAfterSeq: sequence.nullable(),
    snapshotCursor: sequence,
  }),
  ModelInputSnapshot: z.object({
    storeId: id,
    sessionId: id,
    rootSessionId: id,
    runId: id,
    executionId: id,
    originCommandId: id,
    rootWorkCommandId: id,
    rootWorkSeq: sequence,
    attempt: z.number().int().min(1),
    status: executionStatus,
    confirmation: z.enum(['succeeded', 'unconfirmed']),
    bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
    bodyBytes: sequence,
    snapshotCursor: sequence,
    request: modelRequest,
    metadata: modelInputMetadata,
  }),
  ModelOutputQuery: z.strictObject({ storeId: id }),
  ModelOutputSnapshot: z.object({
    storeId: id,
    sessionId: id,
    rootSessionId: id,
    runId: id,
    executionId: id,
    originCommandId: id,
    rootWorkCommandId: id,
    rootWorkSeq: sequence,
    attempt: z.number().int().min(1),
    status: executionStatus,
    bodyHash: etag,
    bodyBytes: sequence,
    contentBytes: sequence,
    reasoningBytes: sequence,
    snapshotCursor: sequence,
    output: z.object({
      content: z.string(),
      reasoning: z.string(),
      toolCalls: z.array(toolCall),
      complete: z.boolean(),
    }),
  }),
  ContextSelection: z.object({
    id,
    sessionId: id,
    previousSelectionId: id.nullable(),
    boundaryMessageId: id.nullable(),
    boundarySeq: sequence,
    tailFromSeq: sequence,
    ranges: z.array(z.object({ afterSeq: sequence, throughSeq: sequence })),
  }),
  ResultContextSource: z.object({
    id,
    seq: sequence,
    sessionId: id,
    createdSelectionId: id,
    executionId: id,
    resultRevision: sequence,
    originStoreId: id,
    inclusion: z.enum(['automatic', 'explicit']),
    result: json,
  }),
  ContextQuery: z.strictObject({
    storeId: id,
    contextSelectionId: id.optional(),
    afterSeq: sequence.optional(),
    upperSeq: sequence.optional(),
    messageLimit: z.number().int().min(1).max(200).optional(),
    afterSourceId: id.optional(),
    sourceLimit: z.number().int().min(1).max(100).optional(),
    byteLimit: z
      .number()
      .int()
      .min(1024)
      .max(8 * 1024 * 1024)
      .optional(),
  }),
  SelectContextRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    expectedContextSelectionId: id,
    boundary: z.strictObject({ messageId: id, seq: sequence }).nullable(),
  }),
  ForkSessionRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    expectedContextSelectionId: id,
    boundary: z.strictObject({ messageId: id, seq: sequence }).nullable().optional(),
    newSessionId: id,
    title: z.string().min(1).max(512),
  }),
  RenameSessionRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    ifRevision: sequence,
    title: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => value.trim().length > 0),
  }),
  DeleteSessionRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    ifRevision: sequence,
  }),
  CompressContextRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    expectedContextSelectionId: id,
    focus: z.string().optional(),
  }),
  ResetCompressionRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    expectedContextSelectionId: id,
    expectedCompressionId: id.nullable(),
  }),
  CompressionRecord: z.object({
    id,
    originSessionId: id,
    originCompressionId: id,
    sessionId: id,
    contextSelectionId: id,
    originStoreId: id,
    modelExecutionId: id,
    runId: id,
    coveredThroughSeq: sequence,
    publishedSeq: sequence,
    previousCompressionId: id.nullable(),
    compressor: z.object({
      id: z.string().min(1).max(128),
      version: z.string().min(1).max(128),
      snapshot: json,
    }),
    trigger: z.enum(['manual', 'automatic']),
  }),
  IncludeResultRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    expectedContextSelectionId: id,
    resultRevision: sequence,
    targetRunId: id.optional(),
  }),
  SteerCommandRequest: steerInput.extend({ expectedStoreId: id, commandId: id }),
  FollowUpCommandRequest: followUpInput.extend({ expectedStoreId: id, commandId: id }),
  InputListQuery: z.strictObject({
    storeId: id,
    kind: z.enum(['input.steer', 'input.follow_up']).optional(),
    targetRunId: id.optional(),
    afterSeq: sequence.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  Interaction: interaction,
  InteractionPage: z.object({
    interactions: z.array(interaction),
    nextAfterId: id.nullable(),
    snapshotCursor: sequence,
  }),
  AnswerInteractionRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    expectedRevision: sequence,
    answer: interactionAnswer,
  }),
  InteractionListQuery: z.strictObject({
    storeId: id,
    afterId: id.optional(),
    limit: z.number().int().min(1).max(100).optional(),
    state: z.enum(['pending', 'answered', 'cancelled']).optional(),
  }),
  ModelSettingsView: z.object({
    storeId: id,
    scope: z.enum(['user', 'workspace']),
    workspaceId: id.optional(),
    readSet: modelSettingsReadSet.nullable(),
    defaultModelId: definitionId.nullable(),
    models: z.array(
      z.object({
        id: definitionId,
        enabled: z.boolean(),
        configured: z.boolean(),
        provider: z.string().optional(),
        model: z.string().optional(),
        reasoningEffort: z
          .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
          .nullable()
          .optional(),
        reasoningEffortChoices: z
          .array(z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']))
          .max(7)
          .optional(),
        reasoningEffortSupport: z.enum(['compatible_wire', 'unsupported']).optional(),
        reasoningEffortReadonlyReason: z
          .enum(['model_settings_override', 'model_reasoning_effort_unsupported'])
          .nullable()
          .optional(),
        diagnostics: z.array(z.string().regex(/^[a-z0-9_]{1,128}$/)),
      }),
    ),
    errors: z.array(z.string().regex(/^[a-z0-9_]{1,128}$/)),
  }),
  ModelSettingsRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    workspaceId: id.optional(),
    expectedReadSet: modelSettingsReadSet,
    operation: modelSettingsOperation,
  }),
  ProviderSettingsView: z.object({
    storeId: id,
    readSet: modelSettingsReadSet.nullable(),
    providers: z
      .array(
        z.object({
          id: z.enum(['openai', 'deepseek', 'compatible', 'ollama']),
          label: z.string(),
          defaultBaseURL: z.string(),
          requiresCredential: z.boolean(),
          connections: z.array(
            z.object({
              id: etag,
              baseURL: z.string(),
              hasCredential: z.boolean(),
              modelNames: z.array(z.string()),
              canWrite: z.boolean(),
            }),
          ),
        }),
      )
      .length(4),
    errors: z.array(z.string().regex(/^[a-z0-9_]{1,128}$/)),
  }),
  ProviderSettingsRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    expectedReadSet: modelSettingsReadSet,
    operation: providerSettingsOperation,
    secret: z.string().min(1).max(65536).optional(),
  }),
  ConfigurationReadQuery: z.strictObject({ storeId: id.optional(), workspaceId: id.optional() }),
  HostMutationQuery: z.strictObject({ storeId: id }),
  ConfigurationView: z.object({
    storeId: id.optional(),
    scope: z.enum(['user', 'workspace']),
    workspaceId: id.optional(),
    etag,
    raw: json.nullable(),
    effective: json.nullable(),
    snapshot: json.nullable(),
    errors: z.array(z.string()).max(32),
  }),
  ConfigurationPatchRequest: z.strictObject({
    commandId: id,
    expectedStoreId: id,
    ifMatch: etag,
    workspaceId: id.optional(),
    operations: z.array(configurationEdit).min(1).max(64),
  }),
  ConfigurationRepairRequest: z.strictObject({
    commandId: id,
    expectedStoreId: id,
    ifMatch: etag,
    workspaceId: id.optional(),
    value: z.record(z.string(), json),
  }),
  CredentialPutRequest: z.strictObject({
    commandId: id,
    expectedStoreId: id,
    secret: z.string().min(1).max(65536),
  }),
  CredentialRevokeRequest: z.strictObject({ commandId: id, expectedStoreId: id }),
  HostMutation: z.object({
    commandId: id,
    originStoreId: id,
    scope: z.enum(['user', 'workspace']),
    workspaceId: id.optional(),
    ifMatch: etag.optional(),
    kind: z.enum([
      'config.patch',
      'config.repair',
      'credential.put',
      'credential.revoke',
      'model_settings.update',
      'provider_settings.update',
    ]),
    modelSettings: modelSettingsMarker.optional(),
    providerSettings: providerSettingsMarker.optional(),
    state: z.enum(['pending', 'applied', 'failed', 'outcome_unknown']),
    receipt: z.union([
      z.strictObject({}),
      z.strictObject({ status: z.literal('applied'), etag }),
      z.strictObject({
        status: z.literal('applied'),
        etag,
        credentialState: z.enum(['unchanged', 'stored']),
        configurationState: z.literal('published'),
        opaqueRef: opaqueCredentialRef.optional(),
      }),
      z.strictObject({
        status: z.literal('applied'),
        opaqueRef: opaqueCredentialRef,
        persistence: z.enum(['os', 'temporary']),
      }),
      z.strictObject({
        status: z.enum(['failed', 'outcome_unknown']),
        code: z.string().regex(/^[a-z0-9_]{1,128}$/),
      }),
      z.strictObject({
        status: z.enum(['failed', 'outcome_unknown']),
        code: z.string().regex(/^[a-z0-9_]{1,128}$/),
        credentialState: z.enum(['unchanged', 'stored', 'outcome_unknown']),
        configurationState: z.enum(['not_attempted', 'outcome_unknown']),
        opaqueRef: opaqueCredentialRef.optional(),
      }),
    ]),
  }),
  ServiceLifecycle: serviceLifecycle,
  ShutdownServiceRequest: z.strictObject({
    lifecycleVersion: z.literal(1),
    expectedProfile: lifecycleProfile,
    expectedInstanceId: id,
    mode: z.enum(['if_idle', 'cancel']),
  }),
  ShutdownServiceResponse: z.strictObject({
    lifecycleVersion: z.literal(1),
    accepted: z.literal(true),
    lifecycle: serviceLifecycle,
  }),
  ServerInfo: z.discriminatedUnion('dataAvailability', [
    serverIdentity.extend({ dataAvailability: z.literal('available'), storeId: id }),
    serverIdentity.extend({ dataAvailability: z.literal('unavailable'), storeId: id.optional() }),
  ]),
  Problem: z.object({
    code: z.string(),
    message: z.string(),
    scope: z.string(),
    resourceId: z.string().optional(),
    requestId: id,
    retryable: z.boolean(),
    outcome: z.string().optional(),
  }),
  Workspace: z.object({ id, rootUri: z.string(), name: z.string() }),
  Session: z.object({
    id,
    workspaceId: id,
    parentSessionId: id.nullable(),
    rootSessionId: id.optional(),
    title: z.string(),
    controlRevision: sequence,
    contextSelectionId: id,
    nextSeq: sequence,
    deletedAt: z.number().nullable(),
  }),
  Command: z.object({
    id,
    sessionId: id,
    kind: z.string(),
    status: z.enum(['accepted', 'applied', 'rejected', 'needs_review']),
    receipt: json,
    dispatchFailure: z.object({ code: id, instanceId: id }).optional(),
    originStoreId: id,
    subjectId: z.string().min(1).max(256).optional(),
    requestDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    cancelRequestedAt: z.number().nullable(),
  }),
  Run: z.object({
    id,
    sessionId: id,
    originCommandId: id,
    originStoreId: id,
    status: runStatus,
    isActive: z.boolean(),
    waitingForResults: z.array(id).max(64).optional(),
    configuration: json.optional(),
    createdAt: z.number(),
    finishedAt: z.number().nullable(),
    reason: z.string().nullable(),
  }),
  Execution: z.object({
    id,
    originStoreId: id.optional(),
    childSessionId: id.nullable().optional(),
    parentExecutionId: id.nullable().optional(),
    cancelWithParent: z.boolean().optional(),
    sessionId: id,
    runId: id.nullable(),
    kind: z.enum(['model', 'tool', 'job']),
    definitionId: z.string(),
    definitionVersion: z.string(),
    status: executionStatus,
    result: json,
    resultRevision: sequence,
    cancelRequestedAt: z.number().nullable(),
    delivery: z.enum(['pending', 'consumed', 'suppressed']).nullable().optional(),
    deliveryReason: z.string().nullable().optional(),
  }),
  ExecutionOutputRecord: executionOutputRecord,
  ExecutionOutputPage: z.object({ items: z.array(executionOutputRecord), highWaterSeq: sequence }),
  Message: z.object({
    id,
    sessionId: id,
    runId: id.nullable(),
    seq: sequence,
    status: z.enum(['complete', 'incomplete']),
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string(),
    originMessage: z
      .object({
        storeId: id,
        sessionId: id,
        messageId: id,
        runId: id.nullable(),
      })
      .optional(),
    contentFormat: z.literal('unsupported').optional(),
    outputBody: z
      .object({
        kind: z.literal('model_output'),
        executionId: id,
        complete: z.boolean(),
        contentBytes: sequence,
        reasoningBytes: sequence,
        toolCallCount: z.number().int().nonnegative(),
        readAvailability: z.literal('unsupported').optional(),
      })
      .optional(),
    toolCalls: z.array(toolCall).optional(),
    toolCallId: z.string().optional(),
    sourceIds: z.array(z.string()).optional(),
    originCommandId: id.optional(),
    contextSelectionId: id.optional(),
    inputKind: z.enum(['input.steer', 'input.follow_up', 'result.include']).optional(),
  }),
  Change: z.object({
    cursor: sequence,
    sessionId: id.nullable(),
    // A durable notification may name an extension namespace and its opaque record key.
    // Store admits 128 characters for the namespace, one separator and a 256-character key.
    objectId: z.string().min(1).max(385),
    type: z.string(),
    revision: sequence,
    payload: json,
  }),
  StreamReady: z.object({ storeId: id, replayFloor: sequence, highWaterCursor: sequence }),
  StreamCheckpoint: z.object({ storeId: id, cursor: sequence }),
  PublicAction: z.object({
    actionId: definitionId,
    definitionVersion: z.string(),
    label: z.string(),
    input: json,
  }),
  ArtifactRef: z.object({
    id,
    storeId: id.optional(),
    mediaType: z.string(),
    size: sequence,
    scope: z.object({ kind: z.enum(['session', 'execution', 'message']), id }).optional(),
  }),
  ArtifactContent: z.string(),
  CreateWorkspaceRequest: z.strictObject({
    expectedStoreId: id,
    id,
    rootUri: z.string().max(4096),
    name: z.string().max(512),
  }),
  CreateSessionRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    sessionId: id,
    workspaceId: id,
    title: z.string().max(512),
  }),
  ResumeRunRequest: z.strictObject({
    kind: z.literal('run.resume'),
    expectedStoreId: id,
    commandId: id,
    runId: id,
  }),
  ResumeRunTarget: z.strictObject({ sessionId: id }),
  RecoverSessionRequest: z.strictObject({
    kind: z.literal('session.recover'),
    expectedStoreId: id,
    commandId: id,
    decision: z.literal('interrupt'),
  }),
  RecoverSessionTarget: z.strictObject({ sessionId: id }),
  ReconcileJobRequest: z.strictObject({
    kind: z.literal('job.reconcile'),
    expectedStoreId: id,
    commandId: id,
    executionId: id,
    expectedResultRevision: sequence,
  }),
  ReconcileJobTarget: z.strictObject({ sessionId: id }),
  ResumeJobReportRequest: z.strictObject({ expectedStoreId: id, commandId: id }),
  ResumeJobReportTarget: z.strictObject({ sessionId: id, reportCommandId: id }),
  StartCommandRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    kind: z.literal('run.start'),
    content: z.string().max(262144),
    modelId: z.string().max(256).optional(),
    reasoningEffort: z
      .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
      .optional(),
    selectedSkills: selectedSkills.optional(),
    extensionInputs: extensionInputs.optional(),
  }),
  CancelCommandRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    kind: z.literal('command.cancel'),
    targetCommandId: id,
  }),
  CancelRunRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    kind: z.literal('run.cancel'),
    runId: id,
  }),
  CancelExecutionRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    kind: z.literal('execution.cancel'),
    executionId: id,
  }),
  CancelSessionRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    kind: z.literal('session.cancel'),
    includeBackground: z.boolean(),
  }),
  ExtensionCommandRequest: z.strictObject({
    expectedStoreId: id,
    commandId: id,
    kind: z.literal('extension.invoke'),
    extensionId: definitionId,
    actionId: definitionId,
    definitionVersion: z.string().max(256),
    input: json,
  }),
};
export const PublicViewSchema = z.object({
  extensionId: definitionId,
  contentType: z.string(),
  contentVersion: z.number().int().positive(),
  summary: z.string(),
  payload: json,
  artifactRefs: z.array(schemas.ArtifactRef),
  actions: z.array(schemas.PublicAction),
});
const descriptor = z.object({
  id: definitionId,
  version: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), json),
});
export const ExtensionCatalogueSchema = z.object({
  extensionId: definitionId,
  version: z.string(),
  actions: z.array(descriptor),
  queries: z.array(descriptor),
});
export const CommandRequestSchema = z.discriminatedUnion('kind', [
  schemas.SteerCommandRequest,
  schemas.FollowUpCommandRequest,
  schemas.StartCommandRequest,
  schemas.CancelCommandRequest,
  schemas.CancelRunRequest,
  schemas.CancelExecutionRequest,
  schemas.CancelSessionRequest,
  schemas.ExtensionCommandRequest,
  schemas.ReconcileJobRequest,
  schemas.ResumeRunRequest,
  schemas.RecoverSessionRequest,
]);
const reconciledToolResult = z.strictObject({
  outcome: z.enum(['succeeded', 'failed', 'cancelled']),
  content: z.string(),
  details: json.optional(),
  artifactRefs: z.array(schemas.ArtifactRef).optional(),
  modelContent: z
    .object({
      kind: z.literal('artifact'),
      reference: schemas.ArtifactRef,
      encoding: z.literal('utf-8'),
    })
    .optional(),
});
const reconcileReceipt = {
  executionId: id,
  resultRevision: sequence,
  evidence: json,
  reason: z.string().min(1).max(4096).nullable(),
  evidenceSource: z.literal('adapter_reconcile'),
};
const appliedJobReconcileCommand = schemas.Command.extend({
  kind: z.literal('job.reconcile'),
  status: z.literal('applied'),
  receipt: z.discriminatedUnion('outcome', [
    z.strictObject({
      ...reconcileReceipt,
      outcome: z.literal('verified'),
      supervision: z.literal('ended'),
      result: reconciledToolResult,
    }),
    z.strictObject({
      ...reconcileReceipt,
      outcome: z.literal('unresolved'),
      supervision: z.enum(['ended', 'running', 'unknown']),
      result: json,
    }),
  ]),
});
export const JobReconcileCommandSchema = z.discriminatedUnion('status', [
  schemas.Command.extend({
    kind: z.literal('job.reconcile'),
    status: z.literal('accepted'),
    receipt: z.null(),
  }),
  appliedJobReconcileCommand,
]);
export const ResumeRunResponseSchema = z.discriminatedUnion('status', [
  schemas.Command.extend({
    kind: z.literal('run.resume'),
    status: z.literal('accepted'),
    receipt: z.null(),
  }),
  schemas.Command.extend({
    kind: z.literal('run.resume'),
    status: z.literal('applied'),
    receipt: z.strictObject({
      outcome: z.literal('run_resumed'),
      runId: id,
      originalCommandId: id,
      boundary: z.enum(['before_model_dispatch', 'tool_calls', 'completion']),
    }),
  }),
]);
export const ResumeJobReportResponseSchema = schemas.Command.extend({
  kind: z.literal('job.report.resume'),
  status: z.literal('applied'),
  receipt: z.discriminatedUnion('outcome', [
    z.strictObject({ reportCommandId: id, runId: id, outcome: z.literal('report_resumed') }),
    z.strictObject({
      reportCommandId: id,
      runId: z.null(),
      outcome: z.literal('report_suppressed'),
      reason: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-z0-9_]+$/)
        .optional(),
    }),
  ]),
});
/** Recovery reports deliberately omit the private owner generations and leases. */
export const RecoverSessionResponseSchema = schemas.Command.extend({
  kind: z.literal('session.recover'),
  status: z.literal('applied'),
  receipt: z.strictObject({
    kind: z.literal('session_interrupted'),
    sessionId: id,
    storeId: id,
    interruptedRunIds: z.array(id).max(4096),
    settledExecutionIds: z.array(id).max(4096),
    // Original unknowns plus newly interrupted dispatches are independently bounded by Core.
    unknownExecutionIds: z.array(id).max(8192),
    cancelledExecutionIds: z.array(id).max(4096),
    partialMessageIds: z.array(id).max(4096),
    snapshotCursor: sequence,
  }),
});
export const PendingInputPageSchema = z.object({
  commands: z.array(
    schemas.Command.extend({
      seq: sequence,
      request: z.discriminatedUnion('kind', [steerInput, followUpInput]),
    }),
  ),
  nextAfterSeq: sequence.nullable(),
  snapshotCursor: sequence,
});
export const SessionViewSchema = z.object({
  session: schemas.Session,
  runs: z.array(schemas.Run),
  executions: z.array(schemas.Execution),
  messages: z.array(schemas.Message),
  snapshotCursor: sequence,
  storeId: id,
});
export const SelectedContextPageSchema = z.object({
  selection: schemas.ContextSelection,
  highWaterSeq: sequence,
  messages: z.array(schemas.Message),
  resultSources: z.array(schemas.ResultContextSource),
  nextAfterSeq: sequence.nullable(),
  nextAfterSourceId: id.nullable(),
  snapshotCursor: sequence,
  compression: schemas.CompressionRecord.optional(),
});
export const SelectContextResponseSchema = z.object({
  command: schemas.Command,
  selection: schemas.ContextSelection,
});
export const ForkSessionResponseSchema = z.object({
  command: schemas.Command,
  session: schemas.Session,
  selection: schemas.ContextSelection,
  omittedExtensionState: z.boolean(),
  namespaceReport: z
    .array(
      z.object({
        extensionId: definitionId,
        contentType: z.string().min(1).max(512),
        contentVersion: z.number().int().min(1),
        mode: z.enum(['copy', 'rebuild', 'omit']),
        ruleVersion: z.string().min(1).max(128).nullable(),
        copied: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        rebuilt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        omitted: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .optional(),
});
export const SessionMutationResponseSchema = z.object({
  command: schemas.Command,
  session: schemas.Session,
});
export const IncludeResultResponseSchema = z.object({
  command: schemas.Command,
  source: schemas.ResultContextSource,
});
/** Development Browser projection; no native profile path, configuration or credential authority. */
export const BrowserInfoSchema = z.object({
  instanceId: id,
  buildId: z.string().min(1).max(256),
  pageIdentity: z.string().regex(/^[0-9a-f]{64}$/),
  storeId: id.nullable(),
  dataAvailability: z.enum(['available', 'unavailable']),
  capabilities: z.array(
    z.enum([
      'workspaces',
      'sessions',
      'history',
      'context',
      'execution_output',
      'model_inputs',
      'model_outputs',
      'session_exports',
      'session_logs',
      'file_checkpoints',
    ]),
  ),
});
export const BrowserContextQuerySchema = schemas.ContextQuery.omit({ storeId: true });
export const BrowserModelInputQuerySchema = schemas.ModelInputQuery.omit({ storeId: true });
export const BrowserWorkspaceListSchema = z.array(schemas.Workspace.omit({ rootUri: true }));
export const BrowserSessionListSchema = z.array(schemas.Session);
export const BrowserViewSchema = z.object({
  session: schemas.Session,
  runs: z.array(schemas.Run.omit({ configuration: true })),
  executions: z.array(schemas.Execution.omit({ result: true })),
  snapshotCursor: sequence,
  storeId: id,
});
export const WorkspaceDirectoryQuerySchema = z.strictObject({
  storeId: id,
  afterSeq: sequence.optional(),
  upperSeq: sequence.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export const SessionDirectoryQuerySchema = WorkspaceDirectoryQuerySchema.extend({
  workspaceId: id.optional(),
});
export const BrowserWorkspaceDirectoryQuerySchema = WorkspaceDirectoryQuerySchema.omit({
  storeId: true,
});
export const BrowserSessionDirectoryQuerySchema = SessionDirectoryQuerySchema.omit({
  storeId: true,
});
const directoryHeader = {
  storeId: id,
  highWaterSeq: sequence,
  upperSeq: sequence,
  nextAfterSeq: sequence.nullable(),
  snapshotCursor: sequence,
};
export const WorkspaceDirectoryPageSchema = z.object({
  ...directoryHeader,
  items: z.array(z.object({ seq: sequence, workspace: schemas.Workspace })).max(200),
});
export const SessionDirectoryPageSchema = z.object({
  ...directoryHeader,
  items: z.array(z.object({ seq: sequence, session: schemas.Session })).max(200),
});
export const BrowserWorkspaceDirectoryPageSchema = z.object({
  ...directoryHeader,
  items: z
    .array(z.object({ seq: sequence, workspace: schemas.Workspace.omit({ rootUri: true }) }))
    .max(200),
});
const sessionExportSection = z.enum([
  'sessions',
  'commands',
  'runs',
  'messages',
  'message_parts',
  'executions',
  'execution_output',
  'interactions',
  'context_snapshots',
  'extension_records',
  'artifact_refs',
]);
const sessionExportManifestFields = {
  version: z.literal(1),
  storeId: id,
  rootSessionId: id,
  readInstanceId: id,
  snapshotCursor: sequence,
  dataVersion: sequence,
  sections: z
    .array(
      z.strictObject({ section: sessionExportSection, highWaterSeq: sequence, count: sequence }),
    )
    .length(11),
  excluded: z.array(z.string().min(1).max(128)).max(64),
  contentMedia: z.literal('sqlite-records-and-original-scope-artifact-references'),
};
export const SessionExportManifestSchema = z.object(sessionExportManifestFields);
const sessionExportManifestInput = z.strictObject(sessionExportManifestFields);
export const BeginSessionExportQuerySchema = z.strictObject({ storeId: id });
export const VerifySessionExportQuerySchema = BeginSessionExportQuerySchema.extend({
  manifest: sessionExportManifestInput,
});
export const SessionExportPageQuerySchema = VerifySessionExportQuerySchema.extend({
  section: sessionExportSection,
  afterSeq: sequence.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  byteLimit: z
    .number()
    .int()
    .min(1024)
    .max(8 * 1024 * 1024)
    .optional(),
});
export const SessionExportTextQuerySchema = VerifySessionExportQuerySchema.extend({
  section: sessionExportSection,
  seq: sequence,
  field: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
  afterByte: sequence.optional(),
  limitBytes: z.number().int().min(1).max(65536).optional(),
});
export const SessionExportPageSchema = z.object({
  storeId: id,
  rootSessionId: id,
  section: sessionExportSection,
  snapshotCursor: sequence,
  upperSeq: sequence,
  records: z
    .array(
      z.object({
        section: sessionExportSection,
        seq: sequence,
        sessionId: id,
        id: z.string().min(1),
        record: json,
      }),
    )
    .max(200),
  nextAfterSeq: sequence.nullable(),
});
export const SessionExportTextPageSchema = z.object({
  storeId: id,
  rootSessionId: id,
  section: sessionExportSection,
  seq: sequence,
  field: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
  afterByte: sequence,
  byteLength: sequence,
  contentBase64: z
    .string()
    .max(87384)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  nextAfterByte: sequence.nullable(),
});
export const SessionExportCompletionSchema = z.object({
  manifest: SessionExportManifestSchema,
  verified: z.literal(true),
  contentMedia: z.literal('sqlite-records-and-original-scope-artifact-references'),
});
export const apiSchemas = {
  FileCheckpointListQuery: FileCheckpointListQuerySchema,
  FileCheckpointBaseline: FileCheckpointBaselineSchema,
  FileCheckpointArtifact: FileCheckpointArtifactSchema,
  FileCheckpointBoundary: FileCheckpointBoundarySchema,
  FileCheckpoint: FileCheckpointSchema,
  FileCheckpointRestoreJournal: FileCheckpointRestoreJournalSchema,
  FileCheckpointPage: FileCheckpointPageSchema,
  FileCheckpointDetail: FileCheckpointDetailSchema,
  FileRestoreStatus: FileRestoreStatusSchema,
  FileCheckpointRecoveryBoundary: FileCheckpointRecoveryBoundarySchema,
  SessionLogQuery: SessionLogQuerySchema,
  BrowserSessionLogQuery: BrowserSessionLogQuerySchema,
  SessionLogDetails: SessionLogDetailsSchema,
  SessionLogEntry: SessionLogEntrySchema,
  SessionLogPage: SessionLogPageSchema,
  SkillCatalogueQuery: SkillCatalogueQuerySchema,
  SkillCataloguePage: SkillCataloguePageSchema,
  HostStatusQuery: HostStatusQuerySchema,
  HostStatus: HostStatusSchema,
  ...schemas,
  WorkspaceDirectoryQuery: WorkspaceDirectoryQuerySchema,
  SessionDirectoryQuery: SessionDirectoryQuerySchema,
  BrowserWorkspaceDirectoryQuery: BrowserWorkspaceDirectoryQuerySchema,
  BrowserSessionDirectoryQuery: BrowserSessionDirectoryQuerySchema,
  WorkspaceDirectoryPage: WorkspaceDirectoryPageSchema,
  SessionDirectoryPage: SessionDirectoryPageSchema,
  BrowserWorkspaceDirectoryPage: BrowserWorkspaceDirectoryPageSchema,
  BrowserInfo: BrowserInfoSchema,
  BrowserContextQuery: BrowserContextQuerySchema,
  BrowserModelInputQuery: BrowserModelInputQuerySchema,
  BrowserWorkspaceList: BrowserWorkspaceListSchema,
  BrowserSessionList: BrowserSessionListSchema,
  BrowserView: BrowserViewSchema,
  SelectedContextPage: SelectedContextPageSchema,
  SelectContextResponse: SelectContextResponseSchema,
  ForkSessionResponse: ForkSessionResponseSchema,
  SessionMutationResponse: SessionMutationResponseSchema,
  IncludeResultResponse: IncludeResultResponseSchema,
  PublicView: PublicViewSchema,
  QueryResponse: z.array(PublicViewSchema),
  ExtensionCatalogue: ExtensionCatalogueSchema,
  ExtensionList: z.array(ExtensionCatalogueSchema),
  WorkspaceList: z.array(schemas.Workspace),
  SessionList: z.array(schemas.Session),
  MessageList: z.array(schemas.Message),
  SessionView: SessionViewSchema,
  CommandRequest: CommandRequestSchema,
  ResumeJobReportResponse: ResumeJobReportResponseSchema,
  ResumeRunResponse: ResumeRunResponseSchema,
  RecoverSessionResponse: RecoverSessionResponseSchema,
  JobReconcileCommand: JobReconcileCommandSchema,
  PendingInputPage: PendingInputPageSchema,
  BeginSessionExportQuery: BeginSessionExportQuerySchema,
  SessionExportPageQuery: SessionExportPageQuerySchema,
  SessionExportTextQuery: SessionExportTextQuerySchema,
  VerifySessionExportQuery: VerifySessionExportQuerySchema,
  BrowserBeginSessionExportQuery: BeginSessionExportQuerySchema.omit({ storeId: true }),
  BrowserSessionExportPageQuery: SessionExportPageQuerySchema.omit({ storeId: true }),
  BrowserSessionExportTextQuery: SessionExportTextQuerySchema.omit({ storeId: true }),
  BrowserVerifySessionExportQuery: VerifySessionExportQuerySchema.omit({ storeId: true }),
  SessionExportManifest: SessionExportManifestSchema,
  SessionExportPage: SessionExportPageSchema,
  SessionExportTextPage: SessionExportTextPageSchema,
  SessionExportCompletion: SessionExportCompletionSchema,
};
export const apiRoutes = [
  {
    method: 'get',
    path: '/v1/config/user/providers',
    query: 'HostMutationQuery',
    response: 'ProviderSettingsView',
  },
  {
    method: 'post',
    path: '/v1/config/user/providers',
    request: 'ProviderSettingsRequest',
    response: 'HostMutation',
  },
  {
    method: 'get',
    path: '/v1/config/{scope}/models',
    query: 'ConfigurationReadQuery',
    response: 'ModelSettingsView',
  },
  {
    method: 'post',
    path: '/v1/config/{scope}/models',
    request: 'ModelSettingsRequest',
    response: 'HostMutation',
  },
  {
    method: 'get',
    path: '/v1/sessions/{id}/export/manifest',
    query: 'BeginSessionExportQuery',
    response: 'SessionExportManifest',
  },
  {
    method: 'get',
    path: '/v1/sessions/{id}/export/records',
    query: 'SessionExportPageQuery',
    response: 'SessionExportPage',
  },
  {
    method: 'get',
    path: '/v1/sessions/{id}/export/text',
    query: 'SessionExportTextQuery',
    response: 'SessionExportTextPage',
  },
  {
    method: 'get',
    path: '/v1/sessions/{id}/export/verify',
    query: 'VerifySessionExportQuery',
    response: 'SessionExportCompletion',
  },
  {
    method: 'get',
    path: '/v1/workspace-directory',
    query: 'WorkspaceDirectoryQuery',
    response: 'WorkspaceDirectoryPage',
  },
  {
    method: 'get',
    path: '/v1/session-directory',
    query: 'SessionDirectoryQuery',
    response: 'SessionDirectoryPage',
  },
  {
    method: 'get',
    path: '/v1/sessions/{id}/permission-mode',
    query: 'PermissionControlQuery',
    response: 'PermissionModeState',
  },
  {
    method: 'get',
    path: '/v1/sessions/{id}/permission-grants',
    query: 'PermissionGrantQuery',
    response: 'PermissionGrantPage',
  },
  {
    method: 'post',
    path: '/v1/sessions/{id}/permission-grants',
    request: 'ClearPermissionGrantsRequest',
    response: 'PermissionMutation',
  },
  {
    method: 'post',
    path: '/v1/sessions/{id}/permission-mode',
    request: 'SetPermissionModeRequest',
    response: 'PermissionMutation',
  },
  {
    method: 'get',
    path: '/v1/workspaces/{id}/trust',
    query: 'PermissionControlQuery',
    response: 'WorkspaceTrustState',
  },
  {
    method: 'post',
    path: '/v1/workspaces/{id}/trust',
    request: 'SetWorkspaceTrustRequest',
    response: 'PermissionMutation',
  },
  {
    method: 'get',
    path: '/v1/permissions/mutations/{id}',
    query: 'PermissionControlQuery',
    response: 'PermissionMutation',
  },
  {
    method: 'get',
    path: '/v1/sessions/{id}/logs',
    query: 'SessionLogQuery',
    response: 'SessionLogPage',
  },
  { method: 'get', path: '/v1/sessions/{id}/model-inputs', response: 'ModelInputPage' },
  {
    method: 'get',
    path: '/v1/sessions/{id}/executions/{executionId}/model-input',
    response: 'ModelInputSnapshot',
  },
  {
    method: 'get',
    path: '/v1/sessions/{id}/executions/{executionId}/model-output',
    query: 'ModelOutputQuery',
    response: 'ModelOutputSnapshot',
  },
  { method: 'get', path: '/v1/sessions/{id}/context', response: 'SelectedContextPage' },
  {
    method: 'post',
    path: '/v1/sessions/{id}/context/compress',
    request: 'CompressContextRequest',
    response: 'Command',
  },
  {
    method: 'post',
    path: '/v1/sessions/{id}/context/compression/reset',
    request: 'ResetCompressionRequest',
    response: 'Command',
  },
  {
    method: 'post',
    path: '/v1/sessions/{id}/context/select',
    request: 'SelectContextRequest',
    response: 'SelectContextResponse',
  },
  {
    method: 'post',
    path: '/v1/sessions/{id}/fork',
    request: 'ForkSessionRequest',
    response: 'ForkSessionResponse',
  },
  {
    method: 'post',
    path: '/v1/sessions/{id}/rename',
    request: 'RenameSessionRequest',
    response: 'SessionMutationResponse',
  },
  {
    method: 'post',
    path: '/v1/sessions/{id}/delete',
    request: 'DeleteSessionRequest',
    response: 'SessionMutationResponse',
  },
  {
    method: 'post',
    path: '/v1/sessions/{id}/results/{executionId}/include',
    request: 'IncludeResultRequest',
    response: 'IncludeResultResponse',
  },
  { method: 'get', path: '/v1/sessions/{id}/inputs', response: 'PendingInputPage' },
  { method: 'get', path: '/v1/events', response: 'Change', eventStream: true },
  { method: 'get', path: '/v1/sessions/{id}/interactions', response: 'InteractionPage' },
  {
    method: 'get',
    path: '/v1/sessions/{id}/interactions/{interactionId}',
    response: 'Interaction',
  },
  {
    method: 'post',
    path: '/v1/sessions/{id}/interactions/{interactionId}/answer',
    request: 'AnswerInteractionRequest',
    response: 'Command',
    statuses: [202],
  },
  {
    method: 'get',
    path: '/v1/sessions/{id}/artifacts/{refId}',
    response: 'ArtifactContent',
    binary: true,
  },
  {
    method: 'get',
    path: '/v1/config/{scope}',
    query: 'ConfigurationReadQuery',
    response: 'ConfigurationView',
  },
  {
    method: 'patch',
    path: '/v1/config/{scope}',
    request: 'ConfigurationPatchRequest',
    response: 'HostMutation',
  },
  {
    method: 'post',
    path: '/v1/config/{scope}/repair',
    request: 'ConfigurationRepairRequest',
    response: 'HostMutation',
  },
  {
    method: 'post',
    path: '/v1/credentials',
    request: 'CredentialPutRequest',
    response: 'HostMutation',
  },
  {
    method: 'post',
    path: '/v1/credentials/{opaqueRef}/revoke',
    request: 'CredentialRevokeRequest',
    response: 'HostMutation',
  },
  {
    method: 'get',
    path: '/v1/host-mutations/{id}',
    query: 'HostMutationQuery',
    response: 'HostMutation',
  },
  { method: 'get', path: '/v1/lifecycle', response: 'ServiceLifecycle' },
  {
    method: 'post',
    path: '/v1/lifecycle/shutdown',
    request: 'ShutdownServiceRequest',
    response: 'ShutdownServiceResponse',
    statuses: [202],
  },
  { method: 'get', path: '/v1/server', response: 'ServerInfo' },
  {
    method: 'get',
    path: '/v1/diagnostics/host-status',
    query: 'HostStatusQuery',
    response: 'HostStatus',
  },
  { method: 'get', path: '/v1/workspaces', response: 'WorkspaceList' },
  { method: 'get', path: '/v1/workspaces/{id}', response: 'Workspace' },
  {
    method: 'get',
    path: '/v1/workspaces/{id}/skills',
    query: 'SkillCatalogueQuery',
    response: 'SkillCataloguePage',
  },
  {
    method: 'post',
    path: '/v1/workspaces',
    request: 'CreateWorkspaceRequest',
    response: 'Workspace',
    statuses: [201],
  },
  {
    method: 'post',
    path: '/v1/sessions',
    request: 'CreateSessionRequest',
    response: 'Session',
    statuses: [201],
  },
  { method: 'get', path: '/v1/sessions', response: 'SessionList' },
  { method: 'get', path: '/v1/sessions/{id}/messages', response: 'MessageList' },
  { method: 'get', path: '/v1/sessions/{id}/view', response: 'SessionView' },
  {
    method: 'post',
    path: '/v1/sessions/{id}/commands',
    request: 'CommandRequest',
    response: 'Command',
    statuses: [202],
  },
  {
    method: 'get',
    path: '/v1/sessions/{id}/file-checkpoints',
    request: 'FileCheckpointListQuery',
    response: 'FileCheckpointPage',
  },
  {
    method: 'get',
    path: '/v1/sessions/{id}/file-checkpoints/{pointId}',
    response: 'FileCheckpointDetail',
  },
  {
    method: 'get',
    path: '/v1/sessions/{id}/file-checkpoints/{pointId}/restores/{restoreId}',
    response: 'FileRestoreStatus',
  },
  {
    method: 'get',
    path: '/v1/sessions/{id}/file-checkpoints/{pointId}/recovery-boundary',
    response: 'FileCheckpointRecoveryBoundary',
  },
  { method: 'get', path: '/v1/extensions', response: 'ExtensionList' },
  {
    method: 'get',
    path: '/v1/sessions/{id}/extensions/{extensionId}/queries/{queryId}',
    response: 'QueryResponse',
  },
  {
    method: 'post',
    path: '/v1/sessions/{id}/job-reports/{reportCommandId}/resume',
    request: 'ResumeJobReportRequest',
    response: 'ResumeJobReportResponse',
    statuses: [202],
  },
  { method: 'get', path: '/v1/commands/{id}', response: 'Command' },
  { method: 'get', path: '/v1/runs/{id}', response: 'Run' },
  { method: 'get', path: '/v1/executions/{id}', response: 'Execution' },
  { method: 'get', path: '/v1/executions/{id}/output', response: 'ExecutionOutputPage' },
] as const;

export const OpaqueCredentialRefSchema = opaqueCredentialRef;
