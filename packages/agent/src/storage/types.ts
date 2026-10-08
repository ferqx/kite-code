import type { ReasoningEffort } from '@kite-ai/ai';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonSchema = Readonly<Record<string, Json>>;
export type RunStatus =
  | 'running'
  | 'waiting_interaction'
  | 'waiting_execution'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type ExecutionStatus =
  | 'planned'
  | 'dispatching'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown';
export type CommandStatus = 'accepted' | 'applied' | 'rejected' | 'needs_review';

export interface StoreMetadata {
  storeId: string;
  formatMajor: number;
  replayFloor: string;
  lastChangeCursor: string;
  engine: { version: string; sourceId: string };
}
export interface WorkspaceRecord {
  id: string;
  rootUri: string;
  name: string;
}
export interface SessionRecord {
  id: string;
  workspaceId: string;
  parentSessionId: string | null;
  rootSessionId: string;
  title: string;
  controlRevision: string;
  contextSelectionId: string;
  ownerInstanceId: string | null;
  ownerGeneration: string;
  nextSeq: string;
  deletedAt: number | null;
}
export interface OwnerRef {
  sessionId: string;
  instanceId: string;
  generation: string;
}
export interface CompressionRecord {
  originSessionId: string;
  originCompressionId: string;
  id: string;
  sessionId: string;
  contextSelectionId: string;
  originStoreId: string;
  modelExecutionId: string;
  runId: string;
  coveredThroughSeq: string;
  publishedSeq: string;
  previousCompressionId: string | null;
  compressor: { id: string; version: string; snapshot: Json };
  trigger: 'manual' | 'automatic';
}
export interface ExtensionInput {
  extensionId: string;
  /** The registered Extension.version; this does not select a Tool or confer authority. */
  definitionVersion: string;
  input: Json;
}
export type CommandRequest =
  | { kind: 'context.compress'; expectedContextSelectionId: string; focus?: string }
  | {
      kind: 'context.compression.reset';
      expectedContextSelectionId: string;
      expectedCompressionId: string | null;
    }
  | {
      kind: 'run.start';
      content: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffort;
      selectedSkills?: readonly string[];
      extensionInputs?: readonly ExtensionInput[];
    }
  | { kind: 'input.steer'; content: string; targetRunId: string; contextSelectionId: string }
  | {
      kind: 'input.follow_up';
      content: string;
      afterRunId: string | null;
      contextSelectionId: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffort;
      selectedSkills?: readonly string[];
      extensionInputs?: readonly ExtensionInput[];
    }
  | {
      kind: 'extension.invoke';
      extensionId: string;
      actionId: string;
      definitionVersion: string;
      input: Json;
    };
export interface CommandRecord {
  id: string;
  sessionId: string;
  seq: string;
  originStoreId: string;
  rootWorkCommandId: string;
  rootWorkSeq: string;
  subjectId: string;
  request: Json;
  requestDigest: string;
  kind: string;
  status: CommandStatus;
  receipt: Json;
  cancelRequestedAt: number | null;
}
export interface RequirementRef {
  evaluationProvider?: 'extension';
  /** May be omitted at registration; Store seals it from the executable record. Gates require it. */
  originStoreId?: string;
  extensionId: string;
  definitionVersion: string;
  requirementId: string;
  revision: string;
  phase: 'dispatch' | 'completion' | 'both';
  sessionId: string;
  runId: string;
  executionId?: string;
  attempt?: number;
  recordKey: string;
}
export interface ResultRequirementDeclaration {
  recordKey: string;
  requirementId: string;
  definitionVersion: string;
  contentType: string;
  contentVersion: number;
}
export interface RunExecutionSafety {
  originStoreId: string;
  sessionId: string;
  runId: string;
  revision: string;
  unconfirmed: boolean;
  /** Fixed by the host's actual Tool boundary, never selected by an extension argument. */
  excludedExecutionId: string | null;
  /** Exact bounded original closure; IDs confer no cancellation or recovery authority. */
  unconfirmedExecutionIds: string[];
}
/** Read-only whole-root observation; no cancellation or execution authority. */
export interface ExecutionGroupSafety {
  originStoreId: string;
  sessionId: string;
  rootSessionId: string;
  revision: string;
  /** Original selection and complete Message identities/revisions; excludes intake/Ask sequence. */
  contextRevision: string;
  excludedExecutionId: string | null;
  quiescent: boolean;
  activeRunIds: string[];
  pendingCommandIds: string[];
  unconfirmedExecutionIds: string[];
}
export interface ExecutionGroupGuard {
  kind: 'execution_group_quiescence';
  version: 1;
  rootSessionId: string;
  originCommandId: string;
}
export interface DispatchRecordRead {
  extensionId: string;
  sessionId: string;
  key: string;
  revision: string | null;
  originStoreId: string | null;
  digest: string;
}
export interface ForkReadonlySource {
  executionId: string;
  sessionId: string;
  originStoreId: string;
  kind: 'model' | 'tool' | 'job';
  runId: string | null;
  modelExecutionId: string | null;
  artifactRefs: readonly ArtifactReference[];
}
export interface ForkReadonlyProof {
  version: 1;
  sources: ForkReadonlySource[];
  stamps: {
    kind: 'execution' | 'run' | 'command' | 'message' | 'artifact';
    id: string;
    digest: string;
  }[];
  models: { executionId: string; inputHash: string; outputHash: string }[];
}
export interface ForkSourceObservation {
  binding: ForkRecordSourceBinding;
  proof: ForkReadonlyProof;
  aliases: {
    current: { sessionId: string; messageId: string; seq: string };
    aliases: { sessionId: string; messageId: string; seq: string }[];
  }[];
}
export interface ForkRecordSourceBinding {
  version: 1;
  localKey: string;
  digest: string;
}
export interface ForkRecordSources {
  binding: ForkRecordSourceBinding;
  /** Actual current records; never a reconstructed historical revision. */
  records: readonly ExtensionRecord[];
}
export interface DispatchReadSet {
  records: DispatchRecordRead[];
  forkBindings?: ForkRecordSourceBinding[];
  forkSourceBindings?: ForkRecordSourceBinding[];
  recordLists?: DispatchRecordListRead[];
  executionGroup?: {
    rootSessionId: string;
    executionId: string;
    revision: string;
    contextRevision?: string;
    quiescent: true;
  };
}
export interface DispatchRecordListRead {
  extensionId: string;
  sessionId: string;
  afterKey: string;
  limit: number;
  contentType: string | null;
  digest: string;
}
export interface RequirementExecutionSafetyRead {
  runId: string;
  excludedExecutionId: string | null;
  revision: string;
  unconfirmed: boolean;
}
export interface InformationPermissionStamp {
  revision: string;
  bindingDigest: string;
  controlReads?: readonly import('./port').PermissionControlRead[];
}
export interface RequirementEvaluation {
  requirement: RequirementRef;
  recordRevision: string;
  outcome: 'satisfied' | 'waived' | 'unsatisfied';
  evidence: Json;
  /** Related executable records read by this evaluator, in the requirement's namespace/scope. */
  recordReads?: RequirementRecordRead[];
  executionSafetyReads?: RequirementExecutionSafetyRead[];
  /** Non-authoritative completion advice; Core verifies each stored observation before waiting. */
  wait?: { executionIds: string[] };
}
export interface RequirementRecordRead {
  key: string;
  /** A missing record is also a checked read; it must remain missing at commit. */
  revision: string | null;
  originStoreId: string | null;
}
export interface RunRecord {
  /** Actual immutable selection captured by the original Run activation transaction. */
  contextSelectionId: string;
  waitingForResults: string[];
  id: string;
  sessionId: string;
  originCommandId: string;
  originStoreId: string;
  rootWorkCommandId: string;
  rootWorkSeq: string;
  status: RunStatus;
  isActive: boolean;
  configuration: Json;
  requirements: RequirementRef[];
  createdAt: number;
  /** Child activation + 30 minutes; root Runs have no total deadline. */
  deadlineAt: number | null;
  finishedAt: number | null;
  reason: string | null;
}
export interface ExecutionRecord {
  resultAcceptance: {
    runId: string | null;
    selectionId: string;
    sourceId: string;
    resultRevision: string;
  } | null;
  interactionBinding: { interactionId: string; decisionRevision: string | null } | null;
  childSessionId: string | null;
  childConfiguration: ChildConfiguration | null;
  afterTurn?: Json | null;
  id: string;
  sessionId: string;
  runId: string | null;
  originCommandId: string;
  originStoreId: string;
  rootWorkCommandId: string;
  rootWorkSeq: string;
  parentExecutionId: string | null;
  cancelWithParent: boolean;
  stepId: string;
  callId: string;
  attempt: number;
  kind: 'model' | 'tool' | 'job';
  definitionId: string;
  definitionVersion: string;
  status: ExecutionStatus;
  input: Json;
  decisionSource: Json;
  result: Json;
  ownerGeneration: string;
  cancelRequestedAt: number | null;
  resultRevision: string;
  reference: Json;
  delivery: 'pending' | 'consumed' | 'suppressed' | null;
  deliveryReason: string | null;
  deliveryTargetSessionId: string | null;
  contextSelectionId: string | null;
  requirements: RequirementRef[];
  recoveryManifest?: Json | null;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelInputIdentity {
  executionId: string;
  sessionId: string;
  rootSessionId: string;
  runId: string;
  originCommandId: string;
  rootWorkCommandId: string;
  rootWorkSeq: string;
  attempt: number;
  status: ExecutionStatus;
  confirmation: 'succeeded' | 'unconfirmed';
  modelId: string;
}
export interface ModelInputPage {
  storeId: string;
  sessionId: string;
  rootSessionId: string;
  items: (ModelInputIdentity & { seq: string })[];
  highWaterSeq: string;
  upperSeq: string;
  nextAfterSeq: string | null;
  snapshotCursor: string;
}
/** Internal sealed read; raw references and original subject are never public Inspector DTOs. */
export interface StoredModelOutput {
  storeId: string;
  originStoreId: string;
  identity: ModelInputIdentity;
  subjectId: string;
  snapshotCursor: string;
  output: import('../model-output').ModelOutputReference | null;
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  complete: boolean;
}
export interface StoredModelInput {
  storeId: string;
  originStoreId: string;
  identity: ModelInputIdentity;
  input: Json;
  receiptInputHash: string | null;
  metadata: Json | null;
  dispatchAuthorization: Json | null;
  subjectId: string;
  snapshotCursor: string;
}
export interface MessageContent {
  /** Exact sealed output; content is an explicitly incomplete preview when present. */
  modelOutput?: import('../model-output').ModelOutputReference;
  contextSelectionId?: string;
  originCommandId?: string;
  inputKind?: 'input.steer' | 'input.follow_up';
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  sourceIds?: string[];
}
export interface MessageRecord extends MessageContent {
  id: string;
  sessionId: string;
  runId: string | null;
  seq: string;
  status: 'complete' | 'incomplete';
}
export interface ChangeEvent {
  cursor: string;
  sessionId: string | null;
  objectId: string;
  type: string;
  revision: string;
  payload: Json;
}
export interface ExtensionRecord {
  /** Sealed Fork history/derivation; cannot grant original executable-plan authority. */
  forkProvenance?: Json | null;
  extensionId: string;
  sessionId: string;
  key: string;
  revision: string;
  contentType: string;
  contentVersion: number;
  originStoreId: string | null;
  value: Json;
}
export interface ExtensionRecordWrite {
  key: string;
  expectedRevision: string | null;
  contentType: string;
  contentVersion: number;
  value: Json;
  executable?: true;
}
export type OperationRequest =
  | { kind: 'tool' | 'job'; definitionId: string; definitionVersion: string; input: Json }
  | { kind: 'agent'; configurationId: string; input: Json };
export interface ChildConfigurationRecordRead {
  extensionId: string;
  key: string;
  revision: string | null;
  originStoreId: string | null;
  digest: string;
}
export interface ChildConfiguration {
  id: string;
  version: string;
  snapshot: Json;
  /** Trusted Runtime observations, sealed with the original carrier; never extension input. */
  recordReads?: ChildConfigurationRecordRead[];
}
export interface ChildRunActivation {
  command: CommandRecord;
  session: SessionRecord;
  run: RunRecord;
}

export interface ExecutionOutputRecord {
  executionId: string;
  seq: string;
  throughSeq: string;
  stream: 'stdout' | 'stderr' | 'progress';
  content: string;
  /** null only when a coalesced gap was clipped and its exact byte count is unavailable. */
  droppedBytes: string | null;
}
export interface ExecutionOutputPage {
  items: ExecutionOutputRecord[];
  highWaterSeq: string;
}
export interface OperationRef {
  childSessionId?: string;
  commandId: string;
  sessionId: string;
  originStoreId: string;
  extensionId: string;
  key: string;
  executionId: string | null;
}
export interface RecoveryReport {
  sessionId: string;
  storeId: string;
  previousGeneration: string;
  generation: string;
  interruptedRunIds: string[];
  settledExecutionIds: string[];
  unknownExecutionIds: string[];
  cancelledExecutionIds: string[];
  partialMessageIds: string[];
  snapshotCursor: string;
}
export interface SessionView {
  session: SessionRecord;
  runs: RunRecord[];
  executions: ExecutionRecord[];
  messages: MessageRecord[];
  snapshotCursor: string;
  storeId: string;
}
export class AgentError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string = code, retryable = false) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** Immutable bytes and an explicit original authorization scope. Hashes are not read capabilities. */
export type ArtifactScope = { kind: 'session' | 'execution' | 'message'; id: string };
export interface ArtifactReference {
  id: string;
  storeId: string;
  sessionId: string;
  subjectId: string;
  scope: ArtifactScope;
  hash: string;
  size: string;
  mediaType: string;
}

export interface HostControlState {
  revision: string;
  record: HostMutationRecord | null;
}
export type HostMutationKind =
  | 'permission.grants.clear'
  | 'permission.mode'
  | 'workspace.trust'
  | 'config.user.write'
  | 'config.workspace.write'
  | 'config.repair'
  | 'credential.put'
  | 'credential.revoke';
export interface HostMutationRecord {
  id: string;
  originStoreId: string;
  subjectId: string;
  kind: HostMutationKind;
  scope: string;
  requestDigest: string;
  safeRequest: Json;
  state: 'pending' | 'applied' | 'failed' | 'outcome_unknown';
  receipt: Json;
}
export interface PermissionGrant {
  commandDigest?: string;
  id: string;
  originStoreId: string;
  sessionId: string;
  workspaceId: string;
  kind: string;
  definitionId: string;
  definitionVersion: string;
  inputDigest: string;
  interactionId: string;
  decisionRevision: string;
  executionId: string;
}
export interface PermissionGrantPage {
  storeId: string;
  sessionId: string;
  revision: string;
  items: { seq: string; grant: PermissionGrant }[];
  highWaterSeq: string;
  upperSeq: string;
  nextAfterSeq: string | null;
  snapshotCursor: string;
}

export type InteractionKind = 'approval' | 'question' | 'plan_review';
export type InteractionAnswer =
  | { kind: 'approval'; decision: 'approve' | 'deny'; grant?: 'approve_once' | 'same_command' }
  | { kind: 'question'; answers: Json }
  | {
      kind: 'plan_review';
      decision: 'approve' | 'deny' | 'revise';
      feedback?: string;
      mode?: string;
    };
export interface InteractionRecord {
  /** Private permission observation; never a Tool grant or public answer field. */
  informationPermission?: InformationPermissionStamp;
  id: string;
  originStoreId: string;
  sessionId: string;
  runId: string | null;
  executionId: string;
  attempt: number;
  presentationSessionId: string;
  ancestry: string[];
  subjectId: string;
  kind: InteractionKind;
  definitionId: string;
  definitionVersion: string;
  inputDigest: string;
  policyRevision: string;
  requiredRefs: RequirementRef[];
  source: Json;
  request: Json;
  answer: InteractionAnswer | null;
  revision: string;
  acceptedDecisionRevision: string | null;
  state: 'pending' | 'answered' | 'cancelled';
}
export interface InteractionPage {
  interactions: InteractionRecord[];
  nextAfterId: string | null;
  snapshotCursor: string;
}

export interface InputApplication {
  command: CommandRecord;
  run: RunRecord;
  message: MessageRecord;
  supersededExecutionIds: string[];
}
export interface PendingInputPage {
  commands: CommandRecord[];
  nextAfterSeq: string | null;
  snapshotCursor: string;
}

/** Private immutable queue identity. Body access still requires the original Artifact scope. */
export interface AfterTurnAuthorization {
  revision: string;
  controlReads?: readonly import('./port').PermissionControlRead[];
}
export interface AgentMessage {
  id: string;
  seq: string;
  originStoreId: string;
  sourceSessionId: string;
  sourceExecutionId: string;
  targetSessionId: string;
  targetRunId: string | null;
  contextSelectionId: string;
  state: 'pending_sender' | 'accepted' | 'received' | 'rejected' | 'outcome_unknown';
  body: ArtifactReference;
  receivedMessageId: string | null;
  receivedRunId: string | null;
  receivedContextSelectionId: string | null;
}
export interface AgentMessagePage {
  storeId: string;
  sessionId: string;
  items: AgentMessage[];
  upperSeq: string;
  highWaterSeq: string;
  nextAfterSeq: string | null;
  snapshotCursor: string;
  /** Observation of committed inbox messages, not Model-prepared acknowledgment. */
  receivedSeq: string;
}

export interface ContextSelection {
  id: string;
  sessionId: string;
  previousSelectionId: string | null;
  boundaryMessageId: string | null;
  boundarySeq: string;
  tailFromSeq: string;
  ranges: { afterSeq: string; throughSeq: string }[];
}
export interface ResultContextSource {
  id: string;
  seq: string;
  sessionId: string;
  createdSelectionId: string;
  executionId: string;
  resultRevision: string;
  originStoreId: string;
  inclusion: 'automatic' | 'explicit';
  result: Json;
}
export interface SelectedContextPage {
  compression?: CompressionRecord;
  selection: ContextSelection;
  highWaterSeq: string;
  messages: MessageRecord[];
  resultSources: ResultContextSource[];
  nextAfterSeq: string | null;
  nextAfterSourceId: string | null;
  snapshotCursor: string;
}

export interface PendingJobResultPage {
  jobs: {
    executionId: string;
    resultRevision: string;
    originStoreId: string;
    contextSelectionId: string;
    completedCursor: string;
  }[];
  nextAfterCursor: string | null;
  highWaterCursor: string;
  snapshotCursor: string;
}

/** Immutable causal mutation facts, not a second execution outcome authority. */
export interface MutationFact {
  supersededBy?: { executionId: string; seq: string; hash: string };
  executionId: string;
  seq: string;
  descriptor: Json;
  status: ExecutionStatus;
  resultRevision: string;
  result: Json;
  check: {
    outcome: 'passed' | 'failed' | 'inconclusive' | 'superseded';
    executionId: string;
    evidence: Json;
  } | null;
}
export interface MutationFactPage {
  facts: MutationFact[];
  headRevision: string | null;
  nextAfterSeq: string | null;
  highWaterSeq: string;
}

export interface AgentSummary {
  waitingInteractionId: string | null;
  ref: OperationRef;
  seq: string;
  executionId: string;
  status: ExecutionStatus;
  attempt: number;
  originCommandId: string;
  parentExecutionId: string | null;
  rootSessionId: string;
  rootWorkCommandId: string;
  rootWorkSeq: string;
  childSessionId: string;
  contextSelectionId: string;
  run: { id: string; status: RunStatus; isActive: boolean; deadlineAt: number | null } | null;
}
export interface AgentSummaryPage {
  storeId: string;
  sessionId: string;
  rootSessionId: string;
  extensionId: string;
  items: AgentSummary[];
  upperSeq: string;
  highWaterSeq: string;
  nextAfterSeq: string | null;
  snapshotCursor: string;
}

export type BackgroundRun = Omit<RunRecord, 'configuration' | 'requirements'>;
export type BackgroundExecution = Omit<
  ExecutionRecord,
  | 'input'
  | 'decisionSource'
  | 'result'
  | 'reference'
  | 'childConfiguration'
  | 'afterTurn'
  | 'requirements'
  | 'recoveryManifest'
  | 'resultAcceptance'
  | 'interactionBinding'
> & { rootSessionId: string; cancelRequested: boolean };
export interface BackgroundExecutionItem {
  seq: string;
  execution: BackgroundExecution;
  session: SessionRecord;
  rootSession: SessionRecord;
  run: BackgroundRun | null;
  childRun: BackgroundRun | null;
  childSession: SessionRecord | null;
}
export interface BackgroundExecutionPage {
  storeId: string;
  items: BackgroundExecutionItem[];
  highWaterSeq: string;
  upperSeq: string;
  nextAfterSeq: string | null;
  snapshotCursor: string;
}

/** Read-only activity facts captured with the directory page, never execution authority. */
export interface SessionDirectoryActivity {
  updatedAt: number | null;
  run: {
    id: string;
    status: RunRecord['status'];
    isActive: boolean;
    waitingForResults: boolean;
  } | null;
  queued: boolean;
  pendingInteractions: number;
}
export interface SessionDirectoryPage {
  storeId: string;
  items: { seq: string; session: SessionRecord; activity: SessionDirectoryActivity }[];
  highWaterSeq: string;
  upperSeq: string;
  nextAfterSeq: string | null;
  snapshotCursor: string;
}
export interface WorkspaceDirectoryPage {
  storeId: string;
  items: { seq: string; workspace: WorkspaceRecord }[];
  highWaterSeq: string;
  upperSeq: string;
  nextAfterSeq: string | null;
  snapshotCursor: string;
}

export type SessionExportSection =
  | 'sessions'
  | 'commands'
  | 'runs'
  | 'messages'
  | 'message_parts'
  | 'executions'
  | 'execution_output'
  | 'interactions'
  | 'context_snapshots'
  | 'extension_records'
  | 'artifact_refs';
export interface SessionExportManifest {
  version: 1;
  storeId: string;
  rootSessionId: string;
  readInstanceId: string;
  snapshotCursor: string;
  dataVersion: string;
  sections: { section: SessionExportSection; highWaterSeq: string; count: string }[];
  excluded: string[];
  contentMedia: 'sqlite-records-and-original-scope-artifact-references';
}
export interface SessionExportPage {
  storeId: string;
  rootSessionId: string;
  section: SessionExportSection;
  snapshotCursor: string;
  upperSeq: string;
  records: {
    section: SessionExportSection;
    seq: string;
    sessionId: string;
    id: string;
    record: Json;
  }[];
  nextAfterSeq: string | null;
}
export interface SessionExportCompletion {
  manifest: SessionExportManifest;
  verified: true;
  contentMedia: SessionExportManifest['contentMedia'];
}

export interface SessionExportTextPage {
  storeId: string;
  rootSessionId: string;
  section: SessionExportSection;
  seq: string;
  field: string;
  afterByte: string;
  byteLength: string;
  contentBase64: string;
  nextAfterByte: string | null;
}

export interface ForkNamespaceReport {
  extensionId: string;
  contentType: string;
  contentVersion: number;
  mode: 'copy' | 'rebuild' | 'omit';
  ruleVersion: string | null;
  copied: number;
  rebuilt: number;
  omitted: number;
}
export interface ForkNamespacePage {
  snapshotCursor: string;
  dataVersion: string;
  sourceUpperSeq: string;
  selectedMessages: { id: string; seq: string; sourceIds: string[] }[];
  records: {
    seq: string;
    extensionId: string;
    key: string;
    revision: string;
    contentType: string;
    contentVersion: number;
    originStoreId: string | null;
    rawDigest: string;
    rawText: string | null;
    forkProvenance: Json | null;
  }[];
  nextAfterSeq: string | null;
}
export interface ForkNamespacePlan {
  snapshotCursor: string;
  dataVersion: string;
  sourceUpperSeq: string;
  selectedMessagesDigest: string;
  sources: Omit<ForkNamespacePage['records'][number], 'rawText'>[];
  writes: {
    extensionId: string;
    key: string;
    contentType: string;
    contentVersion: number;
    rawText: string;
    mode: 'copy' | 'rebuild';
    ruleVersion: string;
    extensionVersion: string;
    sourceKeys: string[];
    schema: JsonSchema;
    readonlyProof?: ForkReadonlyProof;
  }[];
  report: ForkNamespaceReport[];
}

export interface JobRecoveryLease {
  kind: 'job_reconciliation';
  id: string;
  sessionId: string;
  instanceId: string;
  generation: string;
  commandId: string;
  executionId: string;
  resultRevision: string;
}
export interface JobReconciliationInput {
  expectedStoreId: string;
  commandId: string;
  subjectId: string;
  sessionId: string;
  executionId: string;
  expectedResultRevision: string;
}
export interface JobReconciliationReceipt {
  executionId: string;
  resultRevision: string;
  outcome: 'verified' | 'unresolved';
  supervision: 'ended' | 'running' | 'unknown';
  result: Json | null;
  evidence: Json;
  reason: string | null;
  evidenceSource: 'adapter_reconcile';
}

export interface RunResumeInput {
  expectedStoreId: string;
  commandId: string;
  subjectId: string;
  sessionId: string;
  runId: string;
  expectedOwnerGeneration: string;
}
export interface RunResumeCheckpoint {
  boundary: 'before_model_dispatch' | 'tool_calls' | 'completion';
  bindingDigest: string;
  contextSelectionId: string;
  initializationState: 'unstarted' | 'started' | 'completed';
}
export interface RunResumeState {
  command: CommandRecord | null;
  run: RunRecord;
  originalCommand: CommandRecord;
  session: SessionRecord;
  executions: ExecutionRecord[];
  checkpoint: RunResumeCheckpoint | null;
  requirementsInitialized: boolean;
}
export interface RunResumeLease {
  kind: 'run_resume';
  id: string;
  sessionId: string;
  instanceId: string;
  generation: string;
  commandId: string;
  runId: string;
  originalOwnerGeneration: string;
}

/** Metadata-only diagnostics. These records never authorize execution or carry event payloads. */
export type SessionLogCategory =
  | 'command'
  | 'run'
  | 'execution'
  | 'interaction'
  | 'message'
  | 'context'
  | 'extension'
  | 'session'
  | 'other';
export interface SessionLogDetails {
  kind?: 'model' | 'tool' | 'job';
  definitionId?: string;
  definitionVersion?: string;
  commandId?: string;
  runId?: string;
  executionId?: string;
  interactionId?: string;
  attempt?: number;
}
export interface SessionLogEntry {
  cursor: string;
  sessionId: string;
  objectId: string;
  type: string;
  revision: string;
  occurredAt: number | null;
  category: SessionLogCategory;
  recordedStatus: string | null;
  summary: string;
  details: SessionLogDetails;
  modelExecutionId: string | null;
}
export interface SessionLogPage {
  storeId: string;
  sessionId: string;
  upperCursor: string;
  nextAfterCursor: string | null;
  replayFloor: string;
  snapshotCursor: string;
  entries: SessionLogEntry[];
  complete: boolean;
}

/** Only exact selected Fork aliases; original identities and complete persisted parts. */
export interface ForkSourceMessage extends MessageRecord {
  parts: readonly {
    ordinal: number;
    kind: string;
    contentVersion: number;
    revision: string;
    value: Json;
  }[];
}
