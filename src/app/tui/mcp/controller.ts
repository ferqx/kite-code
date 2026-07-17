import {
  decideProjectMcpServer,
  type McpProjectDecision,
  type McpProjectSourceKind,
} from '@/core/config/mcp-project-approvals';
import type {
  McpProviderRecoveryAction,
  McpRuntimeProvider,
  McpServerKey,
  McpSupervisor,
} from '@/core/mcp';
import type { McpController, McpControllerSnapshot } from './types';

export class TuiMcpController implements McpController {
  private readonly supervisor: McpSupervisor;
  private readonly workspace: string;
  private readonly listeners = new Set<() => void>();
  private snapshot: McpControllerSnapshot;
  private readonly unsubscribeSupervisor: () => void;

  constructor(supervisor: McpSupervisor, workspace: string) {
    this.supervisor = supervisor;
    this.workspace = workspace;
    this.snapshot = Object.freeze({ control: supervisor.getSnapshot() });
    this.unsubscribeSupervisor = supervisor.subscribe(() => {
      this.snapshot = Object.freeze({
        control: supervisor.getSnapshot(),
        message: this.snapshot.message,
      });
      this.emit();
    });
  }

  async start(): Promise<void> {
    await this.supervisor.start(this.workspace);
  }

  async stop(): Promise<void> {
    this.unsubscribeSupervisor();
    await this.supervisor.stop();
  }

  getRuntimeProvider(): McpRuntimeProvider {
    return this.supervisor.getRuntimeProvider();
  }

  getSnapshot = (): McpControllerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async decide(key: McpServerKey, decision: McpProjectDecision): Promise<boolean> {
    const server = this.snapshot.control.servers.find(
      (candidate) => candidate.key.name === key.name && candidate.key.source === key.source,
    );
    if (!server?.approval || !isProjectSource(server.source)) {
      this.setMessage('This MCP server does not have a project approval action.');
      return false;
    }
    const result = decideProjectMcpServer({
      workspace: this.workspace,
      serverName: server.key.name,
      sourceKind: server.source,
      sourcePath: server.sourcePath,
      expectedConfigDigest: server.approval.configDigest,
      decision,
    });
    this.setMessage(
      result.status === 'recorded'
        ? `${decision === 'approved' ? 'Approved' : 'Rejected'} project MCP server ${server.key.name}.`
        : result.message,
    );
    await this.supervisor.reload();
    return result.status === 'recorded';
  }

  async login(key: McpServerKey): Promise<boolean> {
    try {
      const result = await this.supervisor.login(key);
      this.setMessage(
        result.status === 'authenticated'
          ? `Authenticated MCP server ${key.name}.`
          : `Continue authentication for MCP server ${key.name} in your browser.`,
      );
      return true;
    } catch {
      this.setMessage(`Unable to start authentication for MCP server ${key.name}.`);
      return false;
    }
  }

  async cancelAuth(flowId: string): Promise<void> {
    await this.supervisor.cancelAuth(flowId);
    this.setMessage('MCP authentication cancelled.');
  }

  async recover(providerId: string, action: McpProviderRecoveryAction) {
    const server = this.snapshot.control.servers.find(
      (candidate) => candidate.effective && candidate.key.name === providerId,
    );
    if (!server) {
      const directory = this.supervisor.getRuntimeProvider().getProviderDirectorySnapshot();
      return {
        outcome: 'failed' as const,
        providerDirectoryRevision: directory.revision,
      };
    }

    if (action === 'approve') {
      await this.decide(server.key, 'approved');
    } else if (action === 'retry') {
      await this.supervisor.retry(server.key);
    } else {
      const result = await this.supervisor.login(server.key);
      if (result.status === 'authorization_required') {
        await this.waitForAuthentication(server.key);
      }
    }

    const directory = this.supervisor.getRuntimeProvider().getProviderDirectorySnapshot();
    const entry = directory.entries.find((candidate) => candidate.providerId === providerId);
    return {
      outcome:
        entry?.status === 'ready' || entry?.status === 'degraded'
          ? ('completed' as const)
          : ('failed' as const),
      providerDirectoryRevision: directory.revision,
      ...(entry ? { providerStatus: entry.status } : {}),
      ...(entry?.diagnosticCode ? { diagnosticCode: entry.diagnosticCode } : {}),
    };
  }

  private async waitForAuthentication(key: McpServerKey): Promise<void> {
    const current = () =>
      this.supervisor
        .getSnapshot()
        .servers.find(
          (candidate) =>
            candidate.effective &&
            candidate.key.name === key.name &&
            candidate.key.source === key.source,
        )?.authStatus;
    if (current() === 'authenticated') return;
    await new Promise<void>((resolve) => {
      let unsubscribe = () => {};
      const timeout = setTimeout(done, 120_000);
      unsubscribe = this.supervisor.subscribe(() => {
        const status = current();
        if (
          status === 'authenticated' ||
          status === 'error' ||
          status === 'login_required' ||
          status === 'reauth_required'
        ) {
          done();
        }
      });
      function done() {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  }

  private setMessage(message: string): void {
    this.snapshot = Object.freeze({ control: this.snapshot.control, message });
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function isProjectSource(source: string): source is McpProjectSourceKind {
  return (
    source === 'project' ||
    source === 'project_legacy' ||
    source === 'project_kite_code' ||
    source === 'project_mcp_json'
  );
}
