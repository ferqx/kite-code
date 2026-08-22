import { describe, expect, test } from 'bun:test';
import {
  createBuiltinRuntimeModules,
  createBuiltinSubagentToolSurfaceV1,
  createBuiltinToolCatalogProjectionV1,
  createCapabilityBindingV1,
} from '@kite/builtin-runtime';
import type { CapabilityDescriptor } from '@kite/runtime-contract';
import { createRuntimeModuleRegistryV1 } from '@kite/runtime-spi';

function catalog() {
  return createBuiltinToolCatalogProjectionV1(
    createRuntimeModuleRegistryV1(createBuiltinRuntimeModules()).snapshot(),
  );
}

const MCP_DESCRIPTOR: CapabilityDescriptor = Object.freeze({
  capabilityId: 'mcp:server:read',
  revision: 'mcp-read-v1',
  kind: 'mcp_tool',
  displayName: 'Read remote record',
  description: 'Untrusted remote description.',
  modelDescription: 'Read one remote record.',
  provider: Object.freeze({ type: 'mcp', id: 'test-server', provenance: 'remote' }),
  inputSchema: Object.freeze({
    type: 'object',
    description: 'must not enter the model schema',
    properties: Object.freeze({ id: Object.freeze({ type: 'string', description: 'hidden' }) }),
    required: Object.freeze(['id']),
    additionalProperties: false,
  }),
  declaredEffects: Object.freeze({ filesystem: 'none', network: 'read', externalState: 'none' }),
  effectiveEffects: Object.freeze({ filesystem: 'none', network: 'read', externalState: 'none' }),
  policy: Object.freeze({ workspaceTrustRequired: false, minimumApproval: 'none' }),
  availability: 'available',
  diagnostics: [],
});

describe('Builtin subagent tool surface', () => {
  test('filters interrupt/nested Task and keeps dynamic MCP outside the catalog revision', () => {
    const binding = createCapabilityBindingV1({
      capabilityId: MCP_DESCRIPTOR.capabilityId,
      capabilityRevision: MCP_DESCRIPTOR.revision,
      exposedToolName: 'mcp__test__read',
      inputSchema: MCP_DESCRIPTOR.inputSchema,
      turnId: 'turn-1',
    });
    const baseCatalog = catalog();
    const surface = createBuiltinSubagentToolSurfaceV1({
      catalog: baseCatalog,
      turnContext: Object.freeze({ workspace: '/workspace', promptContractV2: true }),
      allowedTools: new Set(['read_file', 'search_files', 'task']),
      canSpawnSubagents: false,
      dynamicMcpBindings: [{ binding, descriptor: MCP_DESCRIPTOR }],
    });

    expect(Object.keys(surface.tools).sort()).toEqual([
      'mcp__test__read',
      'read_file',
      'search_files',
    ]);
    expect(surface.builtinEntries.map((entry) => entry.name).sort()).toEqual([
      'read_file',
      'search_files',
    ]);
    expect(surface.projection.revision).toBe(baseCatalog.forTurn({}).revision);
    expect(surface.builtinEntries.some((entry) => entry.name === 'ask_user')).toBe(false);
    expect(surface.builtinEntries.some((entry) => entry.name === 'task')).toBe(false);
  });

  test('fails closed by omission for stale schema identity or a non-MCP exposed name', () => {
    const binding = createCapabilityBindingV1({
      capabilityId: MCP_DESCRIPTOR.capabilityId,
      capabilityRevision: MCP_DESCRIPTOR.revision,
      exposedToolName: 'mcp__test__read',
      inputSchema: MCP_DESCRIPTOR.inputSchema,
      turnId: 'turn-1',
    });
    const staleBinding = Object.freeze({ ...binding, schemaDigest: 'stale-schema' });
    const disguisedBinding = Object.freeze({ ...binding, exposedToolName: 'ask_user' });
    const surface = createBuiltinSubagentToolSurfaceV1({
      catalog: catalog(),
      turnContext: Object.freeze({ workspace: '/workspace' }),
      allowedTools: new Set(),
      canSpawnSubagents: false,
      dynamicMcpBindings: [
        { binding: staleBinding, descriptor: MCP_DESCRIPTOR },
        { binding: disguisedBinding, descriptor: MCP_DESCRIPTOR },
      ],
    });

    expect(Object.keys(surface.tools)).toEqual([]);
  });
});
