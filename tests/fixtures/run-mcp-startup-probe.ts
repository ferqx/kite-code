#!/usr/bin/env bun

import { McpConnectionManager } from '@kite-ai/builtin-runtime/mcp';
import { loadMcpConfigCatalog } from '#kite-cli/config';

const catalog = loadMcpConfigCatalog();
const manager = new McpConnectionManager();
try {
  await manager.connectAll(catalog.connectableServers);
  console.log(
    JSON.stringify({
      connectable: Object.keys(catalog.connectableServers),
      states: [...manager.getServerStates().keys()],
      approvals: catalog.projectApprovals.map((view) => ({
        name: view.name,
        status: view.status,
      })),
    }),
  );
} finally {
  await manager.disconnectAll();
}
