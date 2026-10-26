import type { ExtensionCatalogue, Json, PublicView } from '@kite-ai/client';
import {
  AGENT_BROWSER_EXTENSION,
  type AgentBrowserView,
  readAgentBrowserView,
} from './agent-browser-view';
import type { NativeExtensionScope, NativeExtensionSubmission } from './extensions-bridge';
import type { NativeBridge, NativeCallerMetadata } from './native-bridge';
import { readNativeExtensionBody } from './native-extension-read';

export type AgentBrowserAction = 'handoff' | 'resume' | 'input' | 'select' | 'close';
export type AgentBrowserObservation = {
  view?: AgentBrowserView;
  fresh: boolean;
  loading: boolean;
  available: boolean;
  pending: boolean;
  error?: string;
};
// Only unresolved original IDs survive a panel's observation lifecycle. Never replay an input.
const originals = new WeakMap<NativeBridge, Map<string, Set<string>>>();
function pendingOriginals(bridge: NativeBridge, scope: NativeExtensionScope) {
  let sessions = originals.get(bridge);
  if (!sessions) {
    sessions = new Map();
    originals.set(bridge, sessions);
  }
  const key = JSON.stringify([scope.storeId, scope.workspaceId, scope.sessionId]);
  let commands = sessions.get(key);
  if (!commands) {
    commands = new Set();
    sessions.set(key, commands);
  }
  return commands;
}

/** One bounded latest observation, through Main's existing verified extension reader only. */
export class AgentBrowserObserver {
  private readonly bridge: NativeBridge;
  private readonly scope: NativeExtensionScope;
  private readonly changed: (state: AgentBrowserObservation) => void;
  private readonly pending: Set<string>;
  private state: AgentBrowserObservation;
  private catalogue?: ExtensionCatalogue;
  private observation?: number;
  private active = false;
  private visible = false;
  private epoch = 0;
  private reading = false;
  private invoking = false;
  private canInvoke: boolean;
  private timer?: ReturnType<typeof setTimeout>;
  private freshnessTimer?: ReturnType<typeof setTimeout>;
  private nextLookup = 0;
  private actionError?: string;
  private readonly retiredGenerations = new Set<string>();

  constructor(
    bridge: NativeBridge,
    scope: NativeExtensionScope,
    changed: (state: AgentBrowserObservation) => void,
    canInvoke: boolean,
    submissions: readonly NativeCallerMetadata[] = [],
  ) {
    this.bridge = bridge;
    this.scope = scope;
    this.changed = changed;
    this.canInvoke = canInvoke;
    this.pending = pendingOriginals(bridge, scope);
    for (const row of submissions) {
      if (
        row.request.kind === 'extension.invoke' &&
        ['submitting', 'unknown', 'accepted'].includes(row.phase) &&
        row.scope.storeId === scope.storeId &&
        row.scope.sessionId === scope.sessionId &&
        row.scope.workspaceId === scope.workspaceId
      )
        this.pending.add(row.request.commandId);
    }
    this.state = { fresh: false, loading: true, available: false, pending: this.pending.size > 0 };
  }
  private publish(patch: Partial<AgentBrowserObservation>) {
    if ('error' in patch && patch.error === undefined) patch.error = this.actionError;
    this.state = { ...this.state, ...patch, pending: this.pending.size > 0 };
    if (this.active) this.changed(this.state);
  }
  start(visible: boolean) {
    this.active = true;
    this.setVisible(visible);
  }
  setCanInvoke(value: boolean) {
    this.canInvoke = value;
  }
  setVisible(value: boolean) {
    if (!this.active || this.visible === value) return;
    this.visible = value;
    this.epoch++;
    clearTimeout(this.timer);
    clearTimeout(this.freshnessTimer);
    this.observation = undefined;
    this.catalogue = undefined;
    this.publish({ fresh: false });
    if (value) void this.poll();
    else this.release();
  }
  stop() {
    this.active = false;
    this.visible = false;
    this.epoch++;
    clearTimeout(this.timer);
    clearTimeout(this.freshnessTimer);
    this.release();
  }
  private release() {
    void this.bridge
      .request({ method: 'extensions.release', generation: this.scope.generation })
      .catch(() => {});
  }
  private current(epoch: number) {
    return this.active && this.visible && this.epoch === epoch;
  }
  private schedule(delay = 300) {
    clearTimeout(this.timer);
    if (this.active && this.visible) this.timer = setTimeout(() => void this.poll(), delay);
  }
  private async poll() {
    if (!this.active || !this.visible || this.reading || this.invoking) return;
    this.reading = true;
    const epoch = this.epoch;
    let delay = 300;
    try {
      if (!this.observation) {
        const body = await readNativeExtensionBody<ExtensionCatalogue>(
          this.bridge,
          {
            method: 'extensions.open',
            generation: this.scope.generation,
            readId: crypto.randomUUID(),
            viewSelection: this.scope.viewSelection,
            historyEpoch: this.scope.historyEpoch,
          },
          this.scope,
          'catalogue',
          () => this.current(epoch),
        );
        if (!this.current(epoch)) return;
        this.catalogue = body.value.find(
          (item) =>
            item.extensionId === AGENT_BROWSER_EXTENSION &&
            item.version === '1' &&
            item.queries.some((query) => query.id === 'browser.view' && query.version === '1'),
        );
        if (!this.catalogue) {
          this.publish({ available: false, loading: false, fresh: false, error: undefined });
          delay = 2000;
          return;
        }
        this.observation = body.head.observationId;
      }
      const body = await readNativeExtensionBody<PublicView>(
        this.bridge,
        {
          method: 'extensions.query',
          generation: this.scope.generation,
          readId: crypto.randomUUID(),
          observationId: this.observation,
          extensionId: AGENT_BROWSER_EXTENSION,
          queryId: 'browser.view',
          input: {},
        },
        this.scope,
        'views',
        () => this.current(epoch),
      );
      if (!this.current(epoch)) return;
      if (body.value.length > 1) throw Error('browser_view_ambiguous');
      const view = body.value[0] ? readAgentBrowserView(body.value[0]) : undefined;
      const previous = this.state.view;
      if (
        view &&
        previous &&
        view.browserId === previous.browserId &&
        (this.retiredGenerations.has(view.generation) ||
          (view.generation === previous.generation &&
            (BigInt(view.seq) < BigInt(previous.seq) ||
              (view.frame &&
                previous.frame &&
                BigInt(view.frame.seq) < BigInt(previous.frame.seq)))))
      )
        throw Error('browser_view_stale');
      if (
        view &&
        previous &&
        view.browserId === previous.browserId &&
        view.generation !== previous.generation
      )
        this.retiredGenerations.add(previous.generation);
      this.publish({ view, available: true, loading: false, fresh: true, error: undefined });
      clearTimeout(this.freshnessTimer);
      this.freshnessTimer = setTimeout(() => {
        if (this.current(epoch)) this.publish({ fresh: false });
      }, 1500);
      if (this.pending.size && Date.now() >= this.nextLookup) await this.lookup(epoch);
    } catch (cause) {
      if (this.current(epoch)) {
        this.observation = undefined;
        this.catalogue = undefined;
        this.publish({
          fresh: false,
          loading: false,
          error:
            cause instanceof Error && cause.message === 'browser_view_stale'
              ? '收到过期画面，等待最新状态。'
              : '暂时无法读取浏览器，正在重新核实。',
        });
      }
      delay = 1000;
    } finally {
      this.reading = false;
      if (!this.invoking) this.schedule(delay);
    }
  }
  private result(value: unknown, commandId: string): NativeExtensionSubmission | undefined {
    if (
      !value ||
      typeof value !== 'object' ||
      !('kind' in value) ||
      value.kind !== 'extensions.command'
    )
      return;
    const result = value as NativeExtensionSubmission;
    if (
      result.metadata?.request?.commandId !== commandId ||
      result.metadata.request.kind !== 'extension.invoke' ||
      result.metadata.scope?.storeId !== this.scope.storeId ||
      result.metadata.scope.sessionId !== this.scope.sessionId ||
      result.metadata.scope.workspaceId !== this.scope.workspaceId
    )
      return;
    return result;
  }
  private settle(result: NativeExtensionSubmission | undefined, commandId: string) {
    if (!result || !['succeeded', 'failed', 'cancelled', 'rejected'].includes(result.outcome))
      return false;
    this.pending.delete(commandId);
    if (result.outcome !== 'succeeded') {
      this.actionError = '浏览器操作未完成；请核对最新状态后再决定。';
      this.publish({ error: this.actionError });
    } else this.publish({});
    return true;
  }
  private async lookup(epoch: number) {
    this.nextLookup = Date.now() + 1000;
    for (const commandId of [...this.pending]) {
      if (!this.current(epoch)) return;
      try {
        const value = await this.bridge.request({
          method: 'extensions.lookup',
          generation: this.scope.generation,
          commandId,
        });
        this.settle(this.result(value, commandId), commandId);
      } catch {
        /* An unknown original remains pending; never submit again. */
      }
    }
    if (this.current(epoch)) this.publish({});
  }
  checkOriginal() {
    this.nextLookup = 0;
    this.schedule(0);
  }
  async invoke(action: AgentBrowserAction, input: Json): Promise<boolean> {
    const definition = this.catalogue?.actions.find(
      (item) => item.id === `browser.${action}` && item.version === '1',
    );
    const view = this.state.view;
    if (
      !this.active ||
      !this.visible ||
      !this.canInvoke ||
      !this.state.fresh ||
      !view ||
      !definition ||
      !this.observation ||
      this.invoking ||
      this.pending.size
    )
      return false;
    if (
      (['input', 'select', 'resume'].includes(action) && view.state !== 'human') ||
      (action === 'handoff' && view.state !== 'agent') ||
      (action === 'close' &&
        !['starting', 'agent', 'human', 'outcome_unknown'].includes(view.state))
    )
      return false;
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      input.browserId !== view.browserId ||
      input.generation !== view.generation
    )
      return false;
    if (
      action === 'select' &&
      (input.seq !== view.seq ||
        (input.ref !== null && !view.annotations.some((item) => item.ref === input.ref)))
    )
      return false;
    const command = input.command;
    if (
      action === 'input' &&
      command &&
      typeof command === 'object' &&
      !Array.isArray(command) &&
      ['click', 'fill'].includes(String(command.action)) &&
      (command.seq !== view.seq || !view.annotations.some((item) => item.ref === command.ref))
    )
      return false;
    const commandId = crypto.randomUUID(),
      observationId = this.observation;
    this.invoking = true;
    this.epoch++;
    clearTimeout(this.timer);
    clearTimeout(this.freshnessTimer);
    this.pending.add(commandId);
    this.actionError = undefined;
    this.publish({ fresh: false, error: undefined });
    try {
      const value = await this.bridge.request({
        method: 'extensions.invoke',
        generation: this.scope.generation,
        observationId,
        commandId,
        extensionId: AGENT_BROWSER_EXTENSION,
        actionId: definition.id,
        definitionVersion: definition.version,
        input,
      });
      this.settle(this.result(value, commandId), commandId);
    } catch {
      /* Keep the original command for lookup, including after closing this reader. */
    } finally {
      this.invoking = false;
      if (this.active) this.publish({});
      this.schedule(0);
    }
    return true;
  }
}
