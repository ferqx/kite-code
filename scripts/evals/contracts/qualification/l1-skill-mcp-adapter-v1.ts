import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshot } from '../../../../src/core/capabilities/catalog';
import type { AgentConfig } from '../../../../src/core/config';
import { getFeatureFlags } from '../../../../src/core/config/features';
import type {
  McpConfigCatalog,
  McpServerConfigEntry,
} from '../../../../src/core/config/mcp-config';
import type { McpConfigRepository } from '../../../../src/core/config/mcp-config-repository';
import { executeRuntimeTools } from '../../../../src/core/controllers/tool-controller';
import type { McpAuthCoordinator } from '../../../../src/core/mcp/auth-coordinator';
import { McpProviderError } from '../../../../src/core/mcp/provider-errors';
import type { McpRuntimeProvider } from '../../../../src/core/mcp/runtime-provider';
import {
  DefaultMcpSupervisor,
  type McpConnectionManagerControlPlane,
} from '../../../../src/core/mcp/supervisor';
import { classifyMcpWriteRecoveryV1 } from '../../../../src/core/mcp/write-governance';
import { eventsForRuntimeAction } from '../../../../src/core/runtime/actions';
import { AgentKernel } from '../../../../src/core/runtime/kernel';
import { reduceRuntimeState } from '../../../../src/core/runtime/reducer';
import { runRuntimeLoop } from '../../../../src/core/runtime/runner';
import { decideNextEffect } from '../../../../src/core/runtime/scheduler';
import { createInitialRuntimeState, type RuntimeState } from '../../../../src/core/runtime/state';
import { createRuntimeStore } from '../../../../src/core/runtime/store';
import {
  evaluateSkillActivation,
  skillFrameInvalidationReason,
} from '../../../../src/core/skills/activation';
import {
  createSkillCapabilityResolver,
  refreshSkillCatalog,
  type SkillCatalogSnapshot,
} from '../../../../src/core/skills/catalog';
import {
  activateSkillLifecycle,
  completeSkillLifecycle,
} from '../../../../src/core/skills/lifecycle';
import type { SkillScanOptions } from '../../../../src/core/skills/types';
import { compileSkillWorkflow } from '../../../../src/core/skills/workflow';
import type { CapabilityDescriptor } from '../../../../src/protocol/capabilities';
import {
  evaluateL1SkillMcpCorpusV1,
  type L1SkillMcpCaseObservationV1,
  type L1SkillMcpReportV1,
  l1SkillMcpObservationForCaseV1,
} from './l1-skill-mcp-evaluator-v1';
import {
  buildL1SkillMcpEvaluatorIdentityV1,
  L1_SKILL_MCP_ADAPTERS_V1,
  L1_SKILL_MCP_FIXTURE_ID_V1,
  L1_SKILL_MCP_RUNNER_ID_V1,
  type L1SkillMcpAdapterIdV1,
  type L1SkillMcpAdapterResultV1,
  type L1SkillMcpEvaluatorIdentityV1,
} from './l1-skill-mcp-schema-v1';

export {
  L1_SKILL_MCP_ADAPTER_IMPLEMENTATIONS_V1,
  L1_SKILL_MCP_FIXTURE_ID_V1,
  L1_SKILL_MCP_RUNNER_ID_V1,
} from './l1-skill-mcp-schema-v1';

/**
 * All L1 Skill/MCP inputs live under a newly allocated temporary root. The
 * adapter does not consult the caller cwd, project config, session overlay,
 * HOME, environment credentials, network, stdio, or child processes.
 */
const L1_SKILL_MCP_SYNTHETIC_ROOT_PREFIX_V1 = 'kite-l1-skill-mcp-';
const FIXTURE_TASK_ID_V1 = 'qualification-skill-task';
const FIXTURE_MCP_CAPABILITY_ID_V1 = 'mcp:qualification/inspect';
const FIXTURE_MCP_TOOL_NAME_V1 = 'mcp__qualification__inspect';

const skillManifestV1 = `name: qualification-skill
version: 1.0.0
description: Sealed qualification workflow.
invocation:
  allow_implicit: true
  allow_manual: true
context:
  mode: inline
  agent: code
input_schema:
  type: object
  properties:
    target:
      type: string
  required: [target]
output_schema:
  type: object
  properties:
    ok:
      type: boolean
  required: [ok]
capabilities:
  require: [mcp:qualification/inspect]
  deny: []
effects:
  filesystem: none
  network: read
  external_state: none
approval:
  minimum: none
execution:
  timeout_ms: 1000
  max_attempts: 1
verification:
  mode: not_required
recovery:
  retry: never
  compensation: scripts/compensate.txt`;

function qualificationTaskConfigV1(
  input: { mcpProviderAction?: boolean; skillWorkflow?: boolean } = {},
): AgentConfig {
  return {
    apiKey: '',
    baseURL: '',
    modelName: 'qualification-scripted',
    providerName: 'qualification-scripted',
    providerType: 'openai-compatible',
    sandbox: { enabled: true },
    features: {
      capabilityCatalogV1: true,
      mcpRuntimeBindingV1: true,
      ...(input.mcpProviderAction ? { mcpProviderActionV1: true } : {}),
      ...(input.skillWorkflow ? { skillWorkflowV1: true, skillActivationV2: true } : {}),
    },
  };
}

function writeFixtureSkillV1(parent: string): string {
  const skillDir = join(parent, 'qualification-skill');
  mkdirSync(join(skillDir, 'scripts'), { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\n${skillManifestV1}\n---\n\nSealed fixture.\n`);
  writeFileSync(join(skillDir, 'scripts', 'compensate.txt'), 'fixture');
  return skillDir;
}

function createFixtureScanOptionsV1(root: string): SkillScanOptions {
  const options: SkillScanOptions = {
    projectKiteCodeSkillsDir: join(root, 'project-kite-skills'),
    projectAgentsSkillsDir: join(root, 'project-agents-skills'),
    userKiteCodeSkillsDir: join(root, 'user-kite-skills'),
    userAgentsSkillsDir: join(root, 'user-agents-skills'),
  };
  for (const directory of Object.values(options)) mkdirSync(directory, { recursive: true });
  return options;
}

function createFixtureMcpDescriptorV1(revision: string): CapabilityDescriptor {
  return {
    capabilityId: FIXTURE_MCP_CAPABILITY_ID_V1,
    revision,
    kind: 'mcp_tool',
    displayName: 'inspect',
    description: 'Qualification in-memory capability.',
    provider: { type: 'mcp', id: 'qualification', provenance: 'project' },
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    declaredEffects: { filesystem: 'none', network: 'read', externalState: 'none' },
    effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'none' },
    policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
    execution: { retry: 'never' },
    availability: 'available',
    diagnostics: [],
  };
}

interface FixtureMcpProviderV1 {
  provider: McpRuntimeProvider;
  getCallCount(): number;
}

/** A deterministic in-memory provider; its call counter is the no-dispatch oracle. */
function createFixtureMcpProviderV1(revision: string): FixtureMcpProviderV1 {
  const descriptor = createFixtureMcpDescriptorV1(revision);
  let callCount = 0;
  const provider: McpRuntimeProvider = {
    getCapabilitySnapshot: () => ({
      revision: `qualification-catalog-${revision}`,
      descriptors: [descriptor],
    }),
    getProviderDirectorySnapshot: () => ({
      revision: `qualification-directory-${revision}`,
      entries: [
        {
          providerId: 'qualification',
          status: 'ready',
          required: false,
          source: 'explicit',
          lastKnownCapabilityNames: ['inspect'],
          retryable: false,
        },
      ],
    }),
    getResourceDirectorySnapshot: () => ({ revision: 'qualification-resources-v1', resources: [] }),
    findCapability: (capabilityId) =>
      capabilityId === FIXTURE_MCP_CAPABILITY_ID_V1 ? descriptor : undefined,
    callCapability: async () => {
      callCount += 1;
      return { content: [] };
    },
    readResource: async () => '',
  };
  return { provider, getCallCount: () => callCount };
}

/** This provider is intentionally unavailable before any capability dispatch. */
function createLoginRequiredProviderV1(): FixtureMcpProviderV1 {
  let callCount = 0;
  const provider: McpRuntimeProvider = {
    getCapabilitySnapshot: () => ({ revision: 'qualification-auth-catalog-v1', descriptors: [] }),
    getProviderDirectorySnapshot: () => ({
      revision: 'qualification-auth-directory-v1',
      entries: [
        {
          providerId: 'qualification',
          status: 'login_required',
          required: false,
          source: 'explicit',
          lastKnownCapabilityNames: ['inspect'],
          diagnosticCode: 'auth_required',
          retryable: false,
        },
      ],
    }),
    getResourceDirectorySnapshot: () => ({
      revision: 'qualification-auth-resources-v1',
      resources: [],
    }),
    findCapability: () => undefined,
    callCapability: async () => {
      callCount += 1;
      return { content: [] };
    },
    readResource: async () => '',
  };
  return { provider, getCallCount: () => callCount };
}

function activeFixtureStateV1(root: string): RuntimeState {
  const state = createInitialRuntimeState({
    threadId: 'qualification-skill-thread',
    userId: 'qualification',
    workspace: root,
  });
  state.activeTaskId = FIXTURE_TASK_ID_V1;
  state.tasks[FIXTURE_TASK_ID_V1] = {
    taskId: FIXTURE_TASK_ID_V1,
    userGoal: 'Run sealed qualification fixture.',
    status: 'active',
    startedAtTurnId: state.turn.turnId,
    sideEffectsStarted: false,
    planning: { kind: 'building_without_plan' },
    planHistory: [],
  };
  return state;
}

function skillFlagsV1() {
  return getFeatureFlags({ features: { skillWorkflowV1: true, skillActivationV2: true } });
}

async function withSyntheticSkillRootV1<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), L1_SKILL_MCP_SYNTHETIC_ROOT_PREFIX_V1));
  try {
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function currentEntryV1(catalog: SkillCatalogSnapshot) {
  return catalog.entries.find(
    (entry) => !entry.shadowedBy && entry.descriptor.capabilityId === 'skill:qualification-skill',
  );
}

/** Journey 3: source scan, shadow handling, activation, and schema-valid completion. */
async function runSkillDiscoveryActivationOutputV1(): Promise<boolean> {
  return withSyntheticSkillRootV1(async (root) => {
    const options = createFixtureScanOptionsV1(root);
    const projectSkill = writeFixtureSkillV1(options.projectKiteCodeSkillsDir);
    writeFixtureSkillV1(options.userAgentsSkillsDir);
    const mcp = createFixtureMcpProviderV1('qualification-dependency-r1');
    const resolver = createSkillCapabilityResolver(mcp.provider);
    const compiled = compileSkillWorkflow({
      skillDir: projectSkill,
      source: 'project',
      origin: '.kite-code',
      resolveCapability: resolver,
    });
    const catalog = refreshSkillCatalog(options, { resolveCapability: resolver });
    const entry = currentEntryV1(catalog);
    if (!entry?.contract || compiled.descriptor.availability !== 'available') return false;

    const state = activeFixtureStateV1(root);
    const directActivation = evaluateSkillActivation({
      state,
      catalog,
      flags: skillFlagsV1(),
      request: {
        skillId: entry.descriptor.capabilityId,
        input: { target: 'fixture' },
        requestedBy: 'user',
        implicit: false,
      },
    });
    if (!directActivation.ok) return false;

    const lifecycle = await activateSkillLifecycle(
      {
        state,
        catalog,
        flags: skillFlagsV1(),
        verificationEnabled: false,
      },
      { skill_id: entry.descriptor.capabilityId, input: { target: 'fixture' } },
    );
    if (!lifecycle.ok || !lifecycle.runtimeEvents) return false;
    const activated = lifecycle.runtimeEvents.reduce(reduceRuntimeState, state);
    const activationId = lifecycle.runtimeEvents.find(
      (event): event is Extract<typeof event, { type: 'skill.activation_started' }> =>
        event.type === 'skill.activation_started',
    )?.activation.activationId;
    if (!activationId) return false;

    const invalidOutput = completeSkillLifecycle(
      { state: activated, catalog, verificationEnabled: false },
      { activation_id: activationId, output: {} },
    );
    const completed = completeSkillLifecycle(
      { state: activated, catalog, verificationEnabled: false },
      { activation_id: activationId, output: { ok: true } },
    );
    return (
      compiled.contract?.effectiveCapabilityCeiling[0] === FIXTURE_MCP_CAPABILITY_ID_V1 &&
      entry.contract.dependencyRevisions[FIXTURE_MCP_CAPABILITY_ID_V1] ===
        'qualification-dependency-r1' &&
      catalog.entries.some((candidate) => Boolean(candidate.shadowedBy)) &&
      directActivation.activation.capabilityCeiling[0] === FIXTURE_MCP_CAPABILITY_ID_V1 &&
      invalidOutput.ok === false &&
      completed.ok === true &&
      completed.runtimeEvents?.some((event) => event.type === 'skill.frame_closed') === true &&
      mcp.getCallCount() === 0
    );
  });
}

/** Journey 4: dependency revision drift invalidates the old frame and blocks its old binding. */
async function runSkillMcpDependencyRevisionDriftV1(): Promise<boolean> {
  return withSyntheticSkillRootV1(async (root) => {
    const options = createFixtureScanOptionsV1(root);
    const projectSkill = writeFixtureSkillV1(options.projectKiteCodeSkillsDir);
    const before = createFixtureMcpProviderV1('qualification-dependency-r1');
    const beforeResolver = createSkillCapabilityResolver(before.provider);
    const firstCompilation = compileSkillWorkflow({
      skillDir: projectSkill,
      source: 'project',
      origin: '.kite-code',
      resolveCapability: beforeResolver,
    });
    const firstCatalog = refreshSkillCatalog(options, { resolveCapability: beforeResolver });
    const firstEntry = currentEntryV1(firstCatalog);
    if (!firstEntry || !firstCompilation.contract) return false;

    let state = activeFixtureStateV1(root);
    const activation = evaluateSkillActivation({
      state,
      catalog: firstCatalog,
      flags: skillFlagsV1(),
      request: {
        skillId: firstEntry.descriptor.capabilityId,
        input: { target: 'fixture' },
        requestedBy: 'user',
        implicit: false,
      },
    });
    if (!activation.ok) return false;
    state = activation.events.reduce(reduceRuntimeState, state);

    const after = createFixtureMcpProviderV1('qualification-dependency-r2');
    const afterCatalog = refreshSkillCatalog(options, {
      resolveCapability: createSkillCapabilityResolver(after.provider),
    });
    const invalidationReason = skillFrameInvalidationReason(activation.activation, afterCatalog);
    const afterEntry = currentEntryV1(afterCatalog);
    if (!invalidationReason || !afterEntry) return false;
    state = reduceRuntimeState(state, {
      type: 'skill.frame_closed',
      activationId: activation.activation.activationId,
      status: 'invalidated',
      reason: invalidationReason,
      closedAt: '2026-08-05T00:00:00.000Z',
    });

    const bindingId = 'qualification-stale-skill-binding';
    const toolCallId = 'qualification-stale-skill-call';
    state.capabilities.bindings[bindingId] = {
      bindingId,
      capabilityId: FIXTURE_MCP_CAPABILITY_ID_V1,
      capabilityRevision: 'qualification-dependency-r1',
      exposedToolName: FIXTURE_MCP_TOOL_NAME_V1,
      schemaDigest: 'qualification-schema-r1',
      issuedForTurnId: state.turn.turnId,
    };
    state.tools.calls[toolCallId] = {
      toolCallId,
      modelMessageId: 'qualification-model',
      name: FIXTURE_MCP_TOOL_NAME_V1,
      args: {},
      status: 'queued',
      bindingId,
      capabilityId: FIXTURE_MCP_CAPABILITY_ID_V1,
      capabilityRevision: 'qualification-dependency-r1',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push(toolCallId);
    const events = await executeRuntimeTools({
      state,
      toolCallIds: [toolCallId],
      mcpManager: after.provider,
      taskConfig: qualificationTaskConfigV1(),
    });
    const failed = events.find(
      (event): event is Extract<(typeof events)[number], { type: 'tool.failed' }> =>
        event.type === 'tool.failed',
    );
    return (
      firstCompilation.contract.dependencyRevisions[FIXTURE_MCP_CAPABILITY_ID_V1] ===
        'qualification-dependency-r1' &&
      afterEntry.contract?.dependencyRevisions[FIXTURE_MCP_CAPABILITY_ID_V1] ===
        'qualification-dependency-r2' &&
      firstEntry.descriptor.revision !== afterEntry.descriptor.revision &&
      state.skills.frames[activation.activation.activationId]?.status === 'invalidated' &&
      failed?.failure?.kind === 'provider_capability_changed' &&
      after.getCallCount() === 0 &&
      before.getCallCount() === 0
    );
  });
}

function pendingProjectCatalogV1(root: string, revision: string): McpConfigCatalog {
  const entry: McpServerConfigEntry = {
    name: 'qualification',
    source: { kind: 'project', path: join(root, 'project-config'), workspace: root },
    rawConfig: { type: 'stdio', command: 'qualification-fixture' },
    normalizedConfig: {
      type: 'stdio',
      command: 'qualification-fixture',
      providerVersion: revision,
    },
    configDigest: revision,
    revision,
    providerConfigDigest: revision,
    enabled: true,
    approvalStatus: 'pending_approval',
    diagnostics: [],
    effective: true,
  };
  return {
    entries: [entry],
    effective: new Map([[entry.name, entry]]),
    // An unapproved project declaration must never enter the connectable set.
    connectableServers: {},
    projectApprovals: [],
    diagnostics: [],
    workspace: root,
    sourceRevisions: { project: revision, user: revision, local: revision },
  };
}

function createInMemoryMcpControlPlaneV1(): {
  control: McpConnectionManagerControlPlane;
  getCallCount(): number;
} {
  let callCount = 0;
  const emptySnapshot = createSnapshot([]);
  const control: McpConnectionManagerControlPlane = {
    subscribe: () => () => {},
    reconnect: async () => {
      throw new Error('qualification_mcp_connect_must_not_run');
    },
    disconnect: async () => {},
    disconnectAll: async () => {},
    getServerStates: () => new Map(),
    getCapabilitySnapshot: () => emptySnapshot,
    getProviderDirectorySnapshot: () => ({
      revision: 'qualification-empty-directory-v1',
      entries: [],
    }),
    getResourceDirectorySnapshot: () => ({
      revision: 'qualification-empty-resources-v1',
      resources: [],
    }),
    findCapability: () => undefined,
    callCapability: async () => {
      callCount += 1;
      return { content: [] };
    },
    readResource: async () => '',
  };
  return { control, getCallCount: () => callCount };
}

/** No credential store, OAuth callback, browser, or environment is constructed in this fake. */
function createInMemoryAuthCoordinatorV1(): {
  coordinator: McpAuthCoordinator;
  getLoginCount(): number;
} {
  let loginCount = 0;
  const snapshot = {
    status: 'not_required' as const,
    credentialPresent: false,
    storeStatus: 'available' as const,
  };
  const coordinator: McpAuthCoordinator = {
    register: () => {},
    unregister: () => {},
    login: async () => {
      loginCount += 1;
      return { status: 'authenticated' };
    },
    resume: async () => 'not_configured',
    completeCallback: async () => ({ status: 'cancelled' }),
    cancel: async () => ({ status: 'cancelled' }),
    logout: async () => ({ status: 'logged_out' }),
    markLoginRequired: () => {},
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
  };
  return { coordinator, getLoginCount: () => loginCount };
}

/** Journey 5: an unapproved project catalog survives churn but cannot dispatch. */
async function runMcpProjectApprovalCatalogChurnV1(): Promise<boolean> {
  return withSyntheticSkillRootV1(async (root) => {
    const catalogs = [
      pendingProjectCatalogV1(root, 'qualification-project-r1'),
      pendingProjectCatalogV1(root, 'qualification-project-r2'),
    ];
    let loadIndex = 0;
    const repository: McpConfigRepository = {
      load: async () => catalogs[Math.min(loadIndex++, catalogs.length - 1)]!,
      mutate: async () => catalogs[catalogs.length - 1]!,
      watch: () => () => {},
    };
    const control = createInMemoryMcpControlPlaneV1();
    const auth = createInMemoryAuthCoordinatorV1();
    const supervisor = new DefaultMcpSupervisor({
      manager: control.control,
      repository,
      authCoordinator: auth.coordinator,
      sleep: async () => {},
      now: () => 0,
    });
    try {
      await supervisor.start(root);
      const firstRevision = supervisor.getSnapshot().revision;
      const initialDirectory = supervisor.getProviderDirectorySnapshot();
      await supervisor.reload();
      const changedRevision = supervisor.getSnapshot().revision;
      const changedDirectory = supervisor.getProviderDirectorySnapshot();
      let approvalBlocked = false;
      try {
        await supervisor.callCapability({
          capabilityId: FIXTURE_MCP_CAPABILITY_ID_V1,
          expectedRevision: 'qualification-project-r2',
          arguments: {},
        });
      } catch (error) {
        approvalBlocked =
          error instanceof McpProviderError &&
          error.kind === 'provider_approval_required' &&
          error.recoveryAction === 'approve';
      }
      return (
        firstRevision !== changedRevision &&
        initialDirectory.entries[0]?.status === 'pending_approval' &&
        changedDirectory.entries[0]?.status === 'pending_approval' &&
        approvalBlocked &&
        control.getCallCount() === 0
      );
    } finally {
      await supervisor.stop();
    }
  });
}

/** Unknown external writes preserve durable facts and require reconciliation, never blind replay. */
async function runMcpUnknownWriteReconciliationV1(): Promise<boolean> {
  return withSyntheticSkillRootV1(async (root) => {
    const recovery = classifyMcpWriteRecoveryV1({
      intent: {
        invocationId: 'qualification-unknown-invocation',
        routeDigest: 'qualification-route-digest',
        argumentsDigest: 'qualification-arguments-digest',
        persistedBeforeDispatch: true,
      },
      receipt: {
        invocationId: 'qualification-unknown-invocation',
        status: 'unknown',
        reconciliation: 'not_observed',
        compensation: 'not_observed',
      },
      retryPolicy: 'never',
      providerActionRecovered: true,
    });
    let state = activeFixtureStateV1(root);
    state.capabilities.invocations['qualification-unknown-invocation'] = {
      invocationId: 'qualification-unknown-invocation',
      toolCallId: 'qualification-unknown-call',
      capabilityId: FIXTURE_MCP_CAPABILITY_ID_V1,
      capabilityRevision: 'qualification-write-r1',
      argumentsDigest: 'qualification-arguments-digest',
      authorizationDigest: 'qualification-authorization-digest',
      effectiveEffectsDigest: 'qualification-effects-digest',
      status: 'unknown',
      recordedAt: '2026-08-05T00:00:00.000Z',
      finishedAt: '2026-08-05T00:00:01.000Z',
    };
    const blocked = decideNextEffect(state);
    const reconciliation = eventsForRuntimeAction(state, {
      type: 'reconcile_invocation',
      invocationId: 'qualification-unknown-invocation',
      decision: 'confirmed_failure',
    });
    if (reconciliation.length !== 1) return false;
    state = reconciliation.reduce(reduceRuntimeState, state);
    return (
      recovery.action === 'reconcile' &&
      recovery.reason === 'control_plane_recovered_effect_unknown' &&
      blocked.type === 'recovery_blocked' &&
      state.capabilities.invocations['qualification-unknown-invocation']?.status === 'failed' &&
      decideNextEffect(state).type === 'call_model'
    );
  });
}

/** The Tool Controller converts an auth-invalid MCP call into a provider action without dispatch. */
async function runMcpAuthInvalidProviderActionV1(): Promise<boolean> {
  return withSyntheticSkillRootV1(async (root) => {
    const mcp = createLoginRequiredProviderV1();
    const state = activeFixtureStateV1(root);
    const bindingId = 'qualification-auth-binding';
    const toolCallId = 'qualification-auth-call';
    state.capabilities.bindings[bindingId] = {
      bindingId,
      capabilityId: FIXTURE_MCP_CAPABILITY_ID_V1,
      capabilityRevision: 'qualification-auth-r1',
      exposedToolName: FIXTURE_MCP_TOOL_NAME_V1,
      schemaDigest: 'qualification-auth-schema-r1',
      issuedForTurnId: state.turn.turnId,
    };
    state.tools.calls[toolCallId] = {
      toolCallId,
      modelMessageId: 'qualification-model',
      name: FIXTURE_MCP_TOOL_NAME_V1,
      args: {},
      status: 'queued',
      bindingId,
      capabilityId: FIXTURE_MCP_CAPABILITY_ID_V1,
      capabilityRevision: 'qualification-auth-r1',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push(toolCallId);
    const events = await executeRuntimeTools({
      state,
      toolCallIds: [toolCallId],
      mcpManager: mcp.provider,
      taskConfig: qualificationTaskConfigV1({ mcpProviderAction: true }),
    });
    const failure = events.find(
      (event): event is Extract<(typeof events)[number], { type: 'tool.failed' }> =>
        event.type === 'tool.failed',
    );
    const providerAction = events.find(
      (event): event is Extract<(typeof events)[number], { type: 'provider.action_required' }> =>
        event.type === 'provider.action_required',
    );
    return (
      events.length === 2 &&
      failure?.failure?.kind === 'provider_auth_required' &&
      providerAction?.providerId === 'qualification' &&
      providerAction.action === 'login' &&
      providerAction.originatingToolCallId === toolCallId &&
      !('args' in (providerAction ?? {})) &&
      mcp.getCallCount() === 0
    );
  });
}

/** Journey 6: a completed provider action starts a fresh turn and never requeues the old call. */
async function runRuntimeProviderActionNewTurnV1(): Promise<boolean> {
  return withSyntheticSkillRootV1(async (root) => {
    const initial = activeFixtureStateV1(root);
    const previousTurnId = initial.turn.turnId;
    const auth = createInMemoryAuthCoordinatorV1();
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: initial,
      interactionMode: 'accept_edits',
    });
    try {
      kernel.processEventBatch([
        {
          type: 'tool.queued',
          toolCallId: 'qualification-provider-call',
          name: FIXTURE_MCP_TOOL_NAME_V1,
          args: {},
        },
        {
          type: 'tool.failed',
          toolCallId: 'qualification-provider-call',
          failure: {
            kind: 'provider_auth_required',
            message: 'Provider action required.',
            retryable: false,
            modelFixable: false,
            needsUserIntervention: true,
            terminatesTurn: false,
            journal: true,
          },
        },
        {
          type: 'provider.action_required',
          interactionId: 'qualification-provider-action',
          providerId: 'qualification',
          action: 'login',
          originatingToolCallId: 'qualification-provider-call',
        },
      ]);
      const events = [] as Array<import('../../../../src/core/runtime/events').RuntimeEvent>;
      for await (const event of runRuntimeLoop(kernel, async () => [], {
        requestAction: async (effect) => {
          if (effect.type !== 'request_provider_action' || effect.action !== 'login') {
            throw new Error('qualification_provider_login_action_mismatch');
          }
          const login = await auth.coordinator.login({ name: 'qualification', source: 'project' });
          if (login.status !== 'authenticated') {
            throw new Error('qualification_provider_login_not_authenticated');
          }
          return {
            type: 'provider_action_result' as const,
            interactionId: effect.interactionId,
            outcome: 'completed' as const,
            providerDirectoryRevision: 'qualification-directory-r2',
          };
        },
      })) {
        events.push(event);
      }
      const state = kernel.getState();
      return (
        events.map((event) => event.type).join(',') ===
          'provider.action_started,provider.action_completed,turn.started' &&
        events.every((event) => !('args' in event)) &&
        state.turn.turnId !== previousTurnId &&
        auth.getLoginCount() === 1 &&
        state.tools.calls['qualification-provider-call']?.status === 'failed' &&
        state.tools.queue.length === 0 &&
        state.tools.active.length === 0
      );
    } finally {
      kernel.close();
    }
  });
}

function adapterResult(
  adapterId: L1SkillMcpAdapterIdV1,
  passed: boolean,
): L1SkillMcpAdapterResultV1 {
  const pair = L1_SKILL_MCP_ADAPTERS_V1.find((entry) => entry.adapterId === adapterId);
  if (!pair) throw new Error(`unregistered_l1_skill_mcp_adapter:${adapterId}`);
  return { ...pair, outcome: passed ? 'passed' : 'failed' };
}

/** Runs every sealed L1 slice and returns only IDs plus outcome tokens. */
export async function runL1SkillMcpAdaptersV1(): Promise<readonly L1SkillMcpAdapterResultV1[]> {
  const outcomes = await Promise.all([
    runMcpAuthInvalidProviderActionV1(),
    runMcpProjectApprovalCatalogChurnV1(),
    runMcpUnknownWriteReconciliationV1(),
    runRuntimeProviderActionNewTurnV1(),
    runSkillDiscoveryActivationOutputV1(),
    runSkillMcpDependencyRevisionDriftV1(),
  ]);
  return [
    adapterResult('mcp-auth-invalid-provider-action-v1', outcomes[0]!),
    adapterResult('mcp-project-approval-catalog-churn-v1', outcomes[1]!),
    adapterResult('mcp-unknown-write-reconciliation-v1', outcomes[2]!),
    adapterResult('runtime-provider-action-new-turn-v1', outcomes[3]!),
    adapterResult('skill-discovery-activation-output-v1', outcomes[4]!),
    adapterResult('skill-mcp-dependency-revision-drift-v1', outcomes[5]!),
  ];
}

export function buildL1SkillMcpEvaluatorV1(): L1SkillMcpEvaluatorIdentityV1 {
  return buildL1SkillMcpEvaluatorIdentityV1({
    oracle: { observation: 'status-and-event-type-only-v1' },
    verifier: { inventory: 'closed-case-inventory-v1', output: 'metadata-only-v1' },
    runner: {
      runner: L1_SKILL_MCP_RUNNER_ID_V1,
      fixtureId: L1_SKILL_MCP_FIXTURE_ID_V1,
      fixtureRoot: 'new-temp-root-per-case-v1',
    },
    scheduler: { kernel: 'AgentKernel', providerAction: 'fresh-turn-v1' },
    faultInjection: {
      dependency: 'revision-drift-v1',
      provider: 'auth-invalid-v1',
      write: 'unknown-reconcile-v1',
    },
  });
}

/** Rebuild the closed corpus from fresh synthetic executions. */
export async function runL1SkillMcpContractCorpusV1(
  input: { evaluator?: L1SkillMcpEvaluatorIdentityV1 } = {},
): Promise<L1SkillMcpReportV1> {
  const results = await runL1SkillMcpAdaptersV1();
  const passed = new Map(results.map((result) => [result.adapterId, result.outcome === 'passed']));
  const observations: L1SkillMcpCaseObservationV1[] = [
    l1SkillMcpObservationForCaseV1(
      'l1-mcp-auth-invalid-provider-action-v1',
      passed.get('mcp-auth-invalid-provider-action-v1') === true,
    ),
    l1SkillMcpObservationForCaseV1(
      'l1-mcp-project-approval-catalog-churn-v1',
      passed.get('mcp-project-approval-catalog-churn-v1') === true,
    ),
    l1SkillMcpObservationForCaseV1(
      'l1-mcp-unknown-write-reconciliation-v1',
      passed.get('mcp-unknown-write-reconciliation-v1') === true,
    ),
    l1SkillMcpObservationForCaseV1(
      'l1-runtime-provider-action-new-turn-v1',
      passed.get('runtime-provider-action-new-turn-v1') === true,
    ),
    l1SkillMcpObservationForCaseV1(
      'l1-skill-discovery-activation-output-v1',
      passed.get('skill-discovery-activation-output-v1') === true,
    ),
    l1SkillMcpObservationForCaseV1(
      'l1-skill-mcp-dependency-revision-drift-v1',
      passed.get('skill-mcp-dependency-revision-drift-v1') === true,
    ),
  ];
  return evaluateL1SkillMcpCorpusV1({
    evaluator: input.evaluator ?? buildL1SkillMcpEvaluatorV1(),
    observations,
  });
}
