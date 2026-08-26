import {
  type AppMcpAction,
  type AppMcpActionResponse,
  type AppMcpServerKey,
  type AppMcpSnapshot,
  type KiteAppControlClient,
  type KiteWorkspaceIdentity,
  MCP_ACTION_REQUEST_SCHEMA_,
  MCP_SNAPSHOT_REQUEST_SCHEMA_,
  mcpActionResponseCodec,
  mcpSnapshotResponseCodec,
} from '@kite-ai/kite-app-contract';
import type { McpController, McpControllerSnapshot } from './types';

const SNAPSHOT_POLL_INTERVAL_MS = 250;
const INITIAL_REVISION = 'initial';

/**
 * TUI-only presentation wrapper over the closed App Control MCP route.
 *
 * The controller intentionally owns no Supervisor, repository, credential
 * store, process port, or runtime provider. It only caches the latest
 * browser-safe snapshot and turns visible actions into exact App Control
 * requests. A mutation response is consumed once; in particular,
 * `outcome_unknown` is reported to the user and is never retried here.
 */
export class TuiMcpController implements McpController {
  private readonly client: KiteAppControlClient;
  private readonly workspace: KiteWorkspaceIdentity;
  private readonly listeners = new Set<() => void>();
  private snapshot: McpControllerSnapshot;
  private refreshInFlight: Promise<void> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private startPromise: Promise<void> | undefined;
  private stopped = false;

  constructor(client: KiteAppControlClient, workspace: KiteWorkspaceIdentity) {
    this.client = client;
    this.workspace = Object.freeze({ ...workspace });
    this.snapshot = Object.freeze({
      control: emptySnapshot(this.workspace),
    });
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.stopped) throw new Error('MCP presentation controller is stopped.');
    this.startPromise = this.refresh().then(() => {
      if (this.stopped || this.pollTimer) return;
      this.pollTimer = setInterval(() => {
        void this.refresh().catch((error: unknown) => {
          this.setMessage(mutationMessage(error, 'refresh MCP state'));
        });
      }, SNAPSHOT_POLL_INTERVAL_MS);
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    await this.refreshInFlight?.catch(() => undefined);
  }

  getSnapshot = (): McpControllerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async decide(key: AppMcpServerKey, decision: 'approved' | 'rejected'): Promise<boolean> {
    const server = this.findServer(key);
    if (!server || key.source !== 'project' || !server.approval) {
      this.setMessage('This MCP server does not have a project approval action.');
      return false;
    }
    const outcome = await this.applyAction(
      {
        type: decision === 'approved' ? 'approve' : 'reject',
        key,
        expectedRevision: server.revision,
      },
      `${decision === 'approved' ? 'Approved' : 'Rejected'} project MCP server ${key.name}.`,
      `Unable to ${decision === 'approved' ? 'approve' : 'reject'} MCP server ${key.name}.`,
    );
    return outcome === 'applied';
  }

  async login(key: AppMcpServerKey): Promise<void> {
    const server = this.requireServer(key);
    if (!server) return;
    await this.applyAction(
      { type: 'login', key, expectedRevision: server.revision },
      `Continue authentication for MCP server ${key.name} in your browser.`,
      `Unable to start authentication for MCP server ${key.name}.`,
    );
  }

  async cancelAuth(flowId: string): Promise<void> {
    const server = [...this.snapshot.control.servers].find(
      (candidate) => candidate.authFlowId === flowId,
    );
    if (!server) {
      this.setMessage('MCP authentication flow is no longer available.');
      return;
    }
    await this.applyAction(
      { type: 'cancel_auth', key: server.key, expectedRevision: server.revision },
      'MCP authentication cancelled.',
      'Unable to cancel MCP authentication.',
    );
  }

  async retry(key: AppMcpServerKey): Promise<boolean> {
    const server = this.requireServer(key);
    if (!server) return false;
    const outcome = await this.applyAction(
      { type: 'retry', key, expectedRevision: server.revision },
      `Retried MCP server ${key.name}.`,
      `Unable to retry MCP server ${key.name}.`,
    );
    return outcome === 'applied';
  }

  async setEnabled(
    key: AppMcpServerKey,
    expectedRevision: string,
    enabled: boolean,
  ): Promise<boolean> {
    const outcome = await this.applyAction(
      { type: 'set_enabled', key, expectedRevision, enabled },
      `${enabled ? 'Enabled' : 'Disabled'} MCP server ${key.name}.`,
      `Unable to ${enabled ? 'enable' : 'disable'} ${key.name}.`,
    );
    return outcome === 'applied';
  }

  async add(input: {
    scope: 'project' | 'user';
    name: string;
    config: { type: 'http' | 'stdio'; url?: string; command?: string };
  }): Promise<AppMcpServerKey | null> {
    const value = input.config.type === 'http' ? input.config.url : input.config.command;
    if (!value) {
      this.setMessage(`Unable to add ${input.name}: MCP target is required.`);
      return null;
    }
    const outcome = await this.applyAction(
      {
        type: 'add',
        source: input.scope,
        name: input.name,
        transport: input.config.type,
        value,
        expectedRevision: this.snapshot.control.sourceRevisions[input.scope],
      },
      `Added MCP server ${input.name}.`,
      `Unable to add ${input.name}.`,
    );
    return outcome === 'applied' ? { name: input.name, source: input.scope } : null;
  }

  async remove(key: AppMcpServerKey, expectedRevision: string): Promise<boolean> {
    const outcome = await this.applyAction(
      { type: 'remove', key, expectedRevision },
      `Removed MCP server ${key.name}.`,
      `Unable to remove ${key.name}.`,
    );
    return outcome === 'applied';
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const request = {
      schema: MCP_SNAPSHOT_REQUEST_SCHEMA_,
      workspace: this.workspace,
    } as const;
    const refresh = this.client
      .getMcpSnapshot(request)
      .then((snapshot) => this.setControlSnapshot(snapshot))
      .finally(() => {
        if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
      });
    this.refreshInFlight = refresh;
    return refresh;
  }

  private async applyAction(
    action: AppMcpAction,
    successMessage: string,
    failureMessage: string,
  ): Promise<AppMcpActionResponse['outcome']> {
    try {
      const response = mcpActionResponseCodec.decode(
        mcpActionResponseCodec.encode(
          await this.client.applyMcpAction({
            schema: MCP_ACTION_REQUEST_SCHEMA_,
            workspace: this.workspace,
            action,
          }),
        ),
      );
      this.setControlSnapshot(response.snapshot);
      if (response.outcome === 'applied') this.setMessage(successMessage);
      else this.setMessage(`${failureMessage} (${response.outcome}).`);
      return response.outcome;
    } catch (error) {
      this.setMessage(mutationMessage(error, failureMessage));
      return 'rejected';
    }
  }

  private findServer(key: AppMcpServerKey) {
    return this.snapshot.control.servers.find(
      (candidate) => candidate.key.name === key.name && candidate.key.source === key.source,
    );
  }

  private requireServer(key: AppMcpServerKey) {
    const server = this.findServer(key);
    if (!server) this.setMessage(`MCP server ${key.name} is no longer available.`);
    return server;
  }

  private setControlSnapshot(snapshot: AppMcpSnapshot): void {
    const checked = mcpSnapshotResponseCodec.decode(mcpSnapshotResponseCodec.encode(snapshot));
    if (!sameWorkspace(checked.workspace, this.workspace)) {
      throw new Error('MCP App Control response belongs to a different Workspace.');
    }
    this.snapshot = Object.freeze({ control: checked });
    this.emit();
  }

  private setMessage(message: string | undefined): void {
    this.snapshot =
      message === undefined
        ? Object.freeze({ control: this.snapshot.control })
        : Object.freeze({ control: this.snapshot.control, message });
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function emptySnapshot(workspace: KiteWorkspaceIdentity): AppMcpSnapshot {
  return Object.freeze({
    schema: 'kite.app.mcp.snapshot-response.v1',
    workspace,
    revision: INITIAL_REVISION,
    sourceRevisions: Object.freeze({ project: INITIAL_REVISION, user: INITIAL_REVISION }),
    servers: Object.freeze([]),
  });
}

function sameWorkspace(left: KiteWorkspaceIdentity, right: KiteWorkspaceIdentity): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.projectId === right.projectId &&
    left.workspaceDigest === right.workspaceDigest
  );
}

function mutationMessage(error: unknown, action: string): string {
  if (error instanceof Error && error.message) return error.message;
  return `Unable to ${action}.`;
}
