export interface Message {
  readonly id: string;
  /** Stable Runtime Turn ownership used for per-turn presentation actions. */
  readonly turnId?: string;
  readonly role: 'user' | 'assistant' | 'tool' | 'subagent' | 'system' | 'thinking';
  readonly text: string;
  readonly settled: boolean;
  /** Client-observed reasoning segment timing, in epoch milliseconds. */
  readonly thinkingStartedAt?: number;
  readonly thinkingEndedAt?: number;
  /** A settled model response with no following tool calls is the Turn's final reply. */
  readonly finalReply?: boolean;
  /** Client-local delivery state used before the runtime projection owns the message. */
  readonly delivery?: 'sending' | 'failed' | 'unknown';
  readonly systemKind?: 'compaction' | 'ask' | 'approval';
  readonly approval?: {
    readonly state: 'reviewing' | 'awaiting_user' | 'approved' | 'rejected';
    readonly source: 'auto' | 'user';
    readonly interactionId?: string;
    readonly grant?: 'approve_once' | 'same_command';
    readonly reason?: string;
  };
  readonly ask?: {
    readonly toolCallId?: string;
    readonly questions: readonly {
      readonly id: string;
      readonly question: string;
      readonly options?: readonly { readonly id: string; readonly label: string }[];
    }[];
    readonly answers?: Readonly<Record<string, string>>;
    readonly summary?: string;
  };
  readonly changedFile?: string;
  readonly changeConfirmed?: boolean;
  readonly toolResult?: {
    readonly ok: boolean;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly exitCode?: number;
    readonly status?: 'success' | 'error' | 'exhausted';
    readonly totalLines?: number;
    readonly terminationReason?: 'timed_out' | 'cancelled' | 'sandbox_denied';
  };
  /** Runtime-framed live output; it is not a terminal success/failure receipt. */
  readonly toolProgress?: {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly stdoutLines?: number;
    readonly stderrLines?: number;
  };
  readonly toolName?: string;
  /** Runtime-owned display classification; missing values remain standalone. */
  readonly presentation?: 'exploration' | 'standalone' | 'hidden';
  /** Exact child-task owner for internal tool presentation. */
  readonly presentationOwner?: {
    readonly subagentId: string;
    readonly parentToolCallId: string;
  };
  /** Opaque Runtime grouping identity used only for adjacent exploration calls. */
  readonly presentationGroupId?: string;
  readonly title?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly status?:
    | 'creating'
    | 'queued'
    | 'running'
    | 'waiting'
    | 'auto_reviewing'
    | 'completed'
    | 'interrupted'
    | 'failed'
    | 'rejected'
    | 'cancelled'
    | 'unknown';
  readonly parentToolCallId?: string;
  /** Exact child lifecycle shown on its parent Task card. */
  readonly childLifecycle?:
    | 'creating'
    | 'running'
    | 'waiting'
    | 'auto_reviewing'
    | 'completed'
    | 'interrupted'
    | 'cancelled'
    | 'failed';
  readonly steps?: readonly {
    readonly id: string;
    readonly toolCallId?: string;
    readonly toolName?: string;
    readonly text: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
    readonly summary?: string;
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
