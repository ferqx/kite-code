import {
  type AppMcpActionRequest,
  type AppMcpActionResponse,
  type AppMcpSnapshot,
  type AppMcpSnapshotRequest,
  type KiteWorkspaceIdentity,
  mcpActionRequestCodec,
  mcpActionResponseCodec,
  mcpSnapshotRequestCodec,
  mcpSnapshotResponseCodec,
} from '@kite-ai/kite-app-contract';
import { assertAdmittedWorkspace, assertSameWorkspace, type McpHandlerPort } from './ports';

export interface McpHandlerDependencies {
  readonly handler: McpHandlerPort;
  readonly workspace?: KiteWorkspaceIdentity;
}

export function createMcpHandler(input: McpHandlerDependencies): McpHandlerPort {
  return Object.freeze({
    async snapshot(request: AppMcpSnapshotRequest): Promise<AppMcpSnapshot> {
      const checked = mcpSnapshotRequestCodec.decode(mcpSnapshotRequestCodec.encode(request));
      assertAdmittedWorkspace(input.workspace, checked.workspace, 'MCP request');
      const response = await input.handler.snapshot(checked);
      const projected = mcpSnapshotResponseCodec.decode(mcpSnapshotResponseCodec.encode(response));
      assertSameWorkspace(checked.workspace, projected.workspace, 'MCP response');
      return projected;
    },
    async apply(request: AppMcpActionRequest): Promise<AppMcpActionResponse> {
      const checked = mcpActionRequestCodec.decode(mcpActionRequestCodec.encode(request));
      assertAdmittedWorkspace(input.workspace, checked.workspace, 'MCP request');
      const response = await input.handler.apply(checked);
      const projected = mcpActionResponseCodec.decode(mcpActionResponseCodec.encode(response));
      assertSameWorkspace(checked.workspace, projected.snapshot.workspace, 'MCP response');
      return projected;
    },
  });
}
