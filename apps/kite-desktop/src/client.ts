import type {
  ProviderModelSnapshot,
  WorkspaceTrustQueryResponse,
} from '@kite-ai/kite-app-contract';
import {
  createAppServerProtocolConnection,
  KITE_APP_SERVER_PROTOCOL_METHODS_,
  type KiteAppServerConnection,
} from '@kite-ai/kite-local-runtime/client/protocol';
import type {
  RuntimeApprovalInteraction,
  RuntimeCommand,
  RuntimeInputInteraction,
  RuntimeInteractionResponse,
  RuntimePlanReviewInteraction,
  RuntimeSessionProjection,
} from '@kite-ai/runtime-contract';
import { invoke } from '@tauri-apps/api/core';
import { type ProviderInput, saveProvider } from './models';
import { type Message, projectEvent } from './presentation';
import { type DesktopConnectionInfo, type DesktopInvoke, desktopTransport } from './transport';

export interface DesktopView {
  workspace: string;
  connected: boolean;
  error?: string;
  trust?: WorkspaceTrustQueryResponse;
  models?: ProviderModelSnapshot;
  sessions: readonly RuntimeSessionProjection[];
  selected?: string;
  messages: readonly Message[];
  projection?: RuntimeSessionProjection;
  ready: boolean;
  loadingSession: boolean;
}

export class DesktopClient {
  private readonly call: DesktopInvoke;
  constructor(call: DesktopInvoke = invoke) {
    this.call = call;
  }

  #view: DesktopView = {
    workspace: '',
    connected: false,
    sessions: [],
    messages: [],
    ready: false,
    loadingSession: false,
  };
  #listeners = new Set<() => void>();
  #connection?: KiteAppServerConnection;
  #connectionId?: number;
  #selection?: AbortController;
  #unsubscribe?: () => void;
  #admitted = new Set<string>();
  getSnapshot = () => this.#view;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #publish(change: Partial<DesktopView>) {
    this.#view = { ...this.#view, ...change };
    for (const listener of this.#listeners) listener();
  }
  report(error: unknown) {
    this.#publish({ error: error instanceof Error ? error.message : String(error) });
  }
  clearError() {
    this.#publish({ error: undefined });
  }

  async openProject() {
    if (this.#connection) throw new Error('请先断开当前项目。');
    const selected = await this.call<string | null>('select_workspace');
    if (selected) await this.connect();
  }
  async connect() {
    if (this.#connection) await this.disconnect();
    const info = await this.call<DesktopConnectionInfo>('runtime_open');
    const connection = createAppServerProtocolConnection(
      desktopTransport(info, this.call),
      info.expectedServerVersion,
      { name: 'kite-desktop', version: '0.1.0', instanceId: crypto.randomUUID() },
      KITE_APP_SERVER_PROTOCOL_METHODS_,
    );
    this.#connection = connection;
    this.#connectionId = info.connectionId;
    this.#publish({
      workspace: info.workspace,
      error: undefined,
      ...(this.#view.workspace !== info.workspace
        ? {
            selected: undefined,
            sessions: [],
            messages: [],
            projection: undefined,
            ready: false,
            loadingSession: false,
          }
        : {}),
    });
    this.#unsubscribe = connection.subscribe(() => {
      if (this.#connection !== connection) return;
      const snapshot = connection.snapshotStore.getSnapshot();
      const session = this.#view.selected ? snapshot.sessions[this.#view.selected] : undefined;
      this.#publish({
        connected: connection.status === 'active',
        ready: connection.status === 'active' && (session?.ready ?? false),
        projection: session?.projection,
        ...(connection.status === 'closed'
          ? { error: '连接已关闭。提交结果可能未知，请检查会话后明确重连。' }
          : {}),
      });
    });
    try {
      await connection.prepareAppControl();
      const trust = await connection.app.queryWorkspaceTrust({
        schema: 'kite.app.workspace-trust.query-request.v1',
        workspace: info.workspace,
      });
      const models = await connection.app.getProviderModelSnapshot({
        schema: 'kite.app.provider-model.snapshot-request.v1',
        workspace: trust.workspace,
      });
      this.#publish({ connected: true, trust, models });
      await this.refreshSessions();
      if (this.#view.selected) await this.selectSession(this.#view.selected);
    } catch (error) {
      await this.disconnect().catch(() => undefined);
      throw error;
    }
  }
  async disconnect() {
    this.#selection?.abort();
    this.#unsubscribe?.();
    const connection = this.#connection;
    this.#connection = undefined;
    this.#connectionId = undefined;
    this.#admitted.clear();
    this.#publish({
      connected: false,
      ready: false,
      loadingSession: false,
      trust: undefined,
      models: undefined,
    });
    await connection?.close();
  }
  #requireConnection() {
    if (this.#connection?.status !== 'active') throw new Error('请先连接项目。');
    return this.#connection;
  }
  async trustProject() {
    const trust = this.#view.trust;
    if (!trust) throw new Error('尚未读取工作区信任。');
    const result = await this.#requireConnection().app.decideWorkspaceTrust({
      schema: 'kite.app.workspace-trust.decision-request.v1',
      workspace: trust.workspace,
      observedStatus: trust.status,
      expectedRevision: trust.revision,
      decision: 'trust',
      externalReadScopeDigest: trust.externalReadScope.digest,
    });
    this.#publish({
      trust: {
        ...trust,
        status: result.status,
        revision: result.revision,
        workspace: result.workspace,
        externalReadScope: result.externalReadScope,
      },
    });
    if (result.status !== 'trusted') throw new Error(`工作区信任未生效：${result.outcome}`);
  }
  async refreshSessions() {
    const connection = this.#requireConnection();
    const result = await connection.runtime.query({
      schema: 'kite.runtime-query.v1',
      type: 'list_sessions',
    });
    if (result.status !== 'ok' || !result.sessions) throw new Error('会话目录暂时不可用。');
    if (this.#connection === connection)
      this.#publish({
        sessions: result.sessions.filter(
          (session) =>
            session.workspaceDigest !== undefined &&
            session.workspaceDigest === this.#view.trust?.workspace.workspaceDigest,
        ),
      });
  }
  async openFile(path: string, editor: 'vscode' | 'zed' | 'textedit') {
    this.#requireConnection();
    await this.call('open_editor', { connectionId: this.#connectionId, path, editor });
  }
  async refreshModels() {
    const connection = this.#requireConnection();
    const workspace = this.#view.trust?.workspace;
    if (!workspace) throw new Error('尚未读取工作区。');
    const models = await connection.app.getProviderModelSnapshot({
      schema: 'kite.app.provider-model.snapshot-request.v1',
      workspace,
    });
    if (this.#connection === connection) this.#publish({ models });
    return models;
  }
  async configureProvider(input: ProviderInput) {
    await saveProvider(this.#requireConnection(), input, () => this.refreshModels());
  }
  async selectModel(provider: string, name: string) {
    const connection = this.#requireConnection();
    const models = this.#view.models;
    if (!models) throw new Error('请先刷新模型配置。');
    let result: Awaited<ReturnType<KiteAppServerConnection['app']['selectProviderModel']>>;
    try {
      result = await connection.app.selectProviderModel({
        schema: 'kite.app.provider-model.select-request.v1',
        workspace: models.workspace,
        provider,
        name,
        expectedRevision: models.revision,
      });
    } catch {
      await this.refreshModels().catch(() => undefined);
      throw new Error('模型切换结果未知，请检查当前模型后再决定是否重试。');
    }
    if (this.#connection !== connection) return;
    this.#publish({ models: result.snapshot });
    if (result.outcome !== 'applied' && result.outcome !== 'already_selected')
      throw new Error(`模型未确认切换（${result.outcome}），请检查最新配置后重新选择。`);
  }
  async #command(command: RuntimeCommand) {
    const connection = this.#requireConnection();
    let receipt: Awaited<ReturnType<typeof connection.runtime.command>>;
    try {
      receipt = await connection.runtime.command(command);
    } catch {
      throw new Error(
        '操作提交结果未知。请明确重连并检查会话与实际文件，再决定是否继续；不会自动重发。',
      );
    }
    if (receipt.status !== 'applied' && receipt.status !== 'idempotent_replay')
      throw new Error(`操作未执行：${receipt.code}`);
    return receipt;
  }
  async newSession() {
    if (this.#view.trust?.status !== 'trusted') throw new Error('请先确认工作区信任。');
    const sessionId = crypto.randomUUID();
    await this.#command({
      schema: 'kite.runtime-command.v1',
      commandId: crypto.randomUUID(),
      type: 'create_session',
      workspace: this.#view.workspace,
      bootstrapSessionId: sessionId,
    });
    this.#admitted.add(sessionId);
    await this.selectSession(sessionId);
    await this.refreshSessions();
  }
  async selectSession(sessionId: string) {
    const connection = this.#requireConnection();
    this.#selection?.abort();
    const controller = new AbortController();
    this.#selection = controller;
    this.#publish({
      selected: sessionId,
      messages: [],
      ready: false,
      projection: undefined,
      error: undefined,
      loadingSession: true,
    });
    let timedOut = false;
    let rejectTimeout!: (error: Error) => void;
    const deadline = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const loadingTimeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimeout(new Error('会话加载超时，请检查连接后重试。'));
    }, 20_000);
    try {
      const result = await Promise.race([
        connection.runtime.query({
          schema: 'kite.runtime-query.v1',
          type: 'get_session_projection',
          sessionId,
        }),
        deadline,
      ]);
      if (controller.signal.aborted || this.#connection !== connection) return;
      if (
        result.status !== 'ok' ||
        !result.session?.workspaceDigest ||
        result.session.workspaceDigest !== this.#view.trust?.workspace.workspaceDigest
      )
        throw new Error('会话不属于当前项目或已不可用，请刷新目录。');
      const notifications = await connection.runtime.subscribeReadyWithGeneration({
        spec: { scope: 'session', sessionId, includeEphemeral: true },
        signal: controller.signal,
      });
      const transcript = await Promise.race([connection.history.loadSession(sessionId), deadline]);
      if (controller.signal.aborted) return;
      let messages: readonly Message[] = [];
      for (const event of transcript.events) messages = projectEvent(messages, event);
      const session = connection.snapshotStore.getSnapshot().sessions[sessionId];
      this.#publish({ messages, projection: session?.projection, ready: session?.ready ?? false });
      void (async () => {
        try {
          for await (const { notification, connectionGeneration } of notifications) {
            if (controller.signal.aborted || connectionGeneration !== connection.generation)
              continue;
            if (!('durability' in notification) || notification.sessionId !== sessionId) continue;
            const event =
              notification.durability === 'ephemeral'
                ? notification.event
                : notification.projection.event;
            if (event) this.#publish({ messages: projectEvent(this.#view.messages, event) });
          }
        } catch (error) {
          if (!controller.signal.aborted) this.report(error);
        }
      })();
    } catch (error) {
      if (!timedOut && controller.signal.aborted) return;
      controller.abort();
      if (timedOut) throw new Error('会话加载超时，请检查连接后重试。');
      throw error;
    } finally {
      clearTimeout(loadingTimeout);
      if (this.#selection === controller) this.#publish({ loadingSession: false });
    }
  }
  async send(input: string) {
    const sessionId = this.#view.selected;
    if (!sessionId || !input.trim()) return;
    if (this.#view.trust?.status !== 'trusted') throw new Error('请先确认工作区信任。');
    if (!this.#admitted.has(sessionId)) {
      await this.#command({
        schema: 'kite.runtime-command.v1',
        commandId: crypto.randomUUID(),
        type: 'resume_session',
        sessionId,
      });
      this.#admitted.add(sessionId);
    }
    const connection = this.#requireConnection();
    const result = await connection.runtime.query({
      schema: 'kite.runtime-query.v1',
      type: 'get_session_projection',
      sessionId,
    });
    if (result.status !== 'ok' || !result.session) throw new Error('会话当前不可用。');
    await this.#command({
      schema: 'kite.runtime-command.v1',
      commandId: crypto.randomUUID(),
      type: 'start_turn',
      sessionId,
      expectedRevision: result.session.revision,
      input,
      phase: 'building',
    });
  }
  async cancel() {
    const projection = this.#view.projection;
    const run = projection?.currentRun;
    if (!projection || !run) return;
    await this.#command({
      schema: 'kite.runtime-command.v1',
      commandId: crypto.randomUUID(),
      type: 'cancel_turn',
      sessionId: projection.sessionId,
      expectedRevision: projection.revision,
      runId: run.runId,
      turnId: run.activeTurnId ?? run.initialTurnId,
    });
  }

  async respondApproval(
    sessionId: string,
    interaction: RuntimeApprovalInteraction,
    decision: 'approve_once' | 'reject',
  ) {
    if (this.#view.selected !== sessionId || !this.#view.ready)
      throw new Error('审批所属会话已改变，请重新查看。');
    await this.#command({
      schema: 'kite.runtime-command.v1',
      commandId: crypto.randomUUID(),
      type: 'respond_interaction',
      sessionId,
      expectedRevision: interaction.sessionRevision,
      interaction,
      response: { kind: 'approval', decision },
    });
  }
  async respondInput(sessionId: string, interaction: RuntimeInputInteraction, value?: string) {
    if (this.#view.selected !== sessionId || !this.#view.ready)
      throw new Error('问题所属会话已改变，请重新查看。');
    if (
      value !== undefined &&
      (!value.trim() ||
        (!interaction.allowFreeText && !interaction.options?.some((option) => option.id === value)))
    )
      throw new Error('请选择有效选项或填写回答。');
    await this.#command({
      schema: 'kite.runtime-command.v1',
      commandId: crypto.randomUUID(),
      type: 'respond_interaction',
      sessionId,
      expectedRevision: interaction.sessionRevision,
      interaction,
      response: value === undefined ? { kind: 'input_cancel' } : { kind: 'text', value },
    });
  }
  async respondPlan(
    sessionId: string,
    interaction: RuntimePlanReviewInteraction,
    response: Extract<RuntimeInteractionResponse, { kind: 'plan_review' }>,
  ) {
    if (this.#view.selected !== sessionId || !this.#view.ready)
      throw new Error('计划所属会话已改变，请重新查看。');
    if (response.decision === 'feedback' && !response.feedback?.trim())
      throw new Error('请填写修改要求。');
    if (
      (response.decision === 'auto' || response.decision === 'accept_edits') &&
      (!interaction.review || interaction.review.truncated)
    )
      throw new Error('请先取得完整可读的计划正文。');
    await this.#command({
      schema: 'kite.runtime-command.v1',
      commandId: crypto.randomUUID(),
      type: 'respond_interaction',
      sessionId,
      expectedRevision: interaction.sessionRevision,
      interaction,
      response,
    });
  }
}
