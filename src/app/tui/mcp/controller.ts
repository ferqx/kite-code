import {
  decideProjectMcpServer,
  type McpProjectDecision,
  type McpProjectSourceKind,
} from '@/core/config/mcp-project-approvals';
import type { McpRuntimeProvider, McpServerKey, McpSupervisor } from '@/core/mcp';
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
