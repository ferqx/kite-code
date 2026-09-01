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
  | {
      readonly kind: 'tool_rejected';
      readonly toolId: string;
      readonly label: string;
      readonly summary?: string;
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

export interface WebSessionLogEntry {
  readonly sequence: number;
  readonly occurredAt: number;
  readonly eventType: string;
  readonly category:
    | 'session'
    | 'turn'
    | 'model'
    | 'tool'
    | 'interaction'
    | 'subagent'
    | 'verification'
    | 'recovery'
    | 'other';
  readonly status: 'ok' | 'running' | 'waiting' | 'cancelled' | 'failed' | 'unknown';
  readonly summary?: string;
  readonly detail: {
    readonly kind: string;
    readonly fields: readonly { readonly name: string; readonly value: string }[];
    readonly artifact?: { readonly kind: string; readonly availability: string };
  };
}

export interface WebSessionLogSnapshot {
  readonly sessionId: string;
  readonly entries: readonly WebSessionLogEntry[];
  readonly observedLastSequence: number;
}

export type WebModelContextPart =
  | { readonly type: 'text'; readonly text: string; readonly truncated: boolean }
  | { readonly type: 'reasoning'; readonly text: string; readonly truncated: boolean }
  | {
      readonly type: 'tool_call';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly inputJson: string;
      readonly truncated: boolean;
    }
  | {
      readonly type: 'tool_result';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly output: string;
      readonly truncated: boolean;
    };

export interface WebModelContextSnapshot {
  readonly sessionId: string;
  readonly invocationId: string;
  readonly sequence: number;
  readonly purpose: 'primary_agent' | 'context_compaction' | 'auto_review' | 'subagent';
  readonly model: { readonly provider: string; readonly name: string };
  readonly systemPrompt: { readonly text: string; readonly truncated: boolean };
  readonly messages: readonly {
    readonly index: number;
    readonly role: 'user' | 'assistant' | 'tool';
    readonly parts: readonly WebModelContextPart[];
  }[];
  readonly messagesTruncated: boolean;
  readonly tools: readonly {
    readonly name: string;
    readonly description?: string;
    readonly inputSchemaJson: string;
    readonly truncated: boolean;
  }[];
  readonly toolsTruncated: boolean;
  readonly requestSettings: {
    readonly transport: 'stream' | 'generate';
    readonly temperature: number;
    readonly maxOutputTokens: number | null;
    readonly messageCount: number;
    readonly toolCount: number;
  };
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
