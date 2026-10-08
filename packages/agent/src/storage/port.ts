import type {
  ArtifactReference,
  ArtifactScope,
  ChangeEvent,
  ChildConfiguration,
  ChildRunActivation,
  CommandRecord,
  CommandRequest,
  ContextSelection,
  ExecutionOutputPage,
  ExecutionOutputRecord,
  ExecutionRecord,
  ExecutionStatus,
  ExtensionRecord,
  ExtensionRecordWrite,
  ForkNamespacePage,
  ForkNamespacePlan,
  ForkNamespaceReport,
  HostMutationKind,
  HostMutationRecord,
  InformationPermissionStamp,
  InputApplication,
  InteractionAnswer,
  InteractionKind,
  InteractionPage,
  InteractionRecord,
  Json,
  MessageContent,
  MessageRecord,
  ModelInputPage,
  OperationRef,
  OperationRequest,
  OwnerRef,
  PendingInputPage,
  PendingJobResultPage,
  RecoveryReport,
  RequirementEvaluation,
  RequirementRef,
  ResultContextSource,
  RunExecutionSafety,
  RunRecord,
  RunStatus,
  SelectedContextPage,
  SessionDirectoryPage,
  SessionExportCompletion,
  SessionExportManifest,
  SessionExportPage,
  SessionExportSection,
  SessionExportTextPage,
  SessionLogPage,
  SessionRecord,
  SessionView,
  StoredModelInput,
  StoreMetadata,
  WorkspaceDirectoryPage,
  WorkspaceRecord,
} from './types';

export interface WriteContext {
  expectedStoreId: string;
}
export interface OwnedWrite extends WriteContext {
  owner: OwnerRef;
}
export interface AcceptCommandInput extends WriteContext {
  commandId: string;
  sessionId: string;
  subjectId: string;
  request: CommandRequest;
}
export type ApplyInputInput = OwnedWrite & { commandId: string } & (
    | { kind: 'steer' | 'result_include'; runId: string }
    | { kind: 'follow_up'; configuration: Json; requirements?: RequirementRef[] }
  );
export interface PlanExecutionInput extends OwnedWrite {
  executionId: string;
  sessionId: string;
  runId: string | null;
  originCommandId: string;
  stepId: string;
  callId: string;
  kind: 'model' | 'tool' | 'job';
  parentExecutionId?: string;
  cancelWithParent?: boolean;
  definitionId: string;
  definitionVersion: string;
  input: Json;
  decisionSource: Json;
  /** Immutable non-secret facts for this Model request, or a verified body descriptor. */
  modelMetadata?: Json;
}
export interface PermissionControlRead {
  readonly kind: 'permission.mode' | 'workspace.trust';
  readonly scope: string;
  readonly revision: string;
}
export interface DispatchInput extends OwnedWrite {
  executionId: string;
  /** Captured by the trusted Host, not extension result or caller input. */
  readSet?: import('./types').DispatchReadSet;
  authorization: {
    grant?: { grantId: string; revision: string; commandDigest?: string };
    snapshot?: { namespace: string; version: string; data: Json };
    controlReads?: readonly PermissionControlRead[];
    reviewExecutionId?: string;
    interactionId?: string;
    decisionRevision?: string;
    allowed: boolean;
    revision: string;
    definitionVersion: string;
    inputDigest: string;
  };
  requirements: RequirementEvaluation[];
  freshness: { checked: boolean; source: Json };
}
export interface FinishExecutionInput extends OwnedWrite {
  executionId: string;
  status: Extract<ExecutionStatus, 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown'>;
  result: Json;
  message?: MessageContent;
  requirements?: RequirementEvaluation[];
}
export interface CancelCommandInput extends WriteContext {
  commandId: string;
  sessionId: string;
  targetCommandId: string;
  subjectId: string;
}
export interface CancelWorkBase extends WriteContext {
  commandId: string;
  sessionId: string;
  subjectId: string;
}
export type CancelWorkInput = CancelWorkBase &
  (
    | { kind: 'run.cancel'; runId: string }
    | { kind: 'execution.cancel'; executionId: string }
    | { kind: 'session.cancel'; includeBackground: boolean }
  );
export interface RecordScope {
  extensionId: string;
  sessionId: string;
}
export interface EnsureOperationInput extends OwnedWrite, RecordScope {
  originCommandId: string;
  parentExecutionId: string;
  operationKey: string;
  request: OperationRequest;
  resultRequirement?: import('./types').ResultRequirementDeclaration;
  /** Trusted captured record schema; never supplied by an extension's declaration. */
  resultRequirementSchema?: Json;
  cancellation?: 'attached' | 'detached';
  childConfiguration?: ChildConfiguration;
  /** Trusted owner authorization; ordinary OperationOptions contain only intent. */
  afterTurnAuthorization?: import('./types').AfterTurnAuthorization;
  /** The host reads this executable record's immutable origin; payload origins are never trusted. */
  planRecordKey?: string;
}
export interface AcceptAgentInput extends OwnedWrite, RecordScope {
  commandId: string;
  originCommandId: string;
  parentExecutionId: string;
  ref: OperationRef;
  key: string;
  targetRunId: string;
  contextSelectionId: string;
  content: string;
}
export type InterruptAgentInput = Omit<AcceptAgentInput, 'key' | 'contextSelectionId' | 'content'>;
export interface EnsureAgentFollowUpInput extends EnsureOperationInput {
  previous: OperationRef;
  afterRunId: string;
  contextSelectionId: string;
}
export interface PlanActionInput extends OwnedWrite {
  commandId: string;
  executionId: string;
  extensionId: string;
  definitionId: string;
  definitionVersion: string;
  input: Json;
  decisionSource: Json;
  predecessorExecutionId?: string;
  attempt?: number;
}

export interface AuthorizationReviewIdentity {
  id: string;
  version: string;
  modelId: string;
}
export interface EnsureAuthorizationReviewInput extends OwnedWrite {
  targetExecutionId: string;
  policyRevision: string;
  request: Json;
  requestBody?: import('../model-body').ModelBodyReference;
  originCommandRequestBody?: import('../model-body').ModelBodyReference;
  rootWorkRequestBody?: import('../model-body').ModelBodyReference;
  targetInputBody?: import('../model-body').ModelBodyReference;
  targetSourceBody?: import('../model-body').ModelBodyReference;
  reviewer: AuthorizationReviewIdentity;
  requireApproval?: boolean;
}
export interface AuthorizationReviewFact {
  operation: OperationRef;
  configuration: ChildConfiguration;
  input: Json;
  source: Json;
  created: boolean;
}
export interface ReadAuthorizationReviewInput extends WriteContext {
  targetExecutionId: string;
  reviewExecutionId: string;
  policyRevision: string;
  request: Json;
  requestBody?: import('../model-body').ModelBodyReference;
  reviewer: AuthorizationReviewIdentity;
  requireApproval?: boolean;
}
export interface AuthorizationReviewResult {
  decision: 'approve_once' | 'reject' | 'ask_user' | 'unavailable';
  reason: string;
  reviewExecutionId: string;
}

/** Host/adapter boundary. Ordinary extensions never receive this port. */
export interface Store {
  readForkNamespacePage(
    input: Omit<Parameters<Store['forkSession']>[0], 'namespacePlan'> & {
      afterSeq?: string;
      expectedSnapshotCursor?: string;
      expectedDataVersion?: string;
    },
  ): Promise<ForkNamespacePage>;

  readSessionExportText(
    input: WriteContext & {
      sessionId: string;
      subjectId: string;
      manifest: SessionExportManifest;
      section: SessionExportSection;
      seq: string;
      field: string;
      afterByte?: string;
      limitBytes?: number;
    },
  ): Promise<SessionExportTextPage>;

  beginSessionExport(
    input: WriteContext & { sessionId: string; subjectId: string },
  ): Promise<SessionExportManifest>;
  readSessionExportPage(
    input: WriteContext & {
      sessionId: string;
      subjectId: string;
      manifest: SessionExportManifest;
      section: SessionExportSection;
      afterSeq?: string;
      limit?: number;
      byteLimit?: number;
    },
  ): Promise<SessionExportPage>;
  verifySessionExport(
    input: WriteContext & { sessionId: string; subjectId: string; manifest: SessionExportManifest },
  ): Promise<SessionExportCompletion>;

  verifyJobReportRecovery(
    input: WriteContext & {
      sessionId: string;
      reportCommandId: string;
      recovery: { commandId: string; subjectId: string; expectedConfiguration: Json };
    },
  ): Promise<void>;
  verifyRunResume(
    input: import('./types').RunResumeInput,
  ): Promise<import('./types').RunResumeState>;
  beginRunResume(
    input: import('./types').RunResumeInput & {
      instanceId: string;
      checkpoint: import('./types').RunResumeCheckpoint;
    },
  ): Promise<{
    command: CommandRecord;
    lease: import('./types').RunResumeLease | null;
    state: import('./types').RunResumeState;
    started: false;
  }>;
  commitRunResume(input: {
    expectedStoreId: string;
    lease: import('./types').RunResumeLease;
    expectedConfiguration: Json;
    checkpoint: import('./types').RunResumeCheckpoint;
  }): Promise<{
    command: CommandRecord;
    owner: OwnerRef;
    run: RunRecord;
    originalCommand: CommandRecord;
    executions: ExecutionRecord[];
    checkpoint: import('./types').RunResumeCheckpoint;
    started: true;
  }>;
  releaseRunResumeLease(lease: import('./types').RunResumeLease): Promise<void>;
  beginRunRequirementsInitialization(input: OwnedWrite & { runId: string }): Promise<RunRecord>;
  sealJobRecoveryManifest(
    input: OwnedWrite & { executionId: string; manifest: Json },
  ): Promise<ExecutionRecord>;
  getJobReconciliationReceipt(
    input: import('./types').JobReconciliationInput,
  ): Promise<CommandRecord | null>;
  beginJobReconciliation(
    input: import('./types').JobReconciliationInput & { instanceId: string },
  ): Promise<{
    command: CommandRecord;
    lease: import('./types').JobRecoveryLease | null;
    execution: ExecutionRecord;
  }>;
  markJobReconciliationDispatch(
    input: WriteContext & {
      lease: import('./types').JobRecoveryLease;
      authorization: import('./types').AfterTurnAuthorization;
      expectedRecoveryManifest: Json;
    },
  ): Promise<CommandRecord>;
  finishJobReconciliation(
    input: WriteContext & {
      lease: import('./types').JobRecoveryLease;
      authorization: import('./types').AfterTurnAuthorization;
      receipt: import('./types').JobReconciliationReceipt;
    },
  ): Promise<CommandRecord>;
  releaseJobRecoveryLease(lease: import('./types').JobRecoveryLease): Promise<void>;

  applyJobReport(
    input: OwnedWrite & {
      commandId: string;
      authorization: import('./types').AfterTurnAuthorization | null;
      recovery?: {
        commandId: string;
        subjectId: string;
        expectedConfiguration: Json;
      };
    },
  ): Promise<{ command: CommandRecord; run: RunRecord | null; started: boolean }>;
  listPendingJobReports(
    input: WriteContext & {
      sessionId: string;
      afterSeq?: string;
      upperSeq?: string;
      limit?: number;
    },
  ): Promise<{
    commands: CommandRecord[];
    upperSeq: string;
    highWaterSeq: string;
    nextAfterSeq: string | null;
  }>;

  readAgentMessageTarget(
    input: WriteContext & {
      sourceExecutionId: string;
      extensionId: string;
      subjectId: string;
      target: import('./types').OperationRef | 'parent';
    },
  ): Promise<{ sessionId: string; contextSelectionId: string; targetRunId: string | null }>;
  queueAgentMessage(
    input: OwnedWrite & {
      commandId: string;
      originCommandId: string;
      sourceExecutionId: string;
      extensionId: string;
      key: string;
      targetSessionId: string;
      targetCarrierExecutionId?: string;
      targetRunId?: string;
      contextSelectionId: string;
      body: ArtifactReference;
    },
  ): Promise<CommandRecord>;
  receiveAgentMessages(
    input: OwnedWrite & { runId: string; messageIds: string[] },
  ): Promise<string[]>;
  getAgentMessage(
    input: WriteContext & { sessionId: string; subjectId: string; messageId: string },
  ): Promise<import('./types').AgentMessage | null>;
  listAgentMessages(
    input: WriteContext & {
      sessionId: string;
      subjectId: string;
      runId?: string;
      pendingOnly?: boolean;
      confirmedOnly?: boolean;
      afterSeq?: string;
      upperSeq?: string;
      limit?: number;
    },
  ): Promise<import('./types').AgentMessagePage>;
  readHostControl(
    input: WriteContext & {
      subjectId: string;
      kind: 'permission.mode' | 'workspace.trust';
      scope: string;
    },
  ): Promise<import('./types').HostControlState>;
  getPermissionGrant(
    input: WriteContext & { executionId: string; commandDigest?: string },
  ): Promise<{ grantId: string; revision: string; commandDigest?: string } | null>;
  listPermissionGrants(
    input: WriteContext & {
      subjectId: string;
      sessionId: string;
      afterSeq?: string;
      upperSeq?: string;
      limit?: number;
    },
  ): Promise<import('./types').PermissionGrantPage>;
  clearPermissionGrants(
    input: WriteContext & {
      subjectId: string;
      sessionId: string;
      commandId: string;
      ifRevision: string;
    },
  ): Promise<HostMutationRecord>;
  registerMutationIntent(
    input: OwnedWrite & { executionId: string; requirement: RequirementRef; descriptor: Json },
  ): Promise<void>;
  listMutationFacts(
    input: WriteContext & { requirement: RequirementRef; afterSeq?: string; limit?: number },
  ): Promise<import('./types').MutationFactPage>;
  commitMutationCheck(
    input: OwnedWrite & {
      requirement: RequirementRef;
      executionId: string;
      mutationExecutionId: string;
      headRevision: string;
      outcome: 'passed' | 'failed' | 'inconclusive' | 'superseded';
      evidence: Json;
    },
  ): Promise<void>;

  getModelOutputSnapshot(input: {
    expectedStoreId: string;
    sessionId: string;
    subjectId: string;
    executionId: string;
  }): Promise<import('./types').StoredModelOutput>;
  getModelInputSnapshot(
    input: WriteContext & { sessionId: string; executionId: string; subjectId: string },
  ): Promise<StoredModelInput>;
  listModelInputs(
    input: WriteContext & {
      sessionId: string;
      subjectId: string;
      afterSeq?: string;
      upperSeq?: string;
      limit?: number;
    },
  ): Promise<ModelInputPage>;
  getMetadata(): Promise<StoreMetadata>;
  readExecutionGroupSafety(
    input: WriteContext & {
      subjectId: string;
      sessionId: string;
      boundaryCommandId?: string;
      excludeExecutionId?: string;
    },
  ): Promise<import('./types').ExecutionGroupSafety>;
  readRunExecutionSafety(
    input: WriteContext & {
      subjectId: string;
      sessionId: string;
      runId: string;
      excludeExecutionId?: string;
    },
  ): Promise<RunExecutionSafety>;
  createWorkspace(
    input: WriteContext & { id: string; rootUri: string; name: string },
  ): Promise<WorkspaceRecord>;
  getWorkspace(id: string): Promise<WorkspaceRecord | null>;
  listBackgroundExecutions(input: {
    expectedStoreId: string;
    subjectId: string;
    workspaceId?: string;
    rootSessionId?: string;
    executionId?: string;
    afterSeq?: string;
    upperSeq?: string;
    snapshotCursor?: string;
    limit?: number;
  }): Promise<import('./types').BackgroundExecutionPage>;
  listWorkspaceDirectory(input: {
    expectedStoreId: string;
    afterSeq?: string;
    upperSeq?: string;
    limit?: number;
  }): Promise<WorkspaceDirectoryPage>;
  listSessionDirectory(input: {
    expectedStoreId: string;
    subjectId: string;
    workspaceId?: string;
    afterSeq?: string;
    upperSeq?: string;
    snapshotCursor?: string;
    limit?: number;
  }): Promise<SessionDirectoryPage>;
  listWorkspaces(options?: { limit?: number; afterId?: string }): Promise<WorkspaceRecord[]>;
  createSession(
    input: WriteContext & {
      commandId: string;
      sessionId: string;
      workspaceId: string;
      title: string;
      subjectId: string;
    },
  ): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | null>;
  listSessions(options?: { limit?: number; afterId?: string }): Promise<SessionRecord[]>;
  acceptCommand(input: AcceptCommandInput): Promise<CommandRecord>;
  getCommand(id: string): Promise<CommandRecord | null>;
  listAcceptedCommands(sessionId: string, limit?: number): Promise<CommandRecord[]>;
  rejectCommand(
    input: OwnedWrite & { commandId: string; reason: string; needsReview?: boolean },
  ): Promise<CommandRecord>;
  acquireSessionOwner(sessionId: string, instanceId: string): Promise<OwnerRef | null>;
  releaseSessionOwner(owner: OwnerRef): Promise<boolean>;
  /** Original-owner idle handoff observation; never acquires/rebinds owner or authorizes recovery. */
  inspectOwnerDispatch(input: OwnedWrite & { sessionId: string }): Promise<{
    hasPendingCommands: boolean;
    hasUnsettledWork: boolean;
    hasUncommittedAction: boolean;
  }>;
  startRun(
    input: OwnedWrite & { commandId: string; configuration: Json; requirements?: RequirementRef[] },
  ): Promise<RunRecord>;
  registerRunRequirements(
    input: OwnedWrite & { runId: string; requirements: RequirementRef[]; initialize?: true },
  ): Promise<RunRecord>;
  initializeRunRecord(
    input: OwnedWrite & {
      runId: string;
      extensionId: string;
      write: Omit<ExtensionRecordWrite, 'expectedRevision' | 'executable'>;
    },
  ): Promise<ExtensionRecord>;
  getRun(id: string): Promise<RunRecord | null>;
  planExecution(input: PlanExecutionInput): Promise<ExecutionRecord>;
  activateChildRun(
    input: OwnedWrite & {
      executionId: string;
      configuration: Json;
      requirements?: RequirementRef[];
      requirementEvaluations: RequirementEvaluation[];
      freshness: { checked: boolean; source: Json };
    },
  ): Promise<ChildRunActivation>;
  acceptAgentInput(input: AcceptAgentInput): Promise<CommandRecord>;
  interruptAgent(input: InterruptAgentInput): Promise<CommandRecord>;
  getAgentSummary(
    input: WriteContext & { ref: OperationRef; subjectId: string },
  ): Promise<import('./types').AgentSummary>;
  listAgentSummaries(
    input: WriteContext &
      RecordScope & { subjectId: string; afterSeq?: string; upperSeq?: string; limit?: number },
  ): Promise<import('./types').AgentSummaryPage>;
  ensureAgentFollowUp(input: EnsureAgentFollowUpInput): Promise<OperationRef>;
  markDispatching(input: DispatchInput): Promise<ExecutionRecord>;
  /** Persists an actual started handle even if cancellation won while start was in flight. */
  markRunning(
    input: OwnedWrite & { executionId: string; reference: Json },
  ): Promise<ExecutionRecord>;
  /** Bounded output facts are separate from the terminal result and may report a dropped interval. */
  appendExecutionOutput(
    input: OwnedWrite & {
      executionId: string;
      stream: ExecutionOutputRecord['stream'];
      content: string;
      droppedBytes?: string;
    },
  ): Promise<ExecutionOutputRecord>;
  listExecutionOutput(input: {
    executionId: string;
    afterSeq?: string;
    upperSeq?: string;
    limit?: number;
  }): Promise<ExecutionOutputPage>;
  finishExecution(input: FinishExecutionInput): Promise<ExecutionRecord>;
  getExecution(id: string): Promise<ExecutionRecord | null>;
  listExecutions(sessionId: string, limit?: number): Promise<ExecutionRecord[]>;
  persistModelPartial(
    input: OwnedWrite & {
      executionId: string;
      content: string;
      modelOutput?: import('../model-output').ModelOutputReference;
    },
  ): Promise<void>;
  listMessages(
    sessionId: string,
    options?: { limit?: number; afterSeq?: string; upperSeq?: string },
  ): Promise<MessageRecord[]>;
  getView(sessionId: string): Promise<SessionView>;
  getExtensionRecord(input: RecordScope & { key: string }): Promise<ExtensionRecord | null>;
  listExtensionRecords(
    input: RecordScope & { afterKey?: string; limit?: number; contentType?: string },
  ): Promise<ExtensionRecord[]>;
  writeExtensionRecord(
    input: OwnedWrite &
      RecordScope & {
        originCommandId: string;
        originExecutionId?: string;
        write: ExtensionRecordWrite;
      },
  ): Promise<ExtensionRecord>;
  ensureAuthorizationReview(
    input: EnsureAuthorizationReviewInput,
  ): Promise<AuthorizationReviewFact>;
  getAuthorizationReview(input: ReadAuthorizationReviewInput): Promise<AuthorizationReviewResult>;
  ensureOperation(input: EnsureOperationInput): Promise<OperationRef>;
  getOperation(
    input: RecordScope & { key: string; subjectId: string; originStoreId: string },
  ): Promise<OperationRef | null>;
  planAction(input: PlanActionInput): Promise<ExecutionRecord>;
  applyExtensionAction(
    input: FinishExecutionInput & {
      writes?: ExtensionRecordWrite[];
      extensionId: string;
      preparingNextAttempt?: boolean;
    },
  ): Promise<ExecutionRecord>;
  stopActionPreparation(
    input: OwnedWrite & {
      commandId: string;
      predecessorExecutionId: string;
      reason: string;
      cancelled: boolean;
    },
  ): Promise<CommandRecord>;
  /** Explicit local interruption only. It acquires the OS lock and never dispatches an adapter. */
  readRecoveryToolHistory(
    input: WriteContext & {
      sessionId: string;
      subjectId: string;
      expectedOwnerGeneration: string;
    },
  ): Promise<import('./recovery-history').RecoveryToolHistory[]>;
  recoverSession(
    input: WriteContext & {
      commandId: string;
      sessionId: string;
      subjectId: string;
      expectedOwnerGeneration: string;
      decision: 'interrupt';
      toolHistoryProofs?: import('./recovery-history').RecoveryToolHistoryProof[];
    },
  ): Promise<RecoveryReport>;
  setRunResultWait(
    input: OwnedWrite & { runId: string; executionIds: string[] },
  ): Promise<RunRecord>;
  finishRun(
    input: OwnedWrite & {
      runId: string;
      status: Extract<RunStatus, 'completed' | 'failed' | 'cancelled' | 'interrupted'>;
      reason?: string;
      requirements: RequirementEvaluation[];
    },
  ): Promise<RunRecord>;
  cancelCommand(input: CancelCommandInput): Promise<CommandRecord>;
  cancelWork(input: CancelWorkInput): Promise<CommandRecord>;
  getSessionLogs(input: {
    expectedStoreId: string;
    sessionId: string;
    /** Trusted observer actor, never supplied by public log query. */
    subjectId: string;
    afterCursor: string;
    upperCursor?: string;
    limit?: number;
  }): Promise<SessionLogPage>;
  getChanges(input: {
    after: string;
    limit?: number;
    sessionIds?: string[];
  }): Promise<{ metadata: StoreMetadata; events: ChangeEvent[] }>;
  registerArtifact(
    input: WriteContext & {
      refId: string;
      sessionId: string;
      subjectId: string;
      scope: ArtifactScope;
      hash: string;
      size: string;
      mediaType: string;
    },
  ): Promise<ArtifactReference>;
  getArtifactReference(
    input: WriteContext & {
      refId: string;
      sessionId: string;
      subjectId: string;
      scope: ArtifactScope;
    },
  ): Promise<ArtifactReference | null>;
  beginHostMutation(
    input: WriteContext & {
      commandId: string;
      subjectId: string;
      kind: HostMutationKind;
      scope: string;
      requestDigest: string;
      safeRequest: Json;
    },
  ): Promise<{ created: boolean; record: HostMutationRecord }>;
  finishHostMutation(
    input: WriteContext & {
      commandId: string;
      subjectId: string;
      requestDigest: string;
      state: Exclude<HostMutationRecord['state'], 'pending'>;
      receipt: Json;
    },
  ): Promise<HostMutationRecord>;
  getHostMutation(
    input: WriteContext & { commandId: string; subjectId: string },
  ): Promise<HostMutationRecord | null>;
  requestInteraction(
    input: OwnedWrite & {
      interactionId: string;
      informationPermission?: InformationPermissionStamp;
      executionId: string;
      attempt: number;
      kind: InteractionKind;
      definitionId: string;
      definitionVersion: string;
      inputDigest: string;
      policyRevision: string;
      requiredRefs: RequirementRef[];
      source: Json;
      request: Json;
    },
  ): Promise<InteractionRecord>;
  answerInteraction(
    input: WriteContext & {
      commandId: string;
      presentationSessionId: string;
      interactionId: string;
      expectedRevision: string;
      subjectId: string;
      answer: InteractionAnswer;
    },
  ): Promise<CommandRecord>;
  acceptInteractionDecision(
    input: OwnedWrite & {
      interactionId: string;
      informationPermission?: InformationPermissionStamp;
      executionId: string;
      attempt: number;
      decisionRevision: string;
      definitionId: string;
      definitionVersion: string;
      inputDigest: string;
      policyRevision: string;
      requirements: RequirementEvaluation[];
      freshness: { checked: boolean; source: Json };
    },
  ): Promise<InteractionRecord>;
  getInteraction(
    input: WriteContext & { interactionId: string; sessionId: string },
  ): Promise<InteractionRecord | null>;
  listInteractions(
    input: WriteContext & {
      sessionId: string;
      afterId?: string;
      limit?: number;
      state?: InteractionRecord['state'];
    },
  ): Promise<InteractionPage>;
  applyInput(input: ApplyInputInput): Promise<InputApplication>;
  listPendingInputs(
    input: WriteContext & {
      sessionId: string;
      kind?: 'input.steer' | 'input.follow_up';
      targetRunId?: string;
      afterSeq?: string;
      limit?: number;
    },
  ): Promise<PendingInputPage>;
  selectContext(
    input: WriteContext & {
      commandId: string;
      sessionId: string;
      subjectId: string;
      expectedContextSelectionId: string;
      boundary: { messageId: string; seq: string } | null;
    },
  ): Promise<{ command: CommandRecord; selection: ContextSelection }>;
  getCompressionOrigin(
    input: WriteContext & { sessionId: string; subjectId: string; compressionId: string },
  ): Promise<import('./types').CompressionRecord>;
  beginCompression(
    input: OwnedWrite & {
      runId: string;
      executionId: string;
      expectedContextSelectionId: string;
      compressor: { id: string; version: string; snapshot: Json };
      trigger: 'manual' | 'automatic';
    },
  ): Promise<import('./types').CompressionRecord>;
  commitCompression(
    input: OwnedWrite & {
      runId: string;
      compressionId: string;
      requirements?: RequirementEvaluation[];
    },
  ): Promise<import('./types').CompressionRecord>;
  resetCompression(
    input: OwnedWrite & {
      runId: string;
      expectedContextSelectionId: string;
      expectedCompressionId: string | null;
      expectedHighWaterSeq?: string;
      requirements?: RequirementEvaluation[];
    },
  ): Promise<{ reset: boolean }>;
  getModelContext(input: Parameters<Store['getSelectedContext']>[0]): Promise<SelectedContextPage>;
  getExpandedContext(
    input: Parameters<Store['getSelectedContext']>[0],
  ): Promise<SelectedContextPage>;
  renameSession(input: {
    expectedStoreId: string;
    subjectId: string;
    commandId: string;
    sessionId: string;
    ifRevision: string;
    title: string;
  }): Promise<{ command: CommandRecord; session: SessionRecord }>;
  deleteSession(input: {
    expectedStoreId: string;
    subjectId: string;
    commandId: string;
    sessionId: string;
    ifRevision: string;
  }): Promise<{ command: CommandRecord; session: SessionRecord }>;
  forkSession(
    input: WriteContext & {
      /** Host-prepared only; Runtime public Fork input never accepts this plan. */
      namespacePlan?: ForkNamespacePlan;
      commandId: string;
      subjectId: string;
      sourceSessionId: string;
      expectedContextSelectionId: string;
      boundary?: { messageId: string; seq: string } | null;
      newSessionId: string;
      title: string;
    },
  ): Promise<{
    command: CommandRecord;
    session: SessionRecord;
    selection: ContextSelection;
    omittedExtensionState: boolean;
    namespaceReport?: ForkNamespaceReport[];
  }>;
  /** Trusted, current-namespace observer. Foreign identities are derived only from sealed Fork provenance. */
  prepareForkReadonlySources(
    input: WriteContext & {
      sessionId: string;
      subjectId: string;
      extensionId: string;
      declarations: readonly import('../extensions/fork').ForkReadSourceDeclaration[];
    },
  ): Promise<import('./types').ForkReadonlyProof>;
  readForkSourceMessage(
    input: WriteContext & {
      sessionId: string;
      subjectId: string;
      extensionId: string;
      localKey: string;
      messageId: string;
    },
  ): Promise<import('./types').ForkSourceMessage>;
  readForkSourceProjection(
    input: WriteContext & {
      sessionId: string;
      subjectId: string;
      extensionId: string;
      localKey: string;
    },
  ): Promise<import('./types').ForkSourceObservation>;
  readForkRecordSources(
    input: WriteContext & {
      sessionId: string;
      subjectId: string;
      extensionId: string;
      localKey: string;
    },
  ): Promise<import('./types').ForkRecordSources>;
  getMessageOrigin(
    input: WriteContext & { sessionId: string; subjectId: string; messageId: string },
  ): Promise<{ message: MessageRecord; subjectId: string }>;
  consumeJobResult(
    input: OwnedWrite & {
      commandId: string;
      sessionId: string;
      executionId: string;
      resultRevision: string;
      contextSelectionId: string;
      targetRunId?: string;
      requiredRef?: RequirementRef;
      requiredDiagnostic?: boolean;
    },
  ): Promise<{ command: CommandRecord; source: ResultContextSource }>;
  includeResult(
    input: WriteContext & {
      commandId: string;
      sessionId: string;
      subjectId: string;
      expectedContextSelectionId: string;
      executionId: string;
      resultRevision: string;
      targetRunId?: string;
    },
  ): Promise<{ command: CommandRecord; source: ResultContextSource }>;
  listPendingJobResults(
    input: WriteContext & {
      sessionId: string;
      afterCursor?: string;
      upperCursor?: string;
      limit?: number;
    },
  ): Promise<PendingJobResultPage>;
  readOriginalRunSelection(input: {
    expectedStoreId: string;
    sessionId: string;
    subjectId: string;
    runId: string;
  }): Promise<{ selection: ContextSelection; highWaterSeq: string }>;
  getSelectedContext(
    input: WriteContext & {
      sessionId: string;
      contextSelectionId?: string;
      afterSeq?: string;
      upperSeq?: string;
      messageLimit?: number;
      afterSourceId?: string;
      sourceLimit?: number;
      byteLimit?: number;
    },
  ): Promise<SelectedContextPage>;
  close(): Promise<void>;
}
