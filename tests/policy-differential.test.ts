import { describe, expect, test } from 'bun:test';
import {
  type BuiltinModelToolCatalogEntry,
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
  digestCapabilityBindingValue,
} from '@kite/builtin-runtime';
import {
  type CapabilityExecutionInvocation,
  type CapabilityExecutionPort,
  type CapabilityPolicyCompilation,
  type CapabilityPolicyContext,
  createRuntimeModuleRegistry,
  type ExecutionReceipt,
  type RuntimeJsonValue,
} from '@kite/runtime-spi';

const WORKSPACE = '/tmp/kite-rmv1-s7b-policy-workspace';

const TURN_CONTEXT: CapabilityPolicyContext = Object.freeze({
  workspace: WORKSPACE,
  phase: 'building',
  threadId: 's7b-policy-thread',
  turnId: 's7b-policy-turn',
  toolSearchEnabled: true,
  hasTaskAdapter: true,
  hasGitBroker: true,
  brokeredGitFeatureRevision: 'brokered-git-r1',
  activeSkillFrameIds: Object.freeze(['skill-frame']),
  availableSkillIds: Object.freeze(['skill']),
  featureFlags: Object.freeze({
    brokeredGit: true,
    skillWorkflow: true,
    skillActivation: true,
  }),
});

const EXPECTED_MODEL_TOOL_NAMES = Object.freeze([
  'activate_skill',
  'ask_user',
  'complete_skill',
  'edit_file',
  'git_inspect',
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
] as const);

interface DifferentialVector {
  readonly label: string;
  readonly toolName: (typeof EXPECTED_MODEL_TOOL_NAMES)[number];
  readonly input: RuntimeJsonValue;
  readonly phase: 'planning' | 'building';
}

const MODEL_VECTORS: readonly DifferentialVector[] = [
  {
    label: 'tool_search',
    toolName: 'tool_search',
    input: { query: 'database' },
    phase: 'building',
  },
  {
    label: 'web_fetch',
    toolName: 'web_fetch',
    input: { url: 'https://example.com/docs' },
    phase: 'building',
  },
  {
    label: 'list_mcp_resources',
    toolName: 'list_mcp_resources',
    input: { server: 'docs' },
    phase: 'building',
  },
  {
    label: 'list_mcp_tools',
    toolName: 'list_mcp_tools',
    input: { provider: 'docs', limit: 5 },
    phase: 'building',
  },
  {
    label: 'read_mcp_resource',
    toolName: 'read_mcp_resource',
    input: { server: 'docs', uri: 'file:///docs/api.md' },
    phase: 'building',
  },
  {
    label: 'read_skill_reference',
    toolName: 'read_skill_reference',
    input: { activation_id: 'activation-1', path: 'README.md' },
    phase: 'building',
  },
  {
    label: 'complete_skill',
    toolName: 'complete_skill',
    input: { activation_id: 'activation-1', output: { ok: true } },
    phase: 'building',
  },
  {
    label: 'activate_skill',
    toolName: 'activate_skill',
    input: { skill_id: 'skill', input: {} },
    phase: 'building',
  },
  {
    label: 'read_file',
    toolName: 'read_file',
    input: { path: 'src/index.ts' },
    phase: 'building',
  },
  {
    label: 'search_content',
    toolName: 'search_content',
    input: { pattern: 'function', path: 'src' },
    phase: 'building',
  },
  {
    label: 'search_files',
    toolName: 'search_files',
    input: { pattern: '*.ts', path: 'src' },
    phase: 'building',
  },
  {
    label: 'write_file',
    toolName: 'write_file',
    input: { path: 'src/new.ts', content: 'new content' },
    phase: 'building',
  },
  {
    label: 'edit_file',
    toolName: 'edit_file',
    input: { path: 'src/new.ts', old_string: 'old', new_string: 'new' },
    phase: 'building',
  },
  {
    label: 'git_inspect',
    toolName: 'git_inspect',
    input: { operation: 'status' },
    phase: 'building',
  },
  {
    label: 'shell_execute',
    toolName: 'shell_execute',
    input: { command: 'ls -la' },
    phase: 'building',
  },
  {
    label: 'ask_user',
    toolName: 'ask_user',
    input: {
      questions: [
        {
          question: 'Continue?',
          options: [
            { label: 'Yes', description: 'Continue.', recommended: true },
            { label: 'No', description: 'Stop.', recommended: false },
          ],
        },
      ],
    },
    phase: 'building',
  },
  {
    label: 'read_plan',
    toolName: 'read_plan',
    input: { plan_id: 'plan-1' },
    phase: 'building',
  },
  {
    label: 'update_plan',
    toolName: 'update_plan',
    input: {
      plan_id: 'plan-1',
      updates: [{ step_id: 'step-1', status: 'in_progress' }],
    },
    phase: 'building',
  },
  {
    label: 'write_plan',
    toolName: 'write_plan',
    input: {
      action: 'save',
      title: 'A plan',
      body_markdown: 'This plan contains enough detail.',
      steps: [{ id: 'step-1', title: 'Do the work' }],
    },
    phase: 'building',
  },
  {
    label: 'task',
    toolName: 'task',
    input: { subagent_type: 'code', task: 'Implement the requested feature.' },
    phase: 'building',
  },
];
Object.freeze(MODEL_VECTORS);

const EXTRA_VECTORS: readonly DifferentialVector[] = [
  {
    label: 'shell protected path',
    toolName: 'shell_execute',
    input: { command: 'cat ~/.ssh/id_ed25519' },
    phase: 'building',
  },
  {
    label: 'shell workspace-root rm',
    toolName: 'shell_execute',
    input: { command: 'rm -rf .' },
    phase: 'building',
  },
  {
    label: 'shell critical-path rm',
    toolName: 'shell_execute',
    input: { command: 'rm -rf /etc/nginx' },
    phase: 'building',
  },
  {
    label: 'shell external rm',
    toolName: 'shell_execute',
    input: { command: 'rm -rf /tmp/build' },
    phase: 'building',
  },
  {
    label: 'shell vcs network',
    toolName: 'shell_execute',
    input: { command: 'git push origin main' },
    phase: 'building',
  },
  {
    label: 'shell local vcs mutation',
    toolName: 'shell_execute',
    input: { command: 'git commit -m update' },
    phase: 'building',
  },
  {
    label: 'shell network client write',
    toolName: 'shell_execute',
    input: { command: 'curl -o /tmp/out https://example.com' },
    phase: 'building',
  },
  {
    label: 'shell external read option',
    toolName: 'shell_execute',
    input: { command: 'rg -f /tmp/kite-patterns src' },
    phase: 'building',
  },
  {
    label: 'shell uncertain script',
    toolName: 'shell_execute',
    input: { command: 'node script.js' },
    phase: 'building',
  },
  {
    label: 'shell external write',
    toolName: 'shell_execute',
    input: { command: 'touch ../outside.txt' },
    phase: 'building',
  },
  {
    label: 'shell planning non-read',
    toolName: 'shell_execute',
    input: { command: 'bun test' },
    phase: 'planning',
  },
  {
    label: 'shell planning read',
    toolName: 'shell_execute',
    input: { command: 'pwd' },
    phase: 'planning',
  },
  {
    label: 'web invalid URL',
    toolName: 'web_fetch',
    input: { url: 'not-a-url' },
    phase: 'building',
  },
  {
    label: 'web userinfo URL',
    toolName: 'web_fetch',
    input: { url: 'https://user:pass@example.com/docs' },
    phase: 'building',
  },
  {
    label: 'web credential query',
    toolName: 'web_fetch',
    input: { url: 'https://example.com/?api_key=123456789012345678901234567890' },
    phase: 'building',
  },
  {
    label: 'file external read',
    toolName: 'read_file',
    input: { path: '/tmp/external.txt' },
    phase: 'building',
  },
  {
    label: 'search external read',
    toolName: 'search_content',
    input: { pattern: 'needle', path: '/tmp' },
    phase: 'building',
  },
  {
    label: 'file external write',
    toolName: 'write_file',
    input: { path: '/tmp/external.txt', content: 'x' },
    phase: 'building',
  },
  {
    label: 'file planning write',
    toolName: 'edit_file',
    input: { path: 'src/new.ts', old_string: 'old', new_string: 'new' },
    phase: 'planning',
  },
  {
    label: 'task planning code',
    toolName: 'task',
    input: { subagent_type: 'code', task: 'Implement the requested feature.' },
    phase: 'planning',
  },
  {
    label: 'task planning review',
    toolName: 'task',
    input: { subagent_type: 'review', task: 'Review the requested feature.' },
    phase: 'planning',
  },
  {
    label: 'task planning explore',
    toolName: 'task',
    input: { subagent_type: 'explore', task: 'Inspect the relevant code paths.' },
    phase: 'planning',
  },
  {
    label: 'task planning plan',
    toolName: 'task',
    input: { subagent_type: 'plan', task: 'Prepare the implementation plan.' },
    phase: 'planning',
  },
  {
    label: 'activate skill planning',
    toolName: 'activate_skill',
    input: { skill_id: 'skill', input: {} },
    phase: 'planning',
  },
];
Object.freeze(EXTRA_VECTORS);

function expectedAuthorizationEligibility(vector: DifferentialVector): Readonly<{
  minimumApproval: CapabilityPolicyCompilation['minimumApproval'];
  fullAccessMayBypassApproval: boolean;
  sameCommandMayBypassApproval: boolean;
}> {
  if (vector.toolName === 'activate_skill' || vector.toolName === 'task') {
    return {
      minimumApproval: 'user',
      fullAccessMayBypassApproval: false,
      sameCommandMayBypassApproval: false,
    };
  }
  if (vector.toolName === 'write_file' || vector.toolName === 'edit_file') {
    const externalWrite = vector.label === 'file external write';
    return {
      minimumApproval: 'none',
      fullAccessMayBypassApproval: vector.phase === 'building' && !externalWrite,
      sameCommandMayBypassApproval: false,
    };
  }
  if (vector.toolName === 'shell_execute') {
    if (vector.label === 'shell vcs network' || vector.label === 'shell local vcs mutation') {
      return {
        minimumApproval: 'user',
        fullAccessMayBypassApproval: false,
        sameCommandMayBypassApproval: false,
      };
    }
    const reusable = new Set([
      'shell network client write',
      'shell uncertain script',
      'shell external write',
    ]).has(vector.label);
    return {
      minimumApproval: 'user',
      fullAccessMayBypassApproval: reusable,
      sameCommandMayBypassApproval: reusable,
    };
  }
  return {
    minimumApproval: 'none',
    fullAccessMayBypassApproval: false,
    sameCommandMayBypassApproval: false,
  };
}

function contextForPhase(phase: DifferentialVector['phase']): CapabilityPolicyContext {
  return Object.freeze({ ...TURN_CONTEXT, phase });
}

function modelEntry(
  projection: ReturnType<typeof createBuiltinToolCatalogProjection>,
  name: DifferentialVector['toolName'],
): BuiltinModelToolCatalogEntry {
  const entry = projection.entries.find(
    (candidate): candidate is BuiltinModelToolCatalogEntry =>
      candidate.visibility === 'model' && candidate.name === name,
  );
  if (!entry) throw new Error(`missing model catalog entry: ${name}`);
  return entry;
}

function canonicalInputForVector(
  entry: BuiltinModelToolCatalogEntry,
  vector: DifferentialVector,
  context: CapabilityPolicyContext,
): RuntimeJsonValue {
  const parsed = entry.parse(vector.input, context);
  if (!parsed.success) {
    throw new Error(
      `Builtin differential vector failed canonical parse: ${vector.label}: ${JSON.stringify(parsed.issues)}`,
    );
  }
  return parsed.data;
}

function askUserInvocation(entry: BuiltinModelToolCatalogEntry): CapabilityExecutionInvocation {
  const schemaDigest = entry.inputSchemaDigest;
  if (!schemaDigest) throw new Error('ask_user schema digest is missing');
  const bindingId = digestCapabilityBindingValue({
    capabilityId: entry.operationId,
    revision: entry.revision,
    exposedToolName: entry.name,
    schemaDigest,
    turnId: 's7b-ask-user-turn',
  });
  return {
    binding: {
      bindingId,
      capabilityId: entry.operationId,
      capabilityRevision: entry.revision,
      exposedToolName: entry.name,
      schemaDigest,
      issuedForTurnId: 's7b-ask-user-turn',
    },
    request: {
      invocationId: 's7b-ask-user-invocation',
      capabilityId: entry.operationId,
      capabilityRevision: entry.revision,
      input: {},
    },
    grant: {
      grantId: 's7b-ask-user-grant',
      capabilityId: entry.operationId,
      capabilityRevision: entry.revision,
      authority: {},
    },
    requestDigest: 's7b-ask-user-request',
    environment: { environmentId: 's7b-test', kind: 'in_process' },
    attempt: {
      invocationId: 's7b-ask-user-invocation',
      attemptId: 's7b-ask-user-attempt',
    },
    signal: new AbortController().signal,
  };
}

describe('RM-16 S7B Builtin policy corpus', () => {
  test('compiles one frozen snapshot, all 20 model operations, and fixed policy corpus', async () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    const snapshot = registry.snapshot();
    const projection = createBuiltinToolCatalogProjection(snapshot, {
      turnContext: TURN_CONTEXT,
    });
    const modelEntries = projection.entries.filter(
      (entry): entry is BuiltinModelToolCatalogEntry => entry.visibility === 'model',
    );
    const internalEntries = projection.entries.filter((entry) => entry.visibility === 'internal');

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.modules)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
    expect(projection.entries).toHaveLength(29);
    expect(modelEntries).toHaveLength(20);
    expect(internalEntries).toHaveLength(9);
    expect(modelEntries.map((entry) => entry.name).sort()).toEqual(
      [...EXPECTED_MODEL_TOOL_NAMES].sort(),
    );
    expect(internalEntries.some((entry) => entry.operationId === 'mcp:dynamic_tool')).toBe(true);
    expect(internalEntries.every((entry) => !('compilePolicy' in entry))).toBe(true);

    for (const vector of [...MODEL_VECTORS, ...EXTRA_VECTORS]) {
      const context = contextForPhase(vector.phase);
      const entry = modelEntry(projection, vector.toolName);
      const canonicalInput = canonicalInputForVector(entry, vector, context);
      const compiled = entry.compilePolicy(canonicalInput, context);
      expect(compiled.operationId, vector.label).toBe(entry.operationId);
      expect(compiled.capabilityRevision, vector.label).toBe(entry.revision);
      expect(compiled.parserRevision, vector.label).toBe(entry.parser.parserRevision);
      expect(compiled, vector.label).toMatchObject(expectedAuthorizationEligibility(vector));
      expect(compiled.minimumApproval, vector.label).toBe(entry.descriptor.policy.minimumApproval);
      expect(Object.isFrozen(compiled), vector.label).toBe(true);
      expect(Object.isFrozen(compiled.expectedEffects), vector.label).toBe(true);
      expect(Object.isFrozen(compiled.effectiveEffects), vector.label).toBe(true);
      if (compiled.effects) expect(Object.isFrozen(compiled.effects), vector.label).toBe(true);
    }

    const askUser = modelEntry(projection, 'ask_user');
    const askUserVector = MODEL_VECTORS.find((vector) => vector.toolName === 'ask_user')!;
    const askUserFacts = askUser.compilePolicy(
      canonicalInputForVector(askUser, askUserVector, TURN_CONTEXT),
      TURN_CONTEXT,
    );
    expect(askUserFacts.decision).toBe('allow');
    let interruptCalls = 0;
    const interruptPort: CapabilityExecutionPort = {
      invoke: async (): Promise<ExecutionReceipt> => {
        interruptCalls += 1;
        throw new Error('ask_user dispatch must not call Host port');
      },
    };
    await expect(
      projection.dispatch('builtin:ask_user', interruptPort, askUserInvocation(askUser)),
    ).rejects.toThrow('user-input owner');
    expect(interruptCalls).toBe(0);

    // Dynamic MCP remains an internal operation and is intentionally excluded
    // from the 20 Builtin model policy comparison.
    const dynamicMcp = internalEntries.find((entry) => entry.operationId === 'mcp:dynamic_tool');
    expect(dynamicMcp).toBeDefined();
    expect(dynamicMcp && 'compilePolicy' in dynamicMcp).toBe(false);
  });
});
