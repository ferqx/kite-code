#!/usr/bin/env bun

import { loadMcpConfig } from '@/core/config';
import { McpConnectionManager } from '@/core/mcp/manager';

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
