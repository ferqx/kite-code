import { createHash } from 'node:crypto';
import {
  type AfterTurnPolicy,
  AgentError,
  type AgentRuntime,
  createToolBehaviorRegistry,
  type RunConfiguration,
  type RuntimeOptions,
} from '@kite-ai/agent';
import type { ModelConfiguration } from '@kite-ai/agent/config';
import type { AuthorizationRequest, Extension, Json, Permissions } from '@kite-ai/agent/extensions';
import { mcpModelInputHint } from '@kite-ai/agent/mcp';
import {
  builtinCapability,
  type CapabilityDescription,
  type CapabilityIdentity,
  createBusinessPermissionPolicy,
  createDefaultAfterTurnPolicy,
  createPermissionCheckContextReader,
  createPermissionPolicy,
  intersectPermissionPolicies,
  type PermissionPolicyOptions,
  type PermissionPolicySnapshot,
  shellRiskReviewContractDigest,
} from '@kite-ai/agent/permissions';
import type { createShellConfiguration } from '@kite-ai/agent/permissions/shell';
import type { createPlanningValidation } from '@kite-ai/agent/planning';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import type { createSessionTitleExtension } from '@kite-ai/agent/session-title';
import { createShellToolBehaviors } from '@kite-ai/agent/shell';
import { createDefaultTaskRequestClassifier } from '@kite-ai/agent/task';
import type { createBrowserConfiguration } from './browser-configuration';
import type { ChildRole } from './child-configuration';
import type { createDefaultFileCheckpointConfiguration } from './file-checkpoint-configuration';
import type { createMcpConfiguration } from './mcp-configuration';
import type { createMcpManagement } from './mcp-management';
import type { createMcpSourceConfiguration } from './mcp-source-configuration';
import { isSupportedModelProvider } from './model-providers';
import { createPermissionManagement, type PermissionManagementPort } from './permission-management';
import { readBoundPlanningSuccessor, readPlanningPermissionState } from './planning-configuration';
import type { createTaskConfiguration } from './task-configuration';
import type { createWebFetchConfiguration } from './web-fetch-configuration';

type McpSources = ReturnType<typeof createMcpSourceConfiguration>;
type SelectedSources =
  | ReturnType<McpSources['select']>
  | ReturnType<McpSources['unboundSelection']>
  | Awaited<ReturnType<McpSources['deriveChildSelection']>>;
type ResolveInput = Parameters<NonNullable<RuntimeOptions['resolveRunConfiguration']>>[0];

export function defaultAutoReviewContract(
  value: Json | undefined,
  digest: Json | undefined,
): 'shell_risk' | undefined {
  if (value === null && digest === undefined) return undefined;
  if (value === undefined && digest === undefined) return undefined;
  if (value !== 'shell_risk' || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
    throw new AgentError('recovery_configuration_unavailable');
  if (digest !== shellRiskReviewContractDigest)
    throw new AgentError('recovery_configuration_changed');
  return value;
}
/** Only the original Runtime parent binding selects the child's review contract. */
export function parentAutoReviewContract(configuration: Json | undefined): 'shell_risk' | null {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration))
    return null;
  let snapshot = configuration.snapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  // A child carrier wraps the same Service snapshot in its frozen role envelope.
  if (typeof snapshot.roleId === 'string' && typeof snapshot.roleVersion === 'string') {
    snapshot = snapshot.configuration;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
      throw new AgentError('child_configuration_unavailable');
  }
  return (
    defaultAutoReviewContract(snapshot.defaultAutoReview, snapshot.defaultAutoReviewDigest) ?? null
  );
}
/** Service composition of existing Agent policies; Runtime and current controls keep their original owners. */
export function createDefaultPermissionConfiguration(options: {
  profile: ProfileSelection;
  authority: {
    permissions?: RuntimeOptions['permissions'];
    permissionPolicy?: Pick<PermissionPolicyOptions, 'readPolicy'>;
  };
  externalPermissionAuthority: boolean;
  afterTurn?: AfterTurnPolicy;
  nativeShellRead: boolean;
  childRoles: readonly ChildRole[];
  defaultTaskRoles: boolean;
  /** Only the default host reviewer selects the new builtin risk contract. */
  defaultAutoReview?: boolean;
  readRuntime(): AgentRuntime | undefined;
  bindRuntime(runtime: AgentRuntime | undefined): void;
  planning: ReturnType<typeof createPlanningValidation>;
  files: ReturnType<typeof createDefaultFileCheckpointConfiguration>;
  task: Pick<ReturnType<typeof createTaskConfiguration>, 'extension'>;
  browser: ReturnType<typeof createBrowserConfiguration>;
  mcp: ReturnType<typeof createMcpConfiguration>;
  mcpManagement: ReturnType<typeof createMcpManagement>;
  mcpSources: McpSources;
  authorizeTitle: ReturnType<typeof createSessionTitleExtension>['authorize'];
  readGlobalMcpAdmissionError(request: AuthorizationRequest): Promise<string | null | undefined>;
}) {
  const { authority, childRoles, planning, files, task, browser, mcp, mcpManagement, mcpSources } =
    options;
  const describeDefaultTask = createDefaultTaskRequestClassifier(
    options.defaultTaskRoles ? childRoles : [],
  );
  let managed: PermissionManagementPort | undefined;
  const permissionManagement = (runtime?: AgentRuntime) => {
    const policyRuntime = options.readRuntime();
    if (policyRuntime && runtime !== policyRuntime)
      throw new AgentError('permission_host_already_bound');
    options.bindRuntime(runtime);
    managed = createPermissionManagement({
      runtime,
      profile: options.profile,
      writable: !options.externalPermissionAuthority,
      allowModeChanges: true,
      nativeShellRead: options.nativeShellRead,
    });
    return managed;
  };
  async function persistedPolicy(
    request: Parameters<NonNullable<RuntimeOptions['permissions']>['authorize']>[0],
    allowed: readonly CapabilityIdentity[],
    original?: { sessionId: string; expectedStoreId: string; subjectId: string },
  ): Promise<PermissionPolicySnapshot> {
    const policyRuntime = options.readRuntime();
    if (!policyRuntime || !managed)
      return { mode: 'auto', workspaceTrust: false, revision: 'unbound-auto-untrusted-1', allowed };
    if (!original) {
      const execution = await policyRuntime.getExecution(request.executionId);
      if (!execution || execution.sessionId !== request.sessionId)
        throw new AgentError('execution_scope_unavailable');
      const command = await policyRuntime.getCommand(execution.originCommandId);
      if (!command || command.originStoreId !== execution.originStoreId)
        throw new AgentError('execution_scope_unavailable');
      original = {
        sessionId: execution.sessionId,
        expectedStoreId: execution.originStoreId,
        subjectId: command.subjectId,
      };
    }
    const selected = await policyRuntime.getSession(original.sessionId);
    if (!selected) throw new AgentError('session_not_found');
    const [mode, trust] = await Promise.all([
      managed.readMode(original),
      managed.readTrust({
        expectedStoreId: original.expectedStoreId,
        subjectId: original.subjectId,
        workspaceId: selected.workspaceId,
      }),
    ]);
    return {
      mode: mode.mode,
      workspaceTrust: trust.trusted,
      controlReads: [
        {
          kind: 'permission.mode',
          scope: `session:${mode.scopeSessionId}`,
          revision: mode.revision,
        },
        { kind: 'permission.mode', scope: 'user', revision: mode.defaultRevision },
        {
          kind: 'workspace.trust',
          scope: `workspace:${selected.workspaceId}`,
          revision: trust.revision,
        },
      ],
      revision: createHash('sha256')
        .update(
          JSON.stringify({
            scope: mode.scopeSessionId,
            modeRevision: mode.revision,
            defaultRevision: mode.defaultRevision,
            trustRevision: trust.revision,
            canonicalIdentity: trust.canonicalIdentity,
            externalReadScopeDigest: trust.externalReadScopeDigest,
            trust: trust.status,
          }),
        )
        .digest('hex'),
      allowed,
    };
  }

  // Injected policy may narrow capabilities/trust, but mode belongs to the live root.
  async function currentPolicy(
    request: Parameters<Permissions['authorize']>[0],
    allowed: readonly CapabilityIdentity[],
    original?: { sessionId: string; expectedStoreId: string; subjectId: string },
  ): Promise<PermissionPolicySnapshot> {
    const current = await persistedPolicy(request, allowed, original);
    if (!authority.permissionPolicy || authority.permissions) return current;
    const injected = await authority.permissionPolicy.readPolicy(request);
    return {
      ...injected,
      mode: current.mode,
      workspaceTrust: current.workspaceTrust && injected.workspaceTrust,
      revision: createHash('sha256')
        .update(JSON.stringify([current.revision, injected.revision]))
        .digest('hex'),
      controlReads: current.controlReads,
    };
  }

  const withInjectedCeiling = (current: Permissions): Permissions =>
    intersectPermissionPolicies(current, authority.permissions);
  const childCapability = (role: ChildRole): CapabilityDescription => ({
    kind: 'job',
    definitionId: `agent/${role.id}`,
    definitionVersion: role.version,
    revision: `trusted-child:${role.id}:${role.version}`,
    effects: ['unknown'],
    hardAllowed: true,
    safeRead: false,
  });
  const modelCapability = (modelId: string): CapabilityDescription => ({
    kind: 'model',
    definitionId: modelId,
    definitionVersion: '1',
    revision: 'compatible-model-1',
    effects: ['network'],
    hardAllowed: true,
    safeRead: false,
  });
  const globalCapabilities = new Map<string, CapabilityDescription>();
  for (const role of childRoles) {
    globalCapabilities.set(
      JSON.stringify(['job', `agent/${role.id}`, role.version]),
      childCapability(role),
    );
    // A runless parent has no Run model to inherit. The child resolver must still
    // establish this exact trusted role binding before any child Model can run.
    if (role.modelId)
      globalCapabilities.set(
        JSON.stringify(['model', role.modelId, '1']),
        modelCapability(role.modelId),
      );
  }
  for (const extension of [planning.extension, files.extension])
    for (const action of extension.actions ?? []) {
      const definitionId = `${extension.id}/${action.id}`;
      const capability = builtinCapability(
        extension.id,
        action.id,
        'action',
        planning.extension.id,
        action.version,
      );
      globalCapabilities.set(JSON.stringify(['job', definitionId, action.version]), {
        kind: 'job',
        definitionId,
        definitionVersion: action.version,
        revision: `${extension.id}:${extension.version}:${action.version}`,
        effects: capability.effects,
        hardAllowed: true,
        safeRead: capability.safeRead,
      });
    }
  for (const capability of browser.capabilities)
    if (capability.kind === 'job')
      globalCapabilities.set(
        JSON.stringify([capability.kind, capability.definitionId, capability.definitionVersion]),
        capability,
      );
  const globalDefaultPolicy = createPermissionPolicy({
    readPolicy: (request) =>
      currentPolicy(
        request,
        [
          ...globalCapabilities.values(),
          ...mcp.listCapabilities(),
          ...mcpManagement.listCapabilities(),
          ...mcpSources.listCapabilities(),
        ].map(({ kind, definitionId, definitionVersion }) => ({
          kind,
          definitionId,
          definitionVersion,
        })),
      ),
    describeCapability: async (request) => {
      const description = globalCapabilities.get(
        JSON.stringify([request.kind, request.definitionId, request.definitionVersion]),
      );
      return (
        (description && options.defaultAutoReview && request.runId === null
          ? { ...description, autoReview: 'none' as const }
          : description) ??
        mcp.describe(request) ??
        mcpSources.describe(request) ??
        mcpManagement.describe(request)
      );
    },
  });
  const globalPermissions = withInjectedCeiling(globalDefaultPolicy);
  const afterTurn =
    options.afterTurn ??
    createDefaultAfterTurnPolicy({
      roles: childRoles,
      async readCurrent(input) {
        input.signal.throwIfAborted();
        if (authority.permissions && !authority.permissionPolicy)
          return { workspaceTrust: false, revision: 'after-turn-current-policy-unavailable-1' };
        const request = {
          kind: 'tool' as const,
          sessionId: input.session.id,
          runId: input.run.id,
          executionId: input.execution.id,
          definitionId: input.execution.definitionId,
          definitionVersion: input.execution.definitionVersion,
          input: input.execution.input,
          signal: input.signal,
        };
        const current = await currentPolicy(request, [], {
          sessionId: input.session.id,
          expectedStoreId: input.run.originStoreId,
          subjectId: input.command.subjectId,
        });
        input.signal.throwIfAborted();
        return {
          workspaceTrust: current.workspaceTrust,
          revision: createHash('sha256')
            .update(
              JSON.stringify({
                mode: current.mode,
                trust: current.workspaceTrust,
                revision: current.revision,
                allowed: current.allowed,
                controlReads: current.controlReads ?? null,
              }),
            )
            .digest('hex'),
          controlReads: current.controlReads,
        };
      },
    });
  function forRun(input: {
    command: ResolveInput['command'];
    modelId: string;
    models?: readonly ModelConfiguration[];
    extensions: readonly Extension[];
    toolIds: readonly string[];
    shell: Awaited<ReturnType<typeof createShellConfiguration>>;
    web: ReturnType<typeof createWebFetchConfiguration>;
    selectedMcp: ReturnType<ReturnType<typeof createMcpConfiguration>['select']>;
    selectedSources: SelectedSources;
    requirePlan: boolean;
    readOnlyDefinitions: readonly (CapabilityIdentity & { kind: 'tool' })[];
    recoveryRunIdentity?: { runId: string; sessionId: string };
    /** Frozen per-Run default; absence preserves legacy/custom review semantics. */
    defaultAutoReview?: 'shell_risk';
    /** Actual host-owned objects, never extension names or model-provided metadata. */
    trustedExtensions?: readonly Extension[];
    /** Narrow action guard for the mixed read/write Git Worktree tool. */
    readOnlyTask?: boolean;
  }): Pick<RunConfiguration, 'permissions' | 'initializeRequirements' | 'toolBehaviors'> {
    const {
      command,
      modelId,
      models,
      extensions: runExtensions,
      toolIds,
      shell,
      web,
      selectedMcp,
      selectedSources,
      requirePlan,
      readOnlyDefinitions,
      recoveryRunIdentity,
      defaultAutoReview,
      trustedExtensions,
    } = input;
    const toolBehaviorRegistry = createToolBehaviorRegistry({
      extensions: runExtensions,
      behaviors: [
        ...createShellToolBehaviors({ ...shell, enableReview: defaultAutoReview !== undefined }),
        ...files.toolBehaviors.filter(
          (behavior) =>
            behavior.capability.kind === 'tool' &&
            toolIds.includes('files.write') &&
            toolIds.includes('files.edit'),
        ),
      ].filter(
        (behavior) =>
          behavior.capability.kind !== 'tool' || toolIds.includes(behavior.capability.definitionId),
      ),
    });
    type DescriptionView = 'ordinary' | 'planning';
    type RefineCapability = (
      request: AuthorizationRequest,
      view: DescriptionView,
      policy?: Readonly<PermissionPolicySnapshot>,
    ) =>
      | Partial<CapabilityDescription>
      | null
      | undefined
      | Promise<Partial<CapabilityDescription> | null | undefined>;
    const actual = new Map<
      string,
      { description: CapabilityDescription; refine?: RefineCapability }
    >();
    const key = (kind: string, id: string, version: string) => JSON.stringify([kind, id, version]);
    const register = (description: CapabilityDescription, refine?: RefineCapability) =>
      actual.set(key(description.kind, description.definitionId, description.definitionVersion), {
        description,
        refine,
      });
    const refineShell: RefineCapability = async (request, _view, policy) => {
      const commandDigest = await shell.commandDigest(request);
      return {
        ...(await shell.describeRequest(request, policy)),
        ...(commandDigest ? { commandDigest } : {}),
      };
    };
    const refineTask: RefineCapability = (request, view) =>
      view === 'ordinary' ? describeDefaultTask(request) : undefined;
    const describeRegistered = async (
      request: AuthorizationRequest,
      view: DescriptionView,
      policy?: Readonly<PermissionPolicySnapshot>,
    ): Promise<CapabilityDescription | null> => {
      const entry = actual.get(key(request.kind, request.definitionId, request.definitionVersion));
      if (request.kind === 'model') return entry?.description ?? null;
      if (!entry) return mcpSources.describe(request) ?? selectedMcp.describe(request);
      const refinement = await entry.refine?.(request, view, policy);
      const { kind, definitionId, definitionVersion, ...facts } = refinement ?? {};
      if (
        (kind !== undefined && kind !== entry.description.kind) ||
        (definitionId !== undefined && definitionId !== entry.description.definitionId) ||
        (definitionVersion !== undefined &&
          definitionVersion !== entry.description.definitionVersion)
      )
        throw new AgentError('capability_metadata_invalid');
      const description = { ...entry.description, ...facts };
      const behavior = toolBehaviorRegistry.get(request);
      // Planning's metadata-only read has no candidate consumer. Real policy reads
      // retain candidates even when that policy already allows the operation.
      const grantOffers =
        policy !== undefined &&
        behavior?.grantOffers &&
        description.hardAllowed &&
        !description.safeRead &&
        !(behavior.autoReview === 'none' && policy?.mode === 'auto')
          ? await behavior.grantOffers(request)
          : undefined;
      return {
        ...description,
        ...(behavior
          ? {
              grantBehavior: {
                contractRef: behavior.contractRef,
                configurationDigest: behavior.configurationDigest,
              },
            }
          : {}),
        ...(behavior?.prepareReview
          ? {
              reviewBehavior: {
                capability: { ...behavior.capability },
                contractRef: behavior.contractRef,
                configurationDigest: behavior.configurationDigest,
              },
            }
          : {}),
        ...(behavior?.grantSatisfiesDefaultCheck
          ? { grantSatisfiesDefaultCheck: true as const }
          : {}),
        ...(grantOffers?.length ? { grantOffers } : {}),
      };
    };
    const modelDescription = modelCapability(modelId);
    register(modelDescription);
    // Only the exact trusted carrier and its valid Model binding join this Run's policy.
    for (const role of childRoles) {
      register(
        {
          ...childCapability(role),
          ...(defaultAutoReview ? { autoReview: 'none' as const } : {}),
        },
        refineTask,
      );
      const candidate = models?.find((entry) => entry.id === role.modelId);
      if (
        candidate &&
        candidate.enabled !== false &&
        isSupportedModelProvider(candidate.provider) &&
        candidate.baseURL &&
        candidate.model
      )
        register({
          ...modelDescription,
          definitionId: candidate.id,
        });
    }
    for (const extension of runExtensions) {
      // Ownership is captured from the actual registration, never a request name.
      const shellOwned = shell.extensions.includes(extension);
      const trusted = trustedExtensions?.includes(extension) === true;
      const autoReview = (
        kind: CapabilityIdentity['kind'],
        definitionId: string,
        definitionVersion: string,
      ): Pick<CapabilityDescription, 'autoReview'> => {
        if (!defaultAutoReview || !trusted) return {};
        const behavior = toolBehaviorRegistry.get({ kind, definitionId, definitionVersion });
        if (behavior?.autoReview) return { autoReview: behavior.autoReview };
        return !shellOwned ? { autoReview: 'none' } : {};
      };
      const refine: RefineCapability | undefined = shellOwned
        ? refineShell
        : extension === files.extension
          ? (request, _view, policy) => files.describeRequest(request, policy)
          : extension === task.extension
            ? refineTask
            : undefined;
      for (const tool of extension.tools ?? []) {
        if (!toolIds.includes(tool.id)) continue;
        const hostCapability =
          extension.id === web.extension.id
            ? web.capabilities.find(
                (capability) =>
                  capability.kind === 'tool' &&
                  capability.definitionId === tool.id &&
                  capability.definitionVersion === tool.version,
              )
            : extension.id === browser.extension.id
              ? browser.capabilities.find(
                  (capability) =>
                    capability.kind === 'tool' &&
                    capability.definitionId === tool.id &&
                    capability.definitionVersion === tool.version,
                )
              : undefined;
        register(
          {
            ...(hostCapability ?? {
              kind: 'tool',
              definitionId: tool.id,
              definitionVersion: tool.version,
              revision: `${extension.id}:${extension.version}:${tool.version}`,
              hardAllowed: true,
              ...builtinCapability(
                extension.id,
                tool.id,
                'tool',
                planning.extension.id,
                tool.version,
              ),
            }),
            ...autoReview('tool', tool.id, tool.version),
          },
          refine,
        );
      }
      for (const job of extension.jobs ?? []) {
        const capability = builtinCapability(
          extension.id,
          job.id,
          'job',
          planning.extension.id,
          job.version,
        );
        const hostCapability =
          extension.id === browser.extension.id
            ? browser.capabilities.find(
                (description) =>
                  description.kind === 'job' &&
                  description.definitionId === job.id &&
                  description.definitionVersion === job.version,
              )
            : undefined;
        register(
          {
            ...(hostCapability ?? {
              kind: 'job',
              definitionId: job.id,
              definitionVersion: job.version,
              revision: `${extension.id}:${extension.version}:${job.version}`,
              effects: capability.effects,
              hardAllowed: true,
              safeRead: capability.safeRead,
            }),
            ...autoReview('job', job.id, job.version),
          },
          refine,
        );
      }
    }
    // The exact file adapter may invoke the selected Planning owner's existing Action.
    // A Run without write_plan retains no new action capability.
    if (actual.has(key('tool', 'planning.write', '1'))) {
      const action = globalCapabilities.get(key('job', 'builtin.planning/planning.write', '1'));
      if (action)
        register({ ...action, ...(defaultAutoReview ? { autoReview: 'none' as const } : {}) });
    }
    const classifiedPermissions = withInjectedCeiling(
      createPermissionPolicy({
        readCheckContext: createPermissionCheckContextReader({
          readRuntime: () => options.readRuntime() ?? null,
          subjectId: command.subjectId,
          originStoreId: command.originStoreId,
        }),
        readPolicy: (request) =>
          currentPolicy(
            request,
            [
              ...[...actual.values()].map((entry) => entry.description),
              ...selectedMcp.listCapabilities(),
              ...mcpSources.listCapabilities(),
            ].map(({ kind, definitionId, definitionVersion }) => ({
              kind,
              definitionId,
              definitionVersion,
            })),
            {
              sessionId: command.sessionId,
              expectedStoreId: command.originStoreId,
              subjectId: command.subjectId,
            },
          ),
        describeCapability: (request, policy) => describeRegistered(request, 'ordinary', policy),
      }),
    );
    let planningRun: { runId: string; sessionId: string } | undefined = recoveryRunIdentity;
    const initializeBusinessRequirements: NonNullable<
      RunConfiguration['initializeRequirements']
    > = (input) => planning.initializeRequirements(input, { requirePlan, readOnlyDefinitions });
    const planningOriginStoreId = command.originStoreId;
    const planningPermissions = createBusinessPermissionPolicy({
      current: classifiedPermissions,
      async gate(request) {
        const runtime = options.readRuntime();
        const identity = planningRun;
        if (!runtime || !identity) throw new AgentError('planning_run_scope_unavailable');
        const state = await readPlanningPermissionState(
          runtime,
          planning,
          request,
          planningOriginStoreId,
          identity,
        );
        if (requirePlan && state.status === 'disabled')
          throw new AgentError('planning_run_obligation_unavailable');
        const description = await describeRegistered(request, 'planning');
        return planning.permissionGate({
          request,
          state,
          identity,
          planFileEdit: await files.isPlanFileEdit(request),
          capability: description,
        });
      },
    });
    const permissions: RuntimeOptions['permissions'] = {
      toolDispatchOrder: planningPermissions.toolDispatchOrder,
      consumesExecutionConfirmation:
        planningPermissions.consumesExecutionConfirmation?.bind(planningPermissions),
      ...(planningPermissions.reuseRevision
        ? { reuseRevision: planningPermissions.reuseRevision.bind(planningPermissions) }
        : {}),
      async authorize(request) {
        if (input.readOnlyTask) {
          const worktree = shell.worktreeRequest(request);
          if (worktree && worktree.action !== 'list')
            return {
              allowed: false,
              revision: 'builtin.shell:git.worktree:read-only-task:1',
              reason: 'worktree_read_only_task',
            };
        }
        if (
          'assertExecutionScope' in selectedSources &&
          typeof selectedSources.assertExecutionScope === 'function'
        ) {
          try {
            await selectedSources.assertExecutionScope(request);
          } catch {
            return {
              allowed: false,
              revision: 'mcp-child-source-scope-1',
              reason: 'mcp_source_scope_invalid',
            };
          }
        }
        let admissionInput = request.input;
        try {
          admissionInput = await mcpModelInputHint(request, {
            readExecution: async (id) => {
              const runtime = options.readRuntime();
              if (!runtime) throw new AgentError('execution_scope_unavailable');
              return runtime.getExecution(id);
            },
          });
        } catch (error) {
          request.signal.throwIfAborted();
          return {
            allowed: false,
            revision: 'mcp-original-reference-1',
            reason: error instanceof AgentError ? error.code : 'tool_reference_unavailable',
          };
        }
        const error =
          selectedSources.admissionError(request, admissionInput) ??
          selectedMcp.admissionError(request, admissionInput);
        if (error) return { allowed: false, revision: 'mcp-selected-server-1', reason: error };
        return await planningPermissions.authorize(request);
      },
    };
    return {
      permissions,
      toolBehaviors: toolBehaviorRegistry.behaviors,
      initializeRequirements: async (
        input: Parameters<NonNullable<RunConfiguration['initializeRequirements']>>[0],
      ) => {
        const policyRuntime = options.readRuntime();
        if (
          ['job.report', 'job.report.continue'].includes(input.command.kind) ||
          (planningRun &&
            planningRun.runId !== input.run.id &&
            typeof (input.command.receipt as { continuationRunId?: unknown }).continuationRunId ===
              'string')
        ) {
          if (!policyRuntime || !planningRun)
            throw new AgentError('planning_run_scope_unavailable');
          await readBoundPlanningSuccessor(
            policyRuntime,
            command.originStoreId,
            planningRun,
            input.run,
            input.command,
          );
          // Store inherited the exact refs at report or same-work human activation.
          return [];
        }
        if (
          planningRun &&
          (planningRun.runId !== input.run.id || planningRun.sessionId !== input.run.sessionId)
        )
          throw new AgentError('planning_run_scope_unavailable');
        planningRun = { runId: input.run.id, sessionId: input.run.sessionId };
        return initializeBusinessRequirements(input);
      },
    };
  }

  return {
    permissionManagement,
    afterTurn,
    forRun,
    forModelOnly(modelId: string): Permissions {
      return withInjectedCeiling(
        createPermissionPolicy({
          readPolicy: (request) =>
            currentPolicy(request, [
              { kind: 'model', definitionId: modelId, definitionVersion: '1' },
            ]),
          describeCapability: (request) =>
            request.kind === 'model' &&
            request.definitionId === modelId &&
            request.definitionVersion === '1'
              ? {
                  kind: 'model',
                  definitionId: modelId,
                  definitionVersion: '1',
                  revision: 'selected-model-only-1',
                  effects: ['read'],
                  hardAllowed: true,
                  safeRead: true,
                }
              : null,
        }),
      );
    },
    permissions: {
      toolDispatchOrder: globalPermissions.toolDispatchOrder,
      consumesExecutionConfirmation:
        globalPermissions.consumesExecutionConfirmation?.bind(globalPermissions),
      async authorize(request: AuthorizationRequest) {
        const titleDecision = await options.authorizeTitle(request);
        if (titleDecision) {
          const current = await persistedPolicy(request, []);
          return withInjectedCeiling({
            async authorize() {
              return {
                ...titleDecision,
                controlReads: current.controlReads,
                revision: createHash('sha256')
                  .update(JSON.stringify([titleDecision.revision, current.revision]))
                  .digest('hex'),
              };
            },
          }).authorize(request);
        }
        if (
          request.kind === 'job' &&
          (request.definitionId.startsWith('builtin.mcp/mcp.resources.') ||
            request.definitionId.startsWith('builtin.mcp/mcp.prompts.') ||
            request.definitionId === 'builtin.mcp/mcp.catalogue.refresh' ||
            request.definitionId === 'builtin.mcp/mcp.connect' ||
            request.definitionId === 'mcp.source.connection')
        ) {
          const error = await options.readGlobalMcpAdmissionError(request);
          if (error) return { allowed: false, revision: 'mcp-selected-server-1', reason: error };
        }
        const decision = await globalPermissions.authorize(request);
        return decision;
      },
    },
  };
}
