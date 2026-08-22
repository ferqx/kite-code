#!/usr/bin/env bun

import { McpConnectionManager } from '@kite/builtin-runtime/mcp';
import { loadMcpConfig } from '#app/config';

const loaded = loadMcpConfig();
const manager = new McpConnectionManager();
try {
  await manager.connectAll(loaded.servers);
  console.log(
    JSON.stringify({
      connectable: Object.keys(loaded.servers),
      states: [...manager.getServerStates().keys()],
      approvals: loaded.catalog.projectApprovals.map((view) => ({
        name: view.name,
        status: view.status,
      })),
    }),
  );
} finally {
  await manager.disconnectAll();
}
