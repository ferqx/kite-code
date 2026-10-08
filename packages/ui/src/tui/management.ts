import type {
  Command,
  CompressContextRequest,
  DeleteSessionRequest,
  ForkSessionRequest,
  IncludeResultRequest,
  RenameSessionRequest,
  ResetCompressionRequest,
  SelectContextRequest,
  SelectedContextPage,
  SessionView,
} from '@kite-ai/client';
export type TuiManagementIntent =
  | { kind: 'session.rename'; sessionId: string; request: RenameSessionRequest }
  | { kind: 'session.delete'; sessionId: string; request: DeleteSessionRequest }
  | { kind: 'session.fork'; sessionId: string; request: ForkSessionRequest }
  | { kind: 'context.compress'; sessionId: string; request: CompressContextRequest }
  | { kind: 'context.compression.reset'; sessionId: string; request: ResetCompressionRequest }
  | { kind: 'context.select'; sessionId: string; request: SelectContextRequest }
  | {
      kind: 'result.include';
      sessionId: string;
      executionId: string;
      request: IncludeResultRequest;
    };
export interface TuiManagementOutcome {
  intent: TuiManagementIntent;
  status: 'applied' | 'accepted' | 'queued' | 'delete_requested' | 'failed' | 'outcome_unknown';
  command?: Command;
  omittedExtensionState?: true;
}
export interface TuiManagementPort {
  /** Read only the original root control metadata; this does not select or resume it. */
  readSessionControl?(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<{ storeId: string; session: SessionView['session'] }>;
  readContext(
    sessionId: string,
    contextSelectionId: string,
    signal: AbortSignal,
  ): Promise<SelectedContextPage>;
  manage(intent: TuiManagementIntent): Promise<TuiManagementOutcome>;
  lookup(intent: TuiManagementIntent): Promise<TuiManagementOutcome>;
  newSession(): Promise<string>;
  quit(): void;
}

export interface TuiSessionDeletion {
  sessionId: string;
  title: string;
  sourceSessionId: string;
  workspaceId: string;
  phase: 'reading' | 'ready' | 'submitting' | 'delete_requested' | 'outcome_unknown' | 'failed';
  session?: SessionView['session'];
  intent?: Extract<TuiManagementIntent, { kind: 'session.delete' }>;
  error?: string;
}

export interface TuiFileRecoveryPort {
  listPoints(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<import('@kite-ai/client').FileCheckpointPage>;
  readPoint(
    sessionId: string,
    pointId: string,
    signal?: AbortSignal,
  ): Promise<{
    boundary: import('@kite-ai/client').FileCheckpointRecoveryBoundary;
    preview: import('@kite-ai/client').FileCheckpointDetail;
  }>;
  begin(
    sessionId: string,
    pointId: string,
    scope: import('@kite-ai/client/file-recovery-intent').FileRecoveryIntent['scope'],
    signal?: AbortSignal,
  ): Promise<import('@kite-ai/client/file-recovery-intent').FileRecoveryIntent>;
  continue(
    intent: import('@kite-ai/client/file-recovery-intent').FileRecoveryIntent,
    signal?: AbortSignal,
  ): Promise<import('@kite-ai/client/file-recovery-intent').FileRecoveryIntent>;
  lookup(
    intent: import('@kite-ai/client/file-recovery-intent').FileRecoveryIntent,
    signal?: AbortSignal,
  ): Promise<import('@kite-ai/client/file-recovery-intent').FileRecoveryIntent>;
  listSaved(): Promise<import('@kite-ai/client/file-recovery-intent').FileRecoveryIntent[]>;
}
