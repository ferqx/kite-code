export interface Message {
  readonly id: string;
  /** Stable Runtime Turn ownership used for per-turn presentation actions. */
  readonly turnId?: string;
  readonly role: 'user' | 'assistant' | 'tool' | 'subagent' | 'system' | 'thinking';
  readonly text: string;
  readonly settled: boolean;
  /** A settled model response with no following tool calls is the Turn's final reply. */
  readonly finalReply?: boolean;
  /** Client-local delivery state used before the runtime projection owns the message. */
  readonly delivery?: 'sending' | 'failed' | 'unknown';
  readonly changedFile?: string;
  readonly changeConfirmed?: boolean;
  readonly toolResult?: {
    readonly ok: boolean;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly exitCode?: number;
  };
  readonly toolName?: string;
  readonly title?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly status?: 'running' | 'waiting' | 'completed' | 'failed' | 'rejected' | 'cancelled';
  readonly parentToolCallId?: string;
  readonly steps?: readonly {
    readonly id: string;
    readonly text: string;
    readonly status: 'started' | 'completed' | 'failed' | 'cancelled';
  }[];
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly displayName: string;
  readonly status: string;
  readonly updatedAt?: string;
  readonly pendingInteractions?: number;
}
export interface WorkspaceSummary {
  readonly muted?: boolean;
  readonly id: string;
  readonly label: string;
  readonly sessions: readonly SessionSummary[];
  readonly sessionCount: number;
  readonly state: 'idle' | 'loading' | 'loaded' | 'unavailable';
}
