export type WebSessionStatus =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'unavailable';

export type WebPresentationBlock =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string; readonly complete: boolean }
  | {
      readonly kind: 'tool_activity';
      readonly toolId: string;
      readonly label: string;
      readonly status: 'queued' | 'running';
      readonly summary?: string;
    }
  | {
      readonly kind: 'tool_result';
      readonly toolId: string;
      readonly label: string;
      readonly ok: boolean;
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode?: number;
    }
  | { readonly kind: 'error'; readonly code: string; readonly text: string }
  | { readonly kind: 'status'; readonly status: WebSessionStatus; readonly text?: string };

export interface WebPresentationMessage {
  readonly messageId: string;
  readonly sequence: number;
  readonly role: 'user' | 'assistant' | 'system';
  readonly blocks: readonly WebPresentationBlock[];
}

export interface WebSessionSummary {
  readonly sessionId: string;
  readonly displayName: string;
  readonly updatedAt: number;
  readonly lastSequence: number;
  readonly status: WebSessionStatus;
}

export interface WebWorkspaceSummary {
  readonly workspaceId: string;
  readonly label: string;
  readonly sessionCount: number;
  readonly sessionState: 'idle' | 'loading' | 'loaded' | 'unavailable';
  readonly sessions: readonly WebSessionSummary[];
}

export interface WebDirectorySnapshot {
  readonly workspaces: readonly WebWorkspaceSummary[];
}

export interface WebHistorySnapshot {
  readonly sessionId: string;
  readonly messages: readonly WebPresentationMessage[];
  readonly observedLastSequence: number;
}

export interface WebCheckpointSummary {
  readonly checkpointId: string;
  readonly revision: number;
  readonly scope: 'conversation_only' | 'conversation_and_workspace' | 'code_only';
  readonly createdAt?: number;
  readonly label?: string;
}

export interface WebCheckpointSnapshot {
  readonly sessionId: string;
  readonly checkpoints: readonly WebCheckpointSummary[];
}
