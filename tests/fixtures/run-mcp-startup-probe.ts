#!/usr/bin/env bun

import { loadMcpConfig } from '@/core/config';
import { McpManager } from '@/core/mcp';

const loaded = loadMcpConfig();
const manager = new McpManager();
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
