import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  BUILTIN_CONTEXT_SOURCE_IDS_,
  BUILTIN_RUNTIME_DOMAINS_,
  BUILTIN_TASK_PUBLIC_SCHEMA_,
  BUILTIN_TOOL_CONTRACTS,
  buildDescription,
  createBuiltinContextCompilerPort,
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
  createCapabilityBinding,
  createToolSearchProviderFacts,
  DYNAMIC_MCP_OPERATION_INPUT_SCHEMA_,
  digestCapabilityBindingValue,
  GIT_CAPABILITY_REVISIONS_,
  GIT_EXECUTOR_REVISIONS_,
  GIT_OPERATION_IDS_,
  isBuiltinOperationExecutionValue,
  isToolSearchExecutionValue,
  MODEL_CAPABILITY_REVISIONS_,
  MODEL_OPERATION_IDS_,
  PLANNING_CAPABILITY_REVISION_,
  PLANNING_OPERATION_ID_,
  TOOL_SEARCH_CAPABILITY_ID_,
  TOOL_SEARCH_CAPABILITY_REVISION_,
  TOOL_SEARCH_EXECUTOR_REVISION_,
} from '@kite-ai/builtin-runtime';
import { McpProviderError } from '@kite-ai/builtin-runtime/mcp';
import {
  normalizeAskUserRequest,
  SUBAGENT_CAPABILITY_REVISIONS_,
  SUBAGENT_OPERATION_IDS_,
} from '@kite-ai/builtin-runtime/subagent';
import {
  VERIFICATION_CAPABILITY_REVISIONS_,
  VERIFICATION_OPERATION_IDS_,
} from '@kite-ai/builtin-runtime/verification';
import type { CapabilityDescriptor } from '@kite-ai/runtime-contract';
import {
  type CapabilityExecutionInvocation,
  type CapabilityExecutionMechanism,
  type CapabilityExecutionPort,
  type CapabilityTurnContext,
  createRuntimeModuleRegistry,
  type RuntimeJsonValue,
} from '@kite-ai/runtime-spi';

function catalogInvocation(input: {
  operationId: string;
  revision: string;
  schemaDigest: string;
  exposedToolName: string;
  attemptId?: string;
}): CapabilityExecutionInvocation {
  const bindingId = digestCapabilityBindingValue({
    capabilityId: input.operationId,
    revision: input.revision,
    exposedToolName: input.exposedToolName,
    schemaDigest: input.schemaDigest,
    turnId: 'turn-identity',
  });
  return {
    binding: {
      bindingId,
      capabilityId: input.operationId,
      capabilityRevision: input.revision,
      exposedToolName: input.exposedToolName,
      schemaDigest: input.schemaDigest,
      issuedForTurnId: 'turn-identity',
    },
    request: {
      invocationId: 'invocation-identity',
      capabilityId: input.operationId,
      capabilityRevision: input.revision,
      input: {},
    },
    grant: {
      grantId: 'grant-identity',
      capabilityId: input.operationId,
      capabilityRevision: input.revision,
      authority: {},
    },
    requestDigest: 'request-identity',
    environment: { environmentId: 'test', kind: 'in_process' },
    attempt: {
      invocationId: 'invocation-identity',
      attemptId: input.attemptId ?? 'attempt-identity',
    },
    signal: new AbortController().signal,
  };
}

describe('builtin runtime package boundary', () => {
  test('owns canonical ask_user interrupt payload normalization', () => {
    expect(
      normalizeAskUserRequest({
        questions: [
          {
            question: 'Continue?',
            options: [
              { label: 'Continue', description: 'Proceed now.', recommended: true },
              { label: 'Pause', description: 'Stop here.', recommended: false },
            ],
          },
        ],
      }),
    ).toEqual({
      question: 'Continue?',
      options: [
        { id: 'q1-o1', label: 'Continue', description: 'Proceed now.' },
        { id: 'q1-o2', label: 'Pause', description: 'Stop here.' },
      ],
      recommended: 'q1-o1',
      allow_free_text: true,
      questions: [
        {
          id: 'q1',
          question: 'Continue?',
          options: [
            { id: 'q1-o1', label: 'Continue', description: 'Proceed now.' },
            { id: 'q1-o2', label: 'Pause', description: 'Stop here.' },
          ],
          recommended: 'q1-o1',
          allow_free_text: true,
        },
      ],
    });

    expect(
      normalizeAskUserRequest({
        questions: [
          {
            question: 'Choose a scope?',
            options: [
              { label: 'Focused', description: 'Cover the critical path.' },
              { label: 'Complete', description: 'Cover the full rollout.' },
            ],
          },
        ],
      }),
    ).toMatchObject({
      recommended: 'q1-o1',
      questions: [{ recommended: 'q1-o1' }],
    });
  });

  test('owns the accepted Kite-specific domain vocabulary', () => {
    expect(BUILTIN_RUNTIME_DOMAINS_).toContain('context');
    const modules = createBuiltinRuntimeModules();
    expect(modules).toHaveLength(6);
    expect(modules[0]?.manifest).toMatchObject({
      moduleId: 'kite-builtin-runtime',
      providerId: 'kite-code',
      revision: 'builtin-catalog-current',
      operationIds: [TOOL_SEARCH_CAPABILITY_ID_],
    });
    expect(Object.isFrozen(modules)).toBe(true);
  });

  test('creates the exact frozen State 27 turn binding without authorization', () => {
    const binding = createCapabilityBinding({
      capabilityId: 'mcp:docs:search',
      capabilityRevision: 'revision-1',
      exposedToolName: 'mcp__docs__search',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      turnId: 'turn-1',
    });
    expect(binding).toEqual({
      bindingId: '692706a831860785ec5d95d14c654b6adf8178482b70d38d864d7d602708c90f',
      capabilityId: 'mcp:docs:search',
      capabilityRevision: 'revision-1',
      exposedToolName: 'mcp__docs__search',
      schemaDigest: '094ec29d007cce150c65abf0756d79ad5b62a1acfdb6e0841f69f1377ef41761',
      issuedForTurnId: 'turn-1',
    });
    expect(Object.isFrozen(binding)).toBe(true);
  });

  test('registers the exact RM-10 through RM-15 owners and executors', () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    expect(registry.operationOwner(TOOL_SEARCH_CAPABILITY_ID_)).toBe('kite-builtin-runtime');
    expect(registry.snapshot().capabilities).toHaveLength(28);
    expect(registry.capability(TOOL_SEARCH_CAPABILITY_ID_)).toMatchObject({
      capabilityId: TOOL_SEARCH_CAPABILITY_ID_,
      revision: TOOL_SEARCH_CAPABILITY_REVISION_,
      providerId: 'kite-code',
    });
    expect(registry.executor(TOOL_SEARCH_CAPABILITY_ID_)).toMatchObject({
      capabilityId: TOOL_SEARCH_CAPABILITY_ID_,
      capabilityRevision: TOOL_SEARCH_CAPABILITY_REVISION_,
      executorRevision: TOOL_SEARCH_EXECUTOR_REVISION_,
    });
    expect(registry.snapshot().contextSources.map(({ sourceId }) => sourceId)).toEqual([
      ...BUILTIN_CONTEXT_SOURCE_IDS_,
    ]);
    for (const operationId of MODEL_OPERATION_IDS_) {
      expect(registry.operationOwner(operationId), operationId).toBe('kite-builtin-runtime-model');
      expect(registry.capability(operationId), operationId).toMatchObject({
        capabilityId: operationId,
        revision: MODEL_CAPABILITY_REVISIONS_[operationId],
        providerId: 'kite-builtin-runtime-model',
      });
      expect(registry.executor(operationId), operationId).toMatchObject({
        capabilityId: operationId,
        capabilityRevision: MODEL_CAPABILITY_REVISIONS_[operationId],
        providerId: 'kite-builtin-runtime-model',
      });
    }
    for (const operationId of GIT_OPERATION_IDS_) {
      expect(registry.operationOwner(operationId), operationId).toBe('kite-builtin-runtime-git');
      expect(registry.capability(operationId), operationId).toMatchObject({
        capabilityId: operationId,
        revision: GIT_CAPABILITY_REVISIONS_[operationId],
        providerId: 'kite-builtin-runtime-git',
      });
      expect(registry.executor(operationId), operationId).toMatchObject({
        capabilityId: operationId,
        capabilityRevision: GIT_CAPABILITY_REVISIONS_[operationId],
        providerId: 'kite-builtin-runtime-git',
      });
    }
    for (const operationId of SUBAGENT_OPERATION_IDS_) {
      expect(registry.operationOwner(operationId), operationId).toBe(
        'kite-builtin-runtime-subagent',
      );
      expect(registry.capability(operationId), operationId).toMatchObject({
        capabilityId: operationId,
        revision: SUBAGENT_CAPABILITY_REVISIONS_[operationId],
        providerId: 'kite-builtin-runtime-subagent',
      });
      expect(registry.executor(operationId), operationId).toMatchObject({
        capabilityId: operationId,
        capabilityRevision: SUBAGENT_CAPABILITY_REVISIONS_[operationId],
        providerId: 'kite-builtin-runtime-subagent',
      });
    }
    for (const operationId of VERIFICATION_OPERATION_IDS_) {
      expect(registry.operationOwner(operationId), operationId).toBe(
        'kite-builtin-runtime-verification',
      );
      expect(registry.capability(operationId), operationId).toMatchObject({
        capabilityId: operationId,
        revision: VERIFICATION_CAPABILITY_REVISIONS_[operationId],
        providerId: 'kite-builtin-runtime-verification',
      });
      expect(registry.executor(operationId), operationId).toMatchObject({
        capabilityId: operationId,
        capabilityRevision: VERIFICATION_CAPABILITY_REVISIONS_[operationId],
        providerId: 'kite-builtin-runtime-verification',
      });
    }
    expect(registry.operationOwner(PLANNING_OPERATION_ID_)).toBe('kite-builtin-runtime-planning');
    expect(registry.capability(PLANNING_OPERATION_ID_)).toMatchObject({
      capabilityId: PLANNING_OPERATION_ID_,
      revision: PLANNING_CAPABILITY_REVISION_,
      providerId: 'kite-builtin-runtime-planning',
    });
    expect(registry.executor(PLANNING_OPERATION_ID_)).toMatchObject({
      capabilityId: PLANNING_OPERATION_ID_,
      capabilityRevision: PLANNING_CAPABILITY_REVISION_,
      providerId: 'kite-builtin-runtime-planning',
    });
  });

  test('projects all 28 registered operations and keeps internal Git inspection off the model surface', () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    const projection = createBuiltinToolCatalogProjection(registry, {
      turnContext: {
        toolSearchEnabled: true,
        hasTaskAdapter: true,
        hasGitBroker: true,
        brokeredGitFeatureRevision: 'brokered-git-r1',
        activeSkillFrameIds: ['skill-frame'],
        availableSkillIds: ['skill'],
        featureFlags: { brokeredGit: true, skillWorkflow: true, skillActivation: true },
      },
    });
    expect(projection.entries).toHaveLength(28);
    expect(projection.entries.filter((entry) => entry.visibility === 'model')).toHaveLength(19);
    expect(
      projection.entries.find((entry) => entry.operationId === 'builtin:git_inspect')?.visibility,
    ).toBe('internal');
    expect(projection.entries.filter((entry) => entry.visibility === 'internal')).toHaveLength(9);
    const expectedMechanisms: Readonly<Record<string, CapabilityExecutionMechanism>> = {
      'builtin:tool_search': 'catalog',
      'builtin:web_fetch': 'web',
      'builtin:list_mcp_resources': 'mcp',
      'builtin:list_mcp_tools': 'mcp',
      'builtin:read_mcp_resource': 'mcp',
      'mcp:dynamic_tool': 'mcp',
      'builtin:read_skill_reference': 'skill',
      'builtin:complete_skill': 'skill',
      'builtin:activate_skill': 'skill',
      'builtin:read_file': 'filesystem',
      'builtin:search_content': 'filesystem',
      'builtin:search_files': 'filesystem',
      'builtin:write_file': 'filesystem',
      'builtin:edit_file': 'filesystem',
      'builtin:git_inspect': 'git',
      'builtin:shell_execute': 'shell',
      'builtin:ask_user': 'user_input',
      'builtin:read_plan': 'planning',
      'builtin:update_plan': 'planning',
      'builtin:write_plan': 'planning',
      'builtin:task': 'subagent',
      'subagent:start': 'subagent',
      'subagent:resume': 'subagent',
      'verification:deterministic': 'verification',
      'model:primary': 'model',
      'model:compaction': 'model',
      'model:auto_review': 'model',
      'model:subagent': 'model',
    };
    expect(Object.keys(expectedMechanisms)).toHaveLength(28);
    expect(projection.entries.map((entry) => entry.operationId).sort()).toEqual(
      Object.keys(expectedMechanisms).sort(),
    );
    for (const entry of projection.entries) {
      const expectedMechanism = expectedMechanisms[entry.operationId];
      if (!expectedMechanism) throw new Error(`missing mechanism mapping: ${entry.operationId}`);
      expect(entry.executionMechanism, entry.operationId).toBe(expectedMechanism);
      expect(entry.descriptor.executionMechanism, entry.operationId).toBe(expectedMechanism);
    }
    expect(Object.keys(projection.toolSet).sort()).toEqual([
      'activate_skill',
      'ask_user',
      'complete_skill',
      'edit_file',
      'list_mcp_resources',
      'list_mcp_tools',
      'read_file',
      'read_mcp_resource',
      'read_plan',
      'read_skill_reference',
      'search_content',
      'search_files',
      'shell_execute',
      'task',
      'tool_search',
      'update_plan',
      'web_fetch',
      'write_file',
      'write_plan',
    ]);
    const readFile = projection.entries.find((entry) => entry.operationId === 'builtin:read_file');
    expect(readFile).toMatchObject({
      name: 'read_file',
      visibility: 'model',
      availability: 'available',
      revision: GIT_CAPABILITY_REVISIONS_['builtin:read_file'],
      effects: { filesystem: 'read', network: 'none', externalState: 'none' },
    });
    expect(readFile?.inputSchema).toEqual(registry.capability('builtin:read_file')?.inputSchema);
    for (const entry of projection.entries) {
      const definition = registry.capability(entry.operationId);
      const executor = registry.executor(entry.operationId);
      expect(definition, entry.operationId).toBeDefined();
      expect(executor, entry.operationId).toBeDefined();
      if (!definition || !executor)
        throw new Error(`registry entry is missing: ${entry.operationId}`);
      expect(entry.revision, entry.operationId).toBe(definition.revision);
      expect(entry.executorRevision, entry.operationId).toBe(executor.executorRevision);
      expect(entry.inputSchema, entry.operationId).toEqual(definition.inputSchema);
      if (!definition.effects) throw new Error(`effect facts are missing: ${entry.operationId}`);
      expect(entry.effects, entry.operationId).toEqual(definition.effects);
      if (entry.visibility === 'model') {
        if (!entry.name) throw new Error(`model entry has no name: ${entry.operationId}`);
        expect(Object.isFrozen(entry.runtimeDescriptor), entry.name).toBe(true);
        expect(entry.runtimeDescriptor.capabilityId, entry.name).toBe(
          entry.descriptor.capabilityId,
        );
        expect(entry.runtimeDescriptor.revision, entry.name).toBe(entry.descriptor.revision);
        expect(entry.runtimeDescriptor.kind, entry.name).toBe(entry.descriptor.kind);
        expect(entry.runtimeDescriptor.displayName, entry.name).toBe(entry.descriptor.displayName);
        expect(entry.runtimeDescriptor.inputSchema, entry.name).toBe(entry.descriptor.inputSchema);
        expect(entry.description, entry.operationId).toBe(
          buildDescription(
            BUILTIN_TOOL_CONTRACTS[entry.name as keyof typeof BUILTIN_TOOL_CONTRACTS],
          ),
        );
      } else {
        expect(entry.name, entry.operationId).toBeUndefined();
      }
    }
    expect(Object.isFrozen(projection.entries)).toBe(true);
    expect(Object.isFrozen(projection.toolSet)).toBe(true);
  });

  test('rejects mutable or nested-forged registry snapshots before catalog projection', () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    const snapshot = registry.snapshot();
    expect(() =>
      createBuiltinToolCatalogProjection({
        ...snapshot,
      }),
    ).toThrow('requires a frozen Runtime SPI registry snapshot');

    const first = snapshot.capabilities[0];
    if (!first) throw new Error('Builtin snapshot has no capability');
    const forged = Object.freeze({
      ...snapshot,
      capabilities: Object.freeze([
        Object.freeze({ ...first, definition: { ...first.definition } }),
        ...snapshot.capabilities.slice(1),
      ]),
    });
    expect(() => createBuiltinToolCatalogProjection(forged)).toThrow(
      'capability snapshot is invalid',
    );
  });

  test('binds execution-mechanism routing facts into the independent catalog revision', () => {
    const snapshot = createRuntimeModuleRegistry(createBuiltinRuntimeModules()).snapshot();
    const baseline = createBuiltinToolCatalogProjection(snapshot);
    const capabilities = snapshot.capabilities.map((entry) => {
      if (entry.definition.capabilityId !== 'builtin:read_file') return entry;
      const descriptor = entry.definition.descriptor;
      if (!descriptor) throw new Error('read_file descriptor is missing');
      return Object.freeze({
        ...entry,
        definition: Object.freeze({
          ...entry.definition,
          executionMechanism: 'git' as const,
          descriptor: Object.freeze({ ...descriptor, executionMechanism: 'git' as const }),
        }),
      });
    });
    const changed = createBuiltinToolCatalogProjection(
      Object.freeze({ ...snapshot, capabilities: Object.freeze(capabilities) }),
    );
    expect(changed.revision).not.toBe(baseline.revision);
  });

  test('projects strict parser, descriptor, availability, effects, and traits facts from one snapshot', async () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    const projection = createBuiltinToolCatalogProjection(registry, {
      turnContext: {
        toolSearchEnabled: true,
        hasTaskAdapter: true,
        hasGitBroker: true,
        brokeredGitFeatureRevision: 'brokered-git-r1',
        activeSkillFrameIds: ['frame-1'],
        availableSkillIds: ['skill-1'],
        featureFlags: {
          brokeredGit: true,
          skillWorkflow: true,
          skillActivation: true,
        },
      },
    });
    const readFile = projection.entries.find((entry) => entry.operationId === 'builtin:read_file');
    const shell = projection.entries.find((entry) => entry.operationId === 'builtin:shell_execute');
    const askUser = projection.entries.find((entry) => entry.operationId === 'builtin:ask_user');
    const task = projection.entries.find((entry) => entry.operationId === 'builtin:task');
    const dynamicMcp = projection.entries.find((entry) => entry.operationId === 'mcp:dynamic_tool');
    if (!readFile || !shell || !askUser || !task || !dynamicMcp) {
      throw new Error('expected Builtin contract entries are missing');
    }
    expect(readFile.descriptor).toMatchObject({
      capabilityId: 'builtin:read_file',
      revision: readFile.revision,
      kind: 'builtin_tool',
      displayName: 'read_file',
      descriptionProvenance: 'builtin',
      policy: {
        minimumApproval: 'none',
        workspaceTrustRequired: false,
        governanceRevision: 'trusted-workspace-file-access-v1',
      },
    });
    expect(readFile.descriptor.execution).toBeUndefined();
    if (readFile.descriptor.kind !== 'builtin_tool') {
      throw new Error('model descriptor was not projected as builtin_tool');
    }
    const runtimeContractDescriptor: CapabilityDescriptor = readFile.descriptor;
    expect(runtimeContractDescriptor.kind).toBe('builtin_tool');
    expect(readFile.modelDescription).toBe(
      buildDescription(BUILTIN_TOOL_CONTRACTS.read_file, 'catalog'),
    );
    expect(readFile.executionTraitsDeclaration).toMatchObject({
      resourceScopes: [{ kind: 'workspace', key: 'workspace' }],
      interactionBarrier: false,
      concurrencyGroup: 'parallel-read',
      leaseFenceRequired: true,
    });
    expect(shell.executionTraitsDeclaration).toMatchObject({
      resourceScopes: [
        { kind: 'process', key: 'shell' },
        { kind: 'workspace', key: 'workspace' },
      ],
      interactionBarrier: false,
      concurrencyGroup: 'parallel-read',
      leaseFenceRequired: true,
    });
    expect(
      projection.entries
        .filter((entry) => entry.executionTraitsDeclaration !== undefined)
        .map((entry) => entry.operationId)
        .sort(),
    ).toEqual([
      'builtin:list_mcp_resources',
      'builtin:list_mcp_tools',
      'builtin:read_file',
      'builtin:read_mcp_resource',
      'builtin:search_content',
      'builtin:search_files',
      'builtin:shell_execute',
      'builtin:task',
      'builtin:web_fetch',
    ]);
    expect(shell.descriptor.policy).toMatchObject({
      minimumApproval: 'user',
      governanceRevision: 'shell-effects-v1',
    });
    const git = projection.entries.find((entry) => entry.operationId === 'builtin:git_inspect');
    const writeFile = projection.entries.find(
      (entry) => entry.operationId === 'builtin:write_file',
    );
    const updatePlan = projection.entries.find(
      (entry) => entry.operationId === 'builtin:update_plan',
    );
    const toolSearch = projection.entries.find(
      (entry) => entry.operationId === 'builtin:tool_search',
    );
    if (!git || !writeFile || !updatePlan || !toolSearch) {
      throw new Error('expected traits parity entries are missing');
    }
    expect(git.executionTraitsDeclaration).toBeUndefined();
    expect(writeFile.executionTraitsDeclaration).toBeUndefined();
    expect(updatePlan.executionTraitsDeclaration).toBeUndefined();
    expect(toolSearch.executionTraitsDeclaration).toBeUndefined();
    expect(
      readFile.projectExecutionTraits(
        { path: 'src/index.ts' },
        {
          taskId: 'task-1',
          modelMessageId: 'message-1',
        },
      ),
    ).toMatchObject({
      access: 'read',
      conflictKeys: [],
      isolation: 'shared',
      causalGroup: 'task-1\0message-1',
      interactionBarrier: false,
    });
    expect(
      writeFile.projectExecutionTraits(
        { path: 'src/index.ts', content: 'x' },
        {
          taskId: 'task-1',
          toolCallId: 'call-1',
        },
      ),
    ).toMatchObject({
      access: 'write',
      conflictKeys: ['workspace'],
      isolation: 'exclusive_workspace',
      causalGroup: 'task-1\0call-1',
      interactionBarrier: true,
    });
    expect(askUser.kind).toBe('interrupt');
    expect(askUser.descriptor.kind).toBe('builtin_tool');
    expect(dynamicMcp.visibility).toBe('internal');
    expect(dynamicMcp.name).toBeUndefined();
    expect(dynamicMcp.descriptor.kind).toBe('internal_runtime');
    expect(
      projection.entries
        .filter((entry) => entry.visibility === 'model')
        .every((entry) => entry.descriptor.kind === 'builtin_tool'),
    ).toBe(true);
    expect(
      projection.entries
        .filter((entry) => entry.visibility === 'model')
        .every(
          (entry) =>
            entry.descriptor.provider.type === 'builtin' &&
            entry.descriptor.provider.id === 'kite-code' &&
            entry.descriptor.provider.provenance === 'builtin',
        ),
    ).toBe(true);
    for (const entry of projection.entries.filter(
      (candidate) => candidate.visibility === 'model',
    )) {
      if (!entry.name) throw new Error(`model entry has no name: ${entry.operationId}`);
      expect(entry.modelDescription, entry.name).toBe(
        buildDescription(
          BUILTIN_TOOL_CONTRACTS[entry.name as keyof typeof BUILTIN_TOOL_CONTRACTS],
          'catalog',
        ),
      );
      expect(entry.descriptor.kind, entry.name).toBe('builtin_tool');
      expect(entry.descriptor.provider.id, entry.name).toBe('kite-code');
    }
    const askDescriptor = projection.entries.find(
      (entry) => entry.operationId === 'builtin:ask_user',
    );
    if (askDescriptor?.visibility !== 'model') {
      throw new Error('ask_user descriptor is missing');
    }
    const { revision: askDescriptorRevision, ...askDescriptorContent } = askDescriptor.descriptor;
    expect(askDescriptorRevision).toBe(digestCapabilityBindingValue(askDescriptorContent));
    const expectedEffects: Readonly<
      Record<string, Readonly<{ effectClass: string; sideEffect: boolean; reason: string }>>
    > = {
      read_file: {
        effectClass: 'read_only',
        sideEffect: false,
        reason: 'read_file is a read-only capability.',
      },
      search_content: {
        effectClass: 'read_only',
        sideEffect: false,
        reason: 'search_content is a read-only capability.',
      },
      search_files: {
        effectClass: 'read_only',
        sideEffect: false,
        reason: 'search_files is a read-only capability.',
      },
      write_file: {
        effectClass: 'workspace_write',
        sideEffect: true,
        reason: 'write_file creates or overwrites workspace files.',
      },
      edit_file: {
        effectClass: 'workspace_write',
        sideEffect: true,
        reason: 'edit_file modifies workspace files.',
      },
      git_inspect: {
        effectClass: 'read_only',
        sideEffect: false,
        reason: 'Typed Git inspect is read-only and broker-bound.',
      },
      web_fetch: {
        effectClass: 'read_only',
        sideEffect: false,
        reason: 'Fetches public web content without external mutation.',
      },
      list_mcp_resources: {
        effectClass: 'read_only',
        sideEffect: false,
        reason: 'Reads governed MCP inventory or static resource content.',
      },
      list_mcp_tools: {
        effectClass: 'read_only',
        sideEffect: false,
        reason: 'Reads governed MCP inventory or static resource content.',
      },
      read_mcp_resource: {
        effectClass: 'read_only',
        sideEffect: false,
        reason: 'Reads governed MCP inventory or static resource content.',
      },
      read_skill_reference: {
        effectClass: 'read_only',
        sideEffect: false,
        reason: 'Operates on the active governed Skill frame.',
      },
      complete_skill: {
        effectClass: 'read_only',
        sideEffect: false,
        reason: 'Operates on the active governed Skill frame.',
      },
      activate_skill: {
        effectClass: 'external_side_effect',
        sideEffect: true,
        reason: 'Skill effects are governed by the disclosed compiled descriptor.',
      },
      read_plan: {
        effectClass: 'read_only',
        sideEffect: false,
        reason: 'Reads the active immutable Plan Artifact.',
      },
      update_plan: {
        effectClass: 'plan_only',
        sideEffect: false,
        reason: 'Updates progress in the active approved Plan.',
      },
      write_plan: {
        effectClass: 'plan_only',
        sideEffect: false,
        reason: 'Creates or submits an immutable Plan Artifact.',
      },
      ask_user: {
        effectClass: 'read_only',
        sideEffect: false,
        reason: 'Pauses execution for explicit user input.',
      },
      tool_search: {
        effectClass: 'read_only',
        sideEffect: false,
        reason: 'Searches governed capability metadata without issuing a binding.',
      },
      task: {
        effectClass: 'read_only',
        sideEffect: false,
        reason: 'explore sub-agent is read-only by role.',
      },
      shell_execute: {
        effectClass: 'read_only',
        sideEffect: false,
        reason: 'Shell command matches the versioned conservative read-only grammar.',
      },
    };
    for (const entry of projection.entries.filter(
      (candidate) => candidate.visibility === 'model',
    )) {
      if (!entry.name) throw new Error(`missing model tool name: ${entry.operationId}`);
      let input: RuntimeJsonValue = {};
      if (entry.name === 'task') {
        input = { subagent_type: 'explore', task: 'inspect the repository' };
      } else if (entry.name === 'shell_execute') {
        input = { command: 'cat package.json' };
      }
      const expected = expectedEffects[entry.name];
      if (!expected) throw new Error(`missing effects parity fixture: ${entry.name}`);
      expect(entry.classifyEffects(input), entry.name).toMatchObject({
        effectClass: expected.effectClass,
        sideEffect: expected.sideEffect,
        classificationReason: expected.reason,
      });
    }
    expect(Object.keys(projection.toolSet)).not.toContain('mcp:dynamic_tool');

    const validRead = readFile.parse({ path: 'src/index.ts' });
    expect(validRead).toEqual({ success: true, data: { path: 'src/index.ts' } });
    const unknownRead = readFile.parse({ path: 'src/index.ts', injected: 'ignored' });
    expect(unknownRead).toEqual({ success: true, data: { path: 'src/index.ts' } });
    expect(readFile.observeUnknownFields({ path: 'src/index.ts', injected: 'ignored' })).toEqual({
      schemaRevision: readFile.parser.parserRevision,
      fields: ['injected'],
      count: 1,
    });
    expect(readFile.canonicalize({ path: 'src/index.ts' })).toEqual({ path: 'src/index.ts' });
    expect(shell.classifyEffects({ command: 'cat package.json' })).toMatchObject({
      effectClass: 'read_only',
      sideEffect: false,
      risk: 'read',
    });
    expect(shell.classifyEffects({ command: 'curl https://example.com' })).toMatchObject({
      effectClass: 'external_side_effect',
      sideEffect: true,
      risk: 'network',
    });
    expect(shell.classifyEffects({ command: 'rm -rf build' })).toMatchObject({
      effectClass: 'workspace_write',
      sideEffect: true,
      risk: 'destructive',
    });
    expect(shell.classifyEffects({ command: 'git add src/index.ts' })).toMatchObject({
      effectClass: 'workspace_write',
      sideEffect: true,
      risk: 'external_state',
    });
    expect(shell.classifyEffects({ command: 'echo changed > output.txt' })).toMatchObject({
      effectClass: 'workspace_write',
      sideEffect: true,
      risk: 'workspace_write',
    });
    expect(readFile.projectApprovalSummary({ path: 'src/index.ts' })).toBe(
      'read_file src/index.ts',
    );
    expect(shell.projectApprovalSummary({ command: 'git status' })).toBe('git status');
    expect(
      task.classifyEffects({ subagent_type: 'explore', task: 'inspect the repository' }),
    ).toMatchObject({
      effectClass: 'read_only',
      sideEffect: false,
      risk: 'read',
      effectiveEffects: {
        filesystem: 'read',
        network: 'read',
        externalState: 'none',
      },
    });
    expect(
      task.classifyEffects({ subagent_type: 'code', task: 'change the repository safely' }),
    ).toMatchObject({
      effectClass: 'workspace_write',
      sideEffect: true,
      risk: 'workspace_write',
      effectiveEffects: {
        filesystem: 'write',
        network: 'unknown',
        externalState: 'none',
      },
    });
    expect(BUILTIN_TASK_PUBLIC_SCHEMA_).toBeDefined();
    let interruptCalls = 0;
    const interruptPort: CapabilityExecutionPort = {
      invoke: async () => {
        interruptCalls += 1;
        throw new Error('interrupt port must not be called');
      },
    };
    const askSchemaDigest = registry.capability('builtin:ask_user')?.inputSchemaDigest;
    if (!askSchemaDigest) throw new Error('ask_user schema digest is missing');
    await expect(
      projection.dispatch(
        'builtin:ask_user',
        interruptPort,
        catalogInvocation({
          operationId: 'builtin:ask_user',
          revision: askUser.revision,
          schemaDigest: askSchemaDigest,
          exposedToolName: 'ask_user',
        }),
      ),
    ).rejects.toThrow('user-input owner');
    expect(interruptCalls).toBe(0);
  });

  test('keeps task private artifacts runtime-only and fails closed without turn context', async () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    const hidden = createBuiltinToolCatalogProjection(registry);
    const task = hidden.entries.find((entry) => entry.operationId === 'builtin:task');
    const toolSearch = hidden.entries.find((entry) => entry.operationId === 'builtin:tool_search');
    const git = hidden.entries.find((entry) => entry.operationId === 'builtin:git_inspect');
    if (!task || !toolSearch || !git) throw new Error('task/tool_search/git entries are missing');
    const fullTurn = hidden.forTurn({
      toolSearchEnabled: true,
      hasTaskAdapter: true,
      hasGitBroker: true,
      brokeredGitFeatureRevision: 'brokered-git-r1',
      activeSkillFrameIds: ['frame-1'],
      availableSkillIds: ['skill-1'],
      featureFlags: { brokeredGit: true, skillWorkflow: true, skillActivation: true },
    });
    expect(hidden.revision).toBe(fullTurn.revision);
    expect(Object.keys(hidden.toolSet)).toHaveLength(14);
    expect(Object.keys(fullTurn.toolSet)).toHaveLength(19);
    expect(git.visibility).toBe('internal');
    expect(git.availability).toBe('available');
    const forgedGitTopLevel = createBuiltinToolCatalogProjection(registry.snapshot(), {
      turnContext: {
        hasGitBroker: true,
        brokeredGitFeatureRevision: 'brokered-git-r1',
        brokeredGit: true,
      } as unknown as CapabilityTurnContext,
    });
    expect(
      forgedGitTopLevel.entries.find((entry) => entry.operationId === 'builtin:git_inspect'),
    ).toMatchObject({ visibility: 'internal', availability: 'available' });
    expect(
      hidden.entries.find((entry) => entry.operationId === 'builtin:tool_search')?.descriptor
        .availability,
    ).toBe('available');
    expect(
      fullTurn.entries.find((entry) => entry.operationId === 'builtin:task')?.availability,
    ).toBe('available');
    const publicProjection = createBuiltinToolCatalogProjection(registry, {
      turnContext: { hasTaskAdapter: true },
    });
    const publicTask = publicProjection.entries.find(
      (entry) => entry.operationId === 'builtin:task',
    );
    if (!publicTask?.modelInputSchema) throw new Error('public task schema is missing');
    expect(publicTask.modelInputSchema.properties).not.toHaveProperty('taskArtifact');
    expect(
      (publicTask.modelInputSchema.properties as Record<string, unknown>).subagent_type,
    ).toMatchObject({
      enum: ['explore', 'plan', 'code', 'review'],
    });
    const planningProjection = createBuiltinToolCatalogProjection(registry, {
      turnContext: { hasTaskAdapter: true, phase: 'planning' },
    });
    const planningTask = planningProjection.entries.find(
      (entry) => entry.operationId === 'builtin:task',
    );
    expect(
      (planningTask?.modelInputSchema?.properties as Record<string, unknown> | undefined)
        ?.subagent_type,
    ).toMatchObject({
      enum: ['explore', 'plan', 'code', 'review'],
    });
    const privateInput = {
      name: 'Inspect delegated code',
      subagent_type: 'explore',
      taskArtifact: {
        artifactId: `pa_${'a'.repeat(64)}`,
        kind: 'subagent_task_request',
        integrityIdentifier: `sha256:${'b'.repeat(64)}`,
        byteLength: 128,
      },
    };
    expect(task.parse(privateInput).success).toBe(true);
    expect(task.parseModelInput(privateInput).success).toBe(false);
    expect(
      task.parseModelInput(
        { name: 'Inspect architecture', subagent_type: 'plan', task: 'inspect the architecture' },
        {
          phase: 'planning',
        },
      ).success,
    ).toBe(true);
    let calls = 0;
    const port: CapabilityExecutionPort = {
      invoke: async () => {
        calls += 1;
        throw new Error('must not be called');
      },
    };
    const schemaDigest = registry.capability('builtin:tool_search')?.inputSchemaDigest;
    if (!schemaDigest) throw new Error('tool_search schema digest is missing');
    await expect(
      hidden.dispatch(
        'builtin:tool_search',
        port,
        catalogInvocation({
          operationId: 'builtin:tool_search',
          revision: toolSearch.revision,
          schemaDigest,
          exposedToolName: 'tool_search',
        }),
      ),
    ).rejects.toThrow('not available');
    expect(calls).toBe(0);
    expect(hidden.dispatch).toHaveLength(3);
    expect(fullTurn.dispatch).toHaveLength(3);
    await expect(
      Reflect.apply(hidden.dispatch, hidden, [
        'builtin:tool_search',
        port,
        catalogInvocation({
          operationId: 'builtin:tool_search',
          revision: toolSearch.revision,
          schemaDigest,
          exposedToolName: 'tool_search',
        }),
        { toolSearchEnabled: true },
      ]),
    ).rejects.toThrow('not available');
    expect(calls).toBe(0);
    const validInvocation = catalogInvocation({
      operationId: 'builtin:tool_search',
      revision: toolSearch.revision,
      schemaDigest,
      exposedToolName: 'tool_search',
    });
    await expect(
      hidden.dispatch('builtin:tool_search', port, {
        ...validInvocation,
        binding: { ...validInvocation.binding, bindingId: 'forged-binding-id' },
      }),
    ).rejects.toThrow('invocation identity mismatch');
    expect(calls).toBe(0);
  });

  test('fails closed on model-name, visibility, availability, and receipt identity mismatches', async () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    const projection = createBuiltinToolCatalogProjection(registry.snapshot());
    const unavailable = createBuiltinToolCatalogProjection(registry.snapshot(), {
      turnContext: { toolSearchEnabled: false },
    });
    let portCalls = 0;
    const port: CapabilityExecutionPort = {
      invoke: async (invocation) => {
        portCalls += 1;
        const definition = registry.capability(invocation.request.capabilityId);
        const executor = registry.executor(invocation.request.capabilityId);
        if (!definition || !executor) throw new Error('fixture capability is missing');
        return {
          invocationId: invocation.request.invocationId,
          attemptId: invocation.attempt.attemptId,
          providerId: definition.providerId,
          executorRevision: executor.executorRevision,
          requestDigest: invocation.requestDigest,
          status: 'succeeded',
          dispatchCertainty: 'attempted',
          cleanupCertainty: 'not_required',
          value: null,
        };
      },
    };
    const readRevision = GIT_CAPABILITY_REVISIONS_['builtin:read_file'];
    const readSchemaDigest = registry.capability('builtin:read_file')?.inputSchemaDigest;
    if (!readSchemaDigest) throw new Error('read_file schema digest is missing');
    await expect(
      projection.dispatch(
        'builtin:read_file',
        port,
        catalogInvocation({
          operationId: 'builtin:read_file',
          revision: readRevision,
          schemaDigest: readSchemaDigest,
          exposedToolName: 'write_file',
        }),
      ),
    ).rejects.toThrow('invocation identity mismatch');
    expect(portCalls).toBe(0);

    await expect(
      projection.dispatch(
        'builtin:read_file',
        port,
        catalogInvocation({
          operationId: 'builtin:read_file',
          revision: readRevision,
          schemaDigest: readSchemaDigest,
          exposedToolName: undefined as unknown as string,
        }),
      ),
    ).rejects.toThrow('invocation identity mismatch');
    expect(portCalls).toBe(0);

    const toolSearchSchemaDigest = registry.capability('builtin:tool_search')?.inputSchemaDigest;
    if (!toolSearchSchemaDigest) throw new Error('tool_search schema digest is missing');
    await expect(
      unavailable.dispatch(
        'builtin:tool_search',
        port,
        catalogInvocation({
          operationId: 'builtin:tool_search',
          revision: TOOL_SEARCH_CAPABILITY_REVISION_,
          schemaDigest: toolSearchSchemaDigest,
          exposedToolName: 'tool_search',
        }),
      ),
    ).rejects.toThrow('not available');
    expect(portCalls).toBe(0);

    const internalOperation = 'model:primary';
    const internalRevision = VERIFICATION_CAPABILITY_REVISIONS_[internalOperation];
    const internalSchemaDigest = registry.capability(internalOperation)?.inputSchemaDigest;
    if (!internalSchemaDigest) throw new Error('internal Model schema digest is missing');
    await expect(
      unavailable.dispatch(
        internalOperation,
        port,
        catalogInvocation({
          operationId: internalOperation,
          revision: internalRevision,
          schemaDigest: internalSchemaDigest,
          exposedToolName: 'read_file',
        }),
      ),
    ).rejects.toThrow('invocation identity mismatch');
    expect(portCalls).toBe(0);

    const accepted = await unavailable.dispatch(
      internalOperation,
      port,
      catalogInvocation({
        operationId: internalOperation,
        revision: internalRevision,
        schemaDigest: internalSchemaDigest,
        exposedToolName: internalOperation,
      }),
    );
    expect(accepted.providerId).toBe('kite-builtin-runtime-verification');
    expect(portCalls).toBe(1);

    const forgedReceiptPort: CapabilityExecutionPort = {
      invoke: async (invocation) => ({
        invocationId: invocation.request.invocationId,
        attemptId: invocation.attempt.attemptId,
        providerId: 'wrong-provider',
        executorRevision: 'wrong-executor',
        requestDigest: invocation.requestDigest,
        status: 'succeeded',
        dispatchCertainty: 'attempted',
        cleanupCertainty: 'not_required',
        value: null,
      }),
    };
    await expect(
      unavailable.dispatch(
        internalOperation,
        forgedReceiptPort,
        catalogInvocation({
          operationId: internalOperation,
          revision: internalRevision,
          schemaDigest: internalSchemaDigest,
          exposedToolName: internalOperation,
          attemptId: 'forged-receipt-attempt',
        }),
      ),
    ).rejects.toThrow('receipt identity mismatch');
  });

  test('dispatches only through the supplied Host execution port', async () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    const projection = createBuiltinToolCatalogProjection(registry);
    const calls: string[] = [];
    const port: CapabilityExecutionPort = {
      invoke: async (invocation) => {
        calls.push(invocation.request.capabilityId);
        return {
          invocationId: invocation.request.invocationId,
          attemptId: invocation.attempt.attemptId,
          providerId: 'kite-builtin-runtime-git',
          executorRevision: GIT_EXECUTOR_REVISIONS_['builtin:read_file'],
          requestDigest: invocation.requestDigest,
          status: 'succeeded',
          dispatchCertainty: 'attempted',
          cleanupCertainty: 'not_required',
          value: null,
        };
      },
    };
    const revision = GIT_CAPABILITY_REVISIONS_['builtin:read_file'];
    const schemaDigest = registry.capability('builtin:read_file')?.inputSchemaDigest;
    if (!schemaDigest) throw new Error('read_file schema digest is missing');
    const bindingId = digestCapabilityBindingValue({
      capabilityId: 'builtin:read_file',
      revision,
      exposedToolName: 'read_file',
      schemaDigest,
      turnId: 'turn-1',
    });
    const result = await projection.dispatch('builtin:read_file', port, {
      binding: {
        bindingId,
        capabilityId: 'builtin:read_file',
        capabilityRevision: revision,
        exposedToolName: 'read_file',
        schemaDigest,
        issuedForTurnId: 'turn-1',
      },
      request: {
        invocationId: 'invocation-1',
        capabilityId: 'builtin:read_file',
        capabilityRevision: revision,
        input: {},
      },
      grant: {
        grantId: 'grant-1',
        capabilityId: 'builtin:read_file',
        capabilityRevision: revision,
        authority: {},
      },
      requestDigest: 'request-1',
      environment: { environmentId: 'test', kind: 'in_process' },
      attempt: { invocationId: 'invocation-1', attemptId: 'attempt-1' },
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('succeeded');
    expect(calls).toEqual(['builtin:read_file']);
    await expect(
      projection.dispatch('builtin:read_file', port, {
        binding: {
          bindingId,
          capabilityId: 'builtin:read_file',
          capabilityRevision: revision,
          exposedToolName: 'read_file',
          schemaDigest,
          issuedForTurnId: 'turn-1',
        },
        request: {
          invocationId: 'invocation-1',
          capabilityId: 'builtin:read_file',
          capabilityRevision: PLANNING_CAPABILITY_REVISION_,
          input: {},
        },
        grant: {
          grantId: 'grant-1',
          capabilityId: 'builtin:read_file',
          capabilityRevision: revision,
          authority: {},
        },
        requestDigest: 'request-1',
        environment: { environmentId: 'test', kind: 'in_process' },
        attempt: { invocationId: 'invocation-1', attemptId: 'attempt-2' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('invocation identity mismatch');
    expect(calls).toEqual(['builtin:read_file']);
  });

  test('fails closed before calling MCP when the exact inner identity is unavailable', async () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    const executor = registry.executor('mcp:dynamic_tool');
    if (!executor) throw new Error('dynamic MCP executor missing');
    let calls = 0;
    const receipt = await executor.execute(
      {
        invocationId: 'invocation-1',
        capabilityId: 'mcp:dynamic_tool',
        capabilityRevision: MODEL_CAPABILITY_REVISIONS_['mcp:dynamic_tool'],
        input: {
          capability_id: 'mcp:docs:search',
          capability_revision: 'tool-revision-1',
          arguments: { query: 'runtime' },
        },
      },
      {
        grant: {
          grantId: 'grant-1',
          capabilityId: 'mcp:dynamic_tool',
          capabilityRevision: MODEL_CAPABILITY_REVISIONS_['mcp:dynamic_tool'],
          authority: {},
        },
        requestDigest: 'request-digest-1',
        signal: new AbortController().signal,
        environment: {
          environmentId: 'test',
          kind: 'in_process',
          mechanisms: {
            mcp: {
              runtime: {
                getCapabilitySnapshot: () => ({}),
                getProviderDirectorySnapshot: () => ({}),
                getResourceDirectorySnapshot: () => ({}),
                findCapability: () => {
                  calls += 1;
                  return { revision: 'tool-revision-1' };
                },
                callCapability: async () => {
                  calls += 1;
                  return { content: [] };
                },
                readResource: async () => '',
              },
              invocation: {
                capabilityId: 'mcp:docs:other',
                expectedRevision: 'tool-revision-1',
              },
            },
          },
        },
        attempt: { invocationId: 'invocation-1', attemptId: 'attempt-1' },
      },
    );
    expect(receipt.status).toBe('succeeded');
    expect(isBuiltinOperationExecutionValue(receipt.value)).toBe(true);
    if (!isBuiltinOperationExecutionValue(receipt.value)) throw new Error('invalid result');
    expect(receipt.value).toMatchObject({
      ok: false,
      stderr: 'Dynamic MCP invocation identity is unavailable or changed.',
    });
    expect(calls).toBe(0);
    expect(DYNAMIC_MCP_OPERATION_INPUT_SCHEMA_.required).toEqual([
      'capability_id',
      'capability_revision',
      'arguments',
    ]);
  });

  test('projects a typed Dynamic MCP provider failure into a retry-classifiable receipt', async () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    const executor = registry.executor('mcp:dynamic_tool');
    if (!executor) throw new Error('dynamic MCP executor missing');
    let providerCalls = 0;
    const receipt = await executor.execute(
      {
        invocationId: 'invocation-retry-1',
        capabilityId: 'mcp:dynamic_tool',
        capabilityRevision: MODEL_CAPABILITY_REVISIONS_['mcp:dynamic_tool'],
        input: {
          capability_id: 'mcp:docs:search',
          capability_revision: 'tool-revision-1',
          arguments: { query: 'runtime' },
        },
      },
      {
        grant: {
          grantId: 'grant-retry-1',
          capabilityId: 'mcp:dynamic_tool',
          capabilityRevision: MODEL_CAPABILITY_REVISIONS_['mcp:dynamic_tool'],
          authority: {},
        },
        requestDigest: 'request-retry-1',
        signal: new AbortController().signal,
        environment: {
          environmentId: 'test',
          kind: 'in_process',
          mechanisms: {
            mcp: {
              runtime: {
                getCapabilitySnapshot: () => ({}),
                getProviderDirectorySnapshot: () => ({}),
                getResourceDirectorySnapshot: () => ({}),
                findCapability: () => ({ revision: 'tool-revision-1' }),
                callCapability: async () => {
                  providerCalls += 1;
                  throw new McpProviderError({
                    kind: 'provider_unavailable',
                    providerId: 'mcp-provider',
                    message: 'provider unavailable',
                    retryable: true,
                  });
                },
                readResource: async () => '',
              },
              invocation: {
                capabilityId: 'mcp:docs:search',
                expectedRevision: 'tool-revision-1',
              },
            },
          },
        },
        attempt: { invocationId: 'invocation-retry-1', attemptId: 'attempt-retry-1' },
      },
    );
    expect(providerCalls).toBe(1);
    expect(receipt).toMatchObject({
      status: 'failed',
      dispatchCertainty: 'attempted',
      cleanupCertainty: 'not_required',
      failure: {
        code: 'provider_unavailable',
        retryable: true,
      },
    });
    expect('value' in receipt).toBe(false);
  });

  test('uses the outer Tool identity for planning events and rejects a missing identity', async () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    const executor = registry.executor('builtin:write_plan');
    if (!executor) throw new Error('write_plan executor missing');
    const observedToolCallIds: string[] = [];
    const context = {
      grant: {
        grantId: 'plan-grant-1',
        capabilityId: 'builtin:write_plan',
        capabilityRevision: SUBAGENT_CAPABILITY_REVISIONS_['builtin:write_plan'],
        authority: {},
      },
      requestDigest: 'plan-request-1',
      signal: new AbortController().signal,
      environment: {
        environmentId: 'plan-test',
        kind: 'in_process' as const,
        mechanisms: Object.freeze({
          planning: Object.freeze({
            read: async () => ({ ok: true, stdout: '', stderr: '' }),
            update: async () => ({ ok: true, stdout: '', stderr: '' }),
            write: async (toolCallId: string) => {
              observedToolCallIds.push(toolCallId);
              return { ok: true, stdout: 'saved', stderr: '' };
            },
          }),
        }),
      },
      attempt: { invocationId: 'capability-invocation', attemptId: 'plan-attempt-1' },
    };
    const request = {
      invocationId: 'capability-invocation',
      capabilityId: 'builtin:write_plan',
      capabilityRevision: SUBAGENT_CAPABILITY_REVISIONS_['builtin:write_plan'],
      input: {
        title: 'Inspect',
        body_markdown: 'Inspect the Runtime identity boundary.',
        steps: [{ id: 'inspect', title: 'Inspect Runtime identity' }],
        action: 'save',
      },
    } as const;
    const accepted = await executor.execute(
      {
        ...request,
        facts: Object.freeze({ toolCallId: 'outer-tool-call' }),
      },
      context,
    );
    expect(accepted.status).toBe('succeeded');
    expect(observedToolCallIds).toEqual(['outer-tool-call']);

    const rejected = await executor.execute(request, {
      ...context,
      attempt: { invocationId: 'capability-invocation', attemptId: 'plan-attempt-2' },
    });
    expect(rejected.status).toBe('succeeded');
    expect(rejected.value).toMatchObject({
      ok: false,
      stderr: 'Plan Runtime tool-call identity is unavailable.',
    });
    expect(observedToolCallIds).toEqual(['outer-tool-call']);
  });

  test('fails closed when web execution has neither an injected fetch nor an unavailable decision', async () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    const executor = registry.executor('builtin:web_fetch');
    if (!executor) throw new Error('web executor missing');
    const receipt = await executor.execute(
      {
        invocationId: 'web-invocation-1',
        capabilityId: 'builtin:web_fetch',
        capabilityRevision: MODEL_CAPABILITY_REVISIONS_['builtin:web_fetch'],
        input: { url: 'https://example.com' },
      },
      {
        grant: {
          grantId: 'web-grant-1',
          capabilityId: 'builtin:web_fetch',
          capabilityRevision: MODEL_CAPABILITY_REVISIONS_['builtin:web_fetch'],
          authority: {},
        },
        requestDigest: 'web-request-1',
        signal: new AbortController().signal,
        environment: {
          environmentId: 'web-test',
          kind: 'in_process',
          mechanisms: Object.freeze({ web: Object.freeze({}) }),
        },
        attempt: { invocationId: 'web-invocation-1', attemptId: 'web-attempt-1' },
      },
    );
    expect(receipt.status).toBe('succeeded');
    expect(isBuiltinOperationExecutionValue(receipt.value)).toBe(true);
    if (!isBuiltinOperationExecutionValue(receipt.value)) throw new Error('invalid result');
    expect(receipt.value).toMatchObject({
      ok: false,
      stderr: 'Builtin web execution requires an explicit fetch port or unavailable decision.',
    });
  });

  test('projects Context candidates only from immutable committed facts with fixed authority', () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    const facts = Object.freeze({
      projectInstructionFragments: Object.freeze([
        Object.freeze({
          fragmentId: 'project-1',
          tokenEstimate: 3,
          disclosure: 'always',
          content: 'project instruction',
        }),
      ]),
      skillContextFragments: Object.freeze([
        Object.freeze({
          fragmentId: 'skill-1',
          tokenEstimate: 2,
          disclosure: 'selected',
          content: Object.freeze({ skill: 'one' }),
        }),
      ]),
      mcpObservationFragments: Object.freeze([
        Object.freeze({
          fragmentId: 'mcp-1',
          tokenEstimate: 1,
          disclosure: 'on_demand',
          content: 'untrusted observation',
        }),
      ]),
    });
    const candidates = registry.snapshot().contextSources.flatMap(({ sourceId }) => {
      const source = registry.contextSource(sourceId);
      if (!source) throw new Error(`missing Context source: ${sourceId}`);
      return source.collect({
        sessionId: 'session-1',
        projectId: 'project_fixture',
        purpose: 'model',
        committedFacts: facts,
      });
    });
    expect(candidates).toEqual([
      {
        fragmentId: 'project-1',
        kind: 'project_instruction',
        authority: 'project',
        content: 'project instruction',
        tokenEstimate: 3,
        disclosure: 'always',
      },
      {
        fragmentId: 'skill-1',
        kind: 'skill_instruction',
        authority: 'user',
        content: { skill: 'one' },
        tokenEstimate: 2,
        disclosure: 'selected',
      },
      {
        fragmentId: 'mcp-1',
        kind: 'external_content',
        authority: 'external',
        content: 'untrusted observation',
        tokenEstimate: 1,
        disclosure: 'on_demand',
      },
    ]);
    expect(Object.isFrozen(candidates[0])).toBe(true);
  });

  test('owns deterministic Context selection and fails closed for required overflow', async () => {
    const compiler = createBuiltinContextCompilerPort();
    const candidates = [
      {
        fragmentId: 'always-1',
        kind: 'project_instruction',
        authority: 'project',
        content: 'required',
        tokenEstimate: 3,
        disclosure: 'always',
      },
      {
        fragmentId: 'selected-too-large',
        kind: 'skill_instruction',
        authority: 'user',
        content: 'skip',
        tokenEstimate: 4,
        disclosure: 'selected',
      },
      {
        fragmentId: 'selected-1',
        kind: 'skill_instruction',
        authority: 'user',
        content: 'include',
        tokenEstimate: 2,
        disclosure: 'selected',
      },
      {
        fragmentId: 'on-demand-1',
        kind: 'external_content',
        authority: 'external',
        content: 'exclude',
        tokenEstimate: 1,
        disclosure: 'on_demand',
      },
    ] as const;
    const compiled = await compiler.compile({ purpose: 'model', tokenBudget: 5, candidates });
    expect(compiled.selectedFragmentIds).toEqual(['always-1', 'selected-1']);
    expect(compiled.payload).toMatchObject({
      schema: 'kite.compiled-context.v1',
      purpose: 'model',
      tokenEstimate: 5,
    });
    expect(Object.isFrozen(compiled.selectedFragmentIds)).toBe(true);
    await expect(
      compiler.compile({ purpose: 'model', tokenBudget: 2, candidates }),
    ).rejects.toThrow('Required Context fragment exceeds');
  });

  test('searches only immutable projected facts and returns bounded public metadata', async () => {
    const facts = createToolSearchProviderFacts({
      threadId: 'thread-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      mcpDescriptors: [
        {
          capabilityId: 'mcp:github/publish_release',
          revision: 'revision-1',
          kind: 'mcp_tool',
          displayName: 'publish_release',
          description: 'Publish a release artifact.',
          provider: { type: 'mcp', id: 'github' },
          availability: 'available',
        },
      ],
      providerEntries: [
        {
          providerId: 'github-offline',
          status: 'login_required',
          lastKnownCapabilityNames: ['publish_release'],
          diagnosticCode: 'auth_required',
        },
      ],
    });
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts.descriptors)).toBe(true);
    expect(Object.isFrozen(facts.descriptors[0])).toBe(true);

    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    const executor = registry.executor(TOOL_SEARCH_CAPABILITY_ID_);
    if (!executor) throw new Error('tool_search executor missing');
    const receipt = await executor.execute(
      {
        invocationId: 'invocation-1',
        capabilityId: TOOL_SEARCH_CAPABILITY_ID_,
        capabilityRevision: TOOL_SEARCH_CAPABILITY_REVISION_,
        input: { query: 'publish release' },
        facts,
      },
      {
        grant: {
          grantId: 'grant-1',
          capabilityId: TOOL_SEARCH_CAPABILITY_ID_,
          capabilityRevision: TOOL_SEARCH_CAPABILITY_REVISION_,
          authority: {},
        },
        requestDigest: 'request-digest-1',
        signal: new AbortController().signal,
        environment: { environmentId: 'test', kind: 'in_process' },
        attempt: { invocationId: 'invocation-1', attemptId: 'attempt-1' },
      },
    );
    expect(receipt).toMatchObject({
      status: 'succeeded',
      invocationId: 'invocation-1',
      attemptId: 'attempt-1',
      requestDigest: 'request-digest-1',
    });
    expect(isToolSearchExecutionValue(receipt.value)).toBe(true);
    if (!isToolSearchExecutionValue(receipt.value)) throw new Error('invalid result');
    const visible = JSON.parse(receipt.value.stdout) as Record<string, unknown>;
    expect(visible).toMatchObject({
      candidate_count: 1,
      candidates: [
        {
          kind: 'mcp_tool',
          name: 'publish_release',
          provider_type: 'mcp',
          provider: 'github',
        },
      ],
      provider_count: 1,
    });
    expect(receipt.value.stdout).not.toContain('mcp:github/publish_release');
    expect(receipt.value.stdout).not.toContain('Publish a release artifact.');
  });

  test('has no Workspace, MCP manager, or Model dependency', () => {
    const source = readFileSync(new URL('../src/tool-search.ts', import.meta.url), 'utf8');
    for (const forbidden of [
      '@kite-ai/builtin-runtime/mcp',
      'McpRuntimeProvider',
      'SkillCatalogSnapshot',
      'SupportedChatModel',
      'workspace',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
