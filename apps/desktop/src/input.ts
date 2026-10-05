import {
  type AgentClient,
  type CallerCommandRequest,
  type CancelCommandRequest,
  ClientError,
  type Command,
  type FollowUpCommandRequest,
  type Run,
  type StartCommandRequest,
  type SteerCommandRequest,
} from '@kite-ai/client';

export type InputRequest = StartCommandRequest | SteerCommandRequest | FollowUpCommandRequest;
export interface InputSubmission {
  readonly sessionId: string;
  readonly intent: InputRequest | CancelCommandRequest;
  readonly phase:
    | 'submitting'
    | 'accepted'
    | 'applied'
    | 'rejected'
    | 'unknown'
    | 'failed'
    | 'terminal';
  readonly command?: Command;
  readonly run?: Run;
  readonly error?: string;
}
export type InputMetadata = Omit<InputSubmission, 'intent'> & {
  draft?: { id: string; revision: string; textDigest: string };
  intent: Pick<CallerCommandRequest, 'kind' | 'expectedStoreId' | 'commandId'>;
};
export const inputMetadata = (value: InputSubmission): InputMetadata => {
  const { intent, ...rest } = value;
  return {
    ...rest,
    intent: {
      kind: intent.kind,
      commandId: intent.commandId,
      expectedStoreId: intent.expectedStoreId,
    },
  };
};
export interface InputCallerPort {
  submit(sessionId: string, input: InputRequest | CancelCommandRequest): Promise<Command>;
  lookup(commandId: string): Promise<Command>;
}
export interface InputOptions {
  readonly caller?: InputCallerPort;
  readonly admittedClient: AgentClient;
  readonly onSubmission?: (submission: InputSubmission) => void;
  readonly maxIntents?: number;
}
interface Entry {
  state: InputSubmission;
  promise?: Promise<InputSubmission>;
  readGeneration?: number;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function identity(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(identity).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${identity(child)}`)
    .join(',')}}`;
}
function runId(state: InputSubmission): string | undefined {
  if (state.intent.kind === 'command.cancel') return undefined;
  if (state.intent.kind === 'input.steer') return state.intent.targetRunId;
  const receipt = state.command?.receipt;
  return receipt &&
    typeof receipt === 'object' &&
    !Array.isArray(receipt) &&
    typeof receipt.runId === 'string'
    ? receipt.runId
    : undefined;
}

/** Intent ownership is independent of selected view and Service lifetime. */
export class DesktopInput {
  private readonly client: AgentClient;
  private readonly options: InputOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly cancellations = new Map<string, string>();
  private readonly reads = new Set<AbortController>();
  private readonly limit: number;
  private disposed = false;

  constructor(options: InputOptions) {
    this.options = options;
    this.client = options.admittedClient;
    this.limit = options.maxIntents ?? 128;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1)
      throw new Error('invalid_intent_limit');
    if (!this.client.serverInfo) throw new Error('client_not_admitted');
  }
  get submissions(): readonly InputSubmission[] {
    return [...this.entries.values()].map((entry) => entry.state);
  }
  private publish(entry: Entry, state: InputSubmission): InputSubmission {
    entry.state = freeze(structuredClone(state));
    if (!this.disposed) {
      try {
        this.options.onSubmission?.(entry.state);
      } catch {
        /* Presentation cannot alter a receipt. */
      }
    }
    return entry.state;
  }
  private submit(
    sessionId: string,
    input: InputRequest | CancelCommandRequest,
  ): Promise<InputSubmission> {
    if (this.disposed) throw new Error('input_disposed');
    const prior = this.entries.get(input.commandId);
    if (prior) {
      if (prior.state.sessionId !== sessionId || identity(prior.state.intent) !== identity(input))
        throw new Error('input_identity_conflict');
      return prior.promise ?? Promise.resolve(prior.state);
    }
    // Reserve bounded cancellation identities even when all work-intent slots are occupied.
    if (
      input.kind !== 'command.cancel' &&
      [...this.entries.values()].filter((entry) => entry.state.intent.kind !== 'command.cancel')
        .length >= this.limit
    )
      throw new Error('input_intent_limit');
    const intent = freeze(structuredClone(input));
    const entry: Entry = { state: freeze({ sessionId, intent, phase: 'submitting' }) };
    this.entries.set(intent.commandId, entry);
    entry.promise = Promise.resolve()
      .then(async () => {
        try {
          // Network detach does not revoke this saved work intent. Client never retries mutations.
          const command = this.options.caller
            ? await this.options.caller.submit(sessionId, intent)
            : intent.kind === 'run.start'
              ? await this.client.startRun(sessionId, intent)
              : intent.kind === 'input.steer'
                ? await this.client.steer(sessionId, intent)
                : intent.kind === 'input.follow_up'
                  ? await this.client.followUp(sessionId, intent)
                  : await this.client.cancelCommand(sessionId, intent);
          return this.acceptCommand(entry, command);
        } catch (error) {
          return this.publish(entry, {
            ...entry.state,
            phase:
              error instanceof ClientError &&
              ((error.status !== undefined && error.status < 500) ||
                [
                  'invalid_request',
                  'connection_not_admitted',
                  'data_unavailable',
                  'capability_unavailable',
                ].includes(error.code))
                ? 'failed'
                : 'unknown',
            error: error instanceof ClientError ? error.code : 'input_response_unknown',
          });
        }
      })
      .finally(() => {
        entry.promise = undefined;
      });
    this.publish(entry, entry.state);
    return entry.promise;
  }
  private acceptCommand(entry: Entry, command: Command): InputSubmission {
    const { intent, sessionId } = entry.state;
    if (
      command.id !== intent.commandId ||
      command.sessionId !== sessionId ||
      command.originStoreId !== intent.expectedStoreId ||
      command.kind !== intent.kind
    )
      throw new Error('input_receipt_identity_mismatch');
    return this.publish(entry, {
      ...entry.state,
      command,
      phase: command.status === 'needs_review' ? 'unknown' : command.status,
    });
  }
  start(sessionId: string, input: StartCommandRequest) {
    if (input.kind !== 'run.start') throw new Error('invalid_input_kind');
    return this.submit(sessionId, input);
  }
  steer(sessionId: string, input: SteerCommandRequest) {
    if (input.kind !== 'input.steer') throw new Error('invalid_input_kind');
    return this.submit(sessionId, input);
  }
  followUp(sessionId: string, input: FollowUpCommandRequest) {
    if (input.kind !== 'input.follow_up') throw new Error('invalid_input_kind');
    return this.submit(sessionId, input);
  }

  /** One cancellation intent per original work; repeat clicks never select another active Run. */
  cancel(commandId: string, cancelCommandId: string): Promise<InputSubmission> {
    const work = this.entries.get(commandId)?.state;
    if (!work || work.intent.kind === 'command.cancel') throw new Error('input_intent_missing');
    const existing = this.cancellations.get(commandId);
    if (existing) {
      const entry = this.entries.get(existing)!;
      return entry.promise ?? Promise.resolve(entry.state);
    }
    const input: CancelCommandRequest = {
      kind: 'command.cancel',
      expectedStoreId: work.intent.expectedStoreId,
      commandId: cancelCommandId,
      targetCommandId: work.intent.commandId,
    };
    const result = this.submit(work.sessionId, input);
    this.cancellations.set(commandId, cancelCommandId);
    return result;
  }
  /** Unknown receipt is resolved only by reads of the saved original identity. */
  async lookup(commandId: string): Promise<InputSubmission> {
    if (this.disposed) throw new Error('input_disposed');
    const entry = this.entries.get(commandId);
    if (!entry) throw new Error('input_intent_missing');
    if (entry.promise) await entry.promise;
    if (this.disposed) throw new Error('input_disposed');
    const generation = (entry.readGeneration ?? 0) + 1;
    entry.readGeneration = generation;
    const controller = new AbortController();
    this.reads.add(controller);
    try {
      const command = await (this.options.caller
        ? this.options.caller.lookup(commandId)
        : this.client.getCommand(commandId, { signal: controller.signal }));
      if (generation !== entry.readGeneration) return entry.state;
      this.acceptCommand(entry, command);
      const id = runId(entry.state);
      if (id) {
        const run = await this.client.getRun(id, { signal: controller.signal });
        if (generation !== entry.readGeneration) return entry.state;
        if (
          run.sessionId !== entry.state.sessionId ||
          run.originStoreId !== entry.state.intent.expectedStoreId ||
          (entry.state.intent.kind !== 'input.steer' && run.originCommandId !== commandId)
        )
          throw new Error('input_run_identity_mismatch');
        this.publish(entry, {
          ...entry.state,
          run,
          phase: ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
            ? 'terminal'
            : entry.state.phase,
        });
      }
      return entry.state;
    } finally {
      this.reads.delete(controller);
    }
  }
  /** Stop only this module's pending reads and callbacks; never stop a Service or cancel work. */
  disposeObserver(): void {
    this.disposed = true;
    for (const read of this.reads) read.abort();
    this.reads.clear();
  }
}
