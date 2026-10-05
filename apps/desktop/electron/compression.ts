import { createHash } from 'node:crypto';
import { type AgentClient, ClientError, type Command } from '@kite-ai/client';
import type { NativeCompressionSubmission } from '../src/native-bridge';

/** Window intents only. The Service owns compression, Model dispatch and publication. */
export class NativeCompression {
  private readonly entries = new Map<
    string,
    { state: NativeCompressionSubmission; focus?: string; promise?: Promise<Command> }
  >();
  private readonly client: AgentClient;
  private readonly notify: () => void;
  constructor(client: AgentClient, notify: () => void) {
    this.client = client;
    this.notify = notify;
  }
  get submissions() {
    return [...this.entries.values()].map((entry) => structuredClone(entry.state));
  }
  submit(
    input: {
      sessionId: string;
      rootSessionId: string;
      storeId: string;
      selectionId: string;
      compressionId: string | null;
      kind: 'compress' | 'reset';
      focus?: string;
    },
    verify: () => Promise<void>,
  ) {
    const focus = input.focus;
    if (focus !== undefined && (typeof focus !== 'string' || Buffer.byteLength(focus) > 1048576))
      throw new ClientError('invalid_compression_focus');
    const digest = createHash('sha256')
      .update(focus ?? '')
      .digest('hex');
    const key = JSON.stringify([
      input.storeId,
      input.sessionId,
      input.selectionId,
      input.compressionId,
      input.kind,
      digest,
    ]);
    const old = this.entries.get(key);
    if (old?.promise) return old.promise;
    if (old) throw new ClientError('compression_intent_already_saved');
    if (
      [...this.entries.values()].some((entry) =>
        ['saved', 'submitting', 'unknown', 'accepted'].includes(entry.state.phase),
      )
    )
      throw new ClientError('compression_intent_pending');
    if (this.entries.size >= 128) throw new ClientError('compression_intent_limit');
    const state: NativeCompressionSubmission = {
      kind: input.kind,
      sessionId: input.sessionId,
      rootSessionId: input.rootSessionId,
      phase: 'saved',
      intent: {
        expectedStoreId: input.storeId,
        commandId: crypto.randomUUID(),
        expectedContextSelectionId: input.selectionId,
        expectedCompressionId: input.compressionId,
        focusBytes: Buffer.byteLength(focus ?? ''),
        focusHash: digest,
      },
    };
    const entry: {
      state: NativeCompressionSubmission;
      focus?: string;
      promise?: Promise<Command>;
    } = { state, focus };
    this.entries.set(key, entry);
    this.notify();
    entry.promise = (async () => {
      let dispatched = false;
      try {
        await verify();
        entry.state.phase = 'submitting';
        this.notify();
        dispatched = true;
        const base = {
          expectedStoreId: state.intent.expectedStoreId,
          commandId: state.intent.commandId,
          expectedContextSelectionId: state.intent.expectedContextSelectionId,
        };
        const command =
          state.kind === 'compress'
            ? await this.client.compressContext(state.sessionId, {
                ...base,
                ...(focus === undefined ? {} : { focus }),
              })
            : await this.client.resetCompressionContext(state.sessionId, {
                ...base,
                expectedCompressionId: state.intent.expectedCompressionId,
              });
        return await this.apply(entry, command);
      } catch (error) {
        const value = error as { code?: string; status?: number };
        entry.state.phase =
          !dispatched || (value.status !== undefined && value.status >= 400 && value.status < 500)
            ? 'failed'
            : 'unknown';
        entry.state.error =
          value.code && /^[a-z][a-z0-9_]{0,80}$/.test(value.code)
            ? value.code
            : 'network_outcome_unknown';
        throw error;
      } finally {
        entry.promise = undefined;
        this.notify();
      }
    })();
    return entry.promise;
  }
  private async apply(entry: { state: NativeCompressionSubmission }, command: Command) {
    const state = entry.state;
    if (
      command.id !== state.intent.commandId ||
      command.originStoreId !== state.intent.expectedStoreId ||
      command.sessionId !== state.sessionId ||
      command.kind !==
        (state.kind === 'compress' ? 'context.compress' : 'context.compression.reset')
    )
      throw new ClientError('compression_receipt_mismatch');
    const receipt = command.receipt;
    const runId =
      receipt &&
      typeof receipt === 'object' &&
      !Array.isArray(receipt) &&
      typeof receipt.runId === 'string'
        ? receipt.runId
        : undefined;
    let run: NativeCompressionSubmission['run'];
    if (runId) {
      const view = await this.client.getView(state.sessionId);
      if (
        view.storeId !== state.intent.expectedStoreId ||
        view.session.id !== state.sessionId ||
        (view.session.rootSessionId ?? view.session.id) !== state.rootSessionId
      )
        throw new ClientError('compression_scope_mismatch');
      run = view.runs.find(
        (value) =>
          value.id === runId &&
          value.sessionId === state.sessionId &&
          value.originCommandId === state.intent.commandId,
      );
      if (!run) throw new ClientError('compression_run_unavailable');
    }
    entry.state = {
      ...state,
      command: structuredClone(command),
      ...(run ? { run: structuredClone(run) } : {}),
      phase:
        command.status === 'rejected'
          ? 'failed'
          : command.status === 'applied'
            ? 'applied'
            : command.status === 'accepted'
              ? 'accepted'
              : 'unknown',
      error: undefined,
    };
    return command;
  }
  lookup(commandId: string) {
    const entry = [...this.entries.values()].find(
      (value) => value.state.intent.commandId === commandId,
    );
    if (!entry) throw new ClientError('compression_intent_not_saved');
    if (entry.promise) return entry.promise;
    entry.promise = this.client
      .getCommand(commandId)
      .then((command) => this.apply(entry, command))
      .finally(() => {
        entry.promise = undefined;
        this.notify();
      });
    return entry.promise;
  }
}
