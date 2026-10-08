export interface Message {
  readonly id: string;
  /** Host-confirmed Runtime Turn or public Run ownership for presentation actions. */
  readonly turnId?: string;
  readonly role: 'user' | 'assistant' | 'tool' | 'subagent' | 'system' | 'thinking';
  readonly text: string;
  readonly settled: boolean;
  /** Client-observed reasoning segment timing, in epoch milliseconds. */
  readonly thinkingStartedAt?: number;
  readonly thinkingEndedAt?: number;
  /** Source event times for one Turn; the timing marker is hidden from the transcript. */
  readonly turnStartedAtMs?: number;
  readonly turnFinishedAtMs?: number;
  /** A settled model response with no following tool calls is the Turn's final reply. */
  readonly finalReply?: boolean;
  /** Verified copy body; null keeps a preview from being copied as a complete reply. */
  readonly copyText?: string | null;
  /** Client-local delivery state used before the runtime projection owns the message. */
  readonly delivery?: 'sending' | 'failed' | 'unknown';
  readonly systemKind?:
    | 'compaction'
    | 'ask'
    | 'approval'
    | 'turn_timing'
    | 'turn_terminal'
    | 'turn_failure';
  /** Safe terminal facts for a reply failure; never an executable retry instruction. */
  readonly failure?: {
    readonly summary: string;
    readonly reasonCode?: string;
    readonly outcome?: {
      readonly status:
        | 'completed'
        | 'aborted'
        | 'blocked'
        | 'unknown'
        | 'budget_exhausted'
        | 'resource_saturated';
      readonly safeRetry: boolean;
      readonly recoveryEntry: 'none' | 'retry' | 'reconcile' | 'new_run' | 'operator_action';
    };
  };
  /** Exact terminal fact for a hidden Turn marker; independent of message status. */
  readonly turnTerminalStatus?: 'completed' | 'failed' | 'cancelled' | 'aborted';
  readonly approval?: {
    readonly state:
      | 'reviewing'
      | 'awaiting_user'
      | 'approved'
      | 'rejected'
      | 'submitted'
      | 'unavailable'
      | 'cancelled';
    readonly source: 'auto' | 'user';
    readonly interactionId?: string;
    readonly grant?: 'approve_once' | 'same_command';
    readonly reason?: string;
  };
  /** Host-confirmed dispatch fact; approval alone does not prove execution. */
  readonly dispatchCommitted?: boolean;
  readonly ask?: {
    /** Information cancellation is independent of the Tool or Run terminal state. */
    readonly cancelled?: boolean;
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
  /** Host-confirmed display classification; missing values remain standalone. */
  readonly presentation?: 'exploration' | 'standalone' | 'hidden';
  /** Exact child-task owner for internal tool presentation. */
  readonly presentationOwner?: {
    readonly subagentId: string;
    readonly parentToolCallId: string;
  };
  /** Opaque Runtime grouping identity used only for adjacent exploration calls. */
  readonly presentationGroupId?: string;
  readonly title?: string;
  /** Host-confirmed display text; this does not grant a file or execution action. */
  readonly target?: string;
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
    | 'recovery_required'
    | 'unknown';
  readonly parentToolCallId?: string;
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

/** Host-confirmed state for the current or most recently settled presentation Turn. */
export interface TurnActivity {
  readonly turnId: string;
  readonly unavailable?: boolean;
  readonly status:
    | 'queued'
    | 'running'
    | 'waiting'
    | 'cancelling'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'recovery_required';
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly displayName: string;
  readonly status: string;
  readonly updatedAt?: string;
  readonly pendingInteractions?: number;
  readonly waitingReason?: 'required_background';
}
export interface WorkspaceSummary {
  readonly muted?: boolean;
  readonly id: string;
  readonly label: string;
  readonly sessions: readonly SessionSummary[];
  readonly sessionCount: number;
  readonly state: 'idle' | 'loading' | 'loaded' | 'unavailable';
}
