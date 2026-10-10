import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AgentError, type RunRequirementInitializer } from '@kite-ai/agent';
import { type JsonObject, readConfigurationFile } from '@kite-ai/agent/config';
import type {
  Extension,
  ExtensionRecord,
  JobEvent,
  JobHandle,
  Json,
} from '@kite-ai/agent/extensions';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import {
  type CompiledSkillWorkflow,
  compileSkillWorkflow,
  createSkillWorkflow,
  createSkillWorkflowCompensator,
  createSkillWorkflowVerifier,
  revalidateSkillWorkflow,
  skillWorkflowExtensionId,
  validateWorkflowArguments,
  type WorkflowActivationInput,
  type WorkflowCapability,
} from '@kite-ai/agent/skill-workflow';
import {
  hostFilesystemScope,
  inspectShellAssets,
  type ShellConfigurationOptions,
} from './shell-configuration';
import { createConfiguredSkillSource } from './skill-source';

export const workflowToolIds = [
  'activate_skill',
  'read_skill_reference',
  'complete_skill',
  'verify_skill',
  'repair_skill',
  'decide_skill_verification',
];
function object(value: unknown): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentError('workflow_input_invalid');
  return value as Record<string, Json>;
}
/** A dedicated profile document enables behavior; Skill text never enables its own runtime. */
export function readSkillWorkflowFlags(profile: ProfileSelection) {
  const document = readConfigurationFile({
    path: join(profile.profilePath, 'skill-workflow.jsonc'),
    windowsPathPolicy: 'private',
  });
  const disabled = { skillActivation: false, skillWorkflow: false, verification: false };
  if (!document.exists) return disabled;
  const value = document.value;
  if (Object.keys(value).sort().join(',') !== 'features,version' || value.version !== 1)
    throw new AgentError('workflow_configuration_invalid');
  const features = object(value.features);
  if (
    Object.keys(features).sort().join(',') !== 'skillActivation,skillWorkflow,verification' ||
    Object.values(features).some((value) => typeof value !== 'boolean')
  )
    throw new AgentError('workflow_configuration_invalid');
  return {
    skillActivation: features.skillActivation as boolean,
    skillWorkflow: features.skillWorkflow as boolean,
    verification: features.verification as boolean,
  };
}
/** Shared admitted source compilation; catalogue failures stay local, Run binding remains strict. */
export async function compileConfiguredWorkflows(options: {
  profile: ProfileSelection;
  source: ReturnType<typeof createConfiguredSkillSource>;
  listed: Awaited<ReturnType<ReturnType<typeof createConfiguredSkillSource>['list']>>;
  resolveCapability: (id: string) => WorkflowCapability | undefined;
  strict?: boolean;
}) {
  const entries: CompiledSkillWorkflow[] = [];
  const byConfiguredId = new Map<string, CompiledSkillWorkflow>();
  const failures = new Set<string>();
  const canonicalProfile = options.listed.entries.length
    ? await realpath(options.profile.profilePath)
    : options.profile.profilePath;
  for (const summary of options.listed.entries) {
    const id = options.source.configuredId(summary);
    try {
      await options.source.load({ id: summary.id, version: summary.version });
      const entry = compileSkillWorkflow({
        skillDir: dirname(summary.location),
        source: summary.location.startsWith(`${canonicalProfile}/skills/`) ? 'user' : 'project',
        origin: '.agents',
        resolveCapability: options.resolveCapability,
      });
      await options.source.load({ id: summary.id, version: summary.version });
      entries.push(entry);
      byConfiguredId.set(id, entry);
    } catch (error) {
      if (options.strict) throw error;
      failures.add(id);
    }
  }
  return { entries, byConfiguredId, failures };
}

export type WorkflowUserDecisions = NonNullable<
  Parameters<typeof createSkillWorkflow>[0]['userDecisions']
>;
export async function createWorkflowConfiguration(options: {
  profile: ProfileSelection;
  workspaceRoot: string;
  skills: readonly JsonObject[];
  toolIds: readonly string[];
  allowedCapabilities?: readonly string[];
  flags: ReturnType<typeof readSkillWorkflowFlags>;
  shell?: ShellConfigurationOptions;
  userDecisions?: WorkflowUserDecisions;
  request: Json;
  capabilities: readonly {
    capability: WorkflowCapability;
    kind: 'tool' | 'job';
    definitionId: string;
    definitionVersion: string;
  }[];
  forkConfigurations: readonly {
    agent: string;
    configurationId: string;
    definitionVersion: string;
  }[];
}) {
  const request = object(options.request);
  const inputs = request.extensionInputs;
  if (
    inputs !== undefined &&
    (!Array.isArray(inputs) ||
      inputs.some((value) => {
        const item = object(value);
        return item.extensionId !== skillWorkflowExtensionId || item.definitionVersion !== '1';
      }))
  )
    throw new AgentError('workflow_extension_input_unavailable');
  const enabled = options.flags.skillActivation && options.flags.skillWorkflow;
  if (!enabled && Array.isArray(inputs) && inputs.length) throw new AgentError('workflow_disabled');
  const facts = new Map(
    options.capabilities.map((binding) => [binding.capability.capabilityId, binding.capability]),
  );
  const resolveCapability = (id: string) => facts.get(id);
  const source = createConfiguredSkillSource(options);
  const listed = enabled ? await source.list() : { entries: [], states: [] };
  const { entries } = await compileConfiguredWorkflows({
    profile: options.profile,
    source,
    listed,
    resolveCapability,
    strict: true,
  });
  const initialActivations: WorkflowActivationInput[] = [];
  if (Array.isArray(inputs)) {
    if (inputs.length > 1) throw new AgentError('workflow_duplicate_input');
    for (const envelope of inputs) {
      const payload = object(object(envelope).input);
      if (Object.keys(payload).join(',') !== 'activations' || !Array.isArray(payload.activations))
        throw new AgentError('workflow_input_invalid');
      const keys = new Set<string>();
      for (const value of payload.activations) {
        const item = object(value);
        if (
          Object.keys(item).sort().join(',') !== 'input,key,skillId' ||
          typeof item.key !== 'string' ||
          !/^[A-Za-z0-9_.-]{1,128}$/.test(item.key) ||
          keys.has(item.key)
        )
          throw new AgentError('workflow_input_invalid');
        keys.add(item.key);
        const entry = entries.find((entry) => entry.descriptor.capabilityId === item.skillId);
        if (!entry?.contract || entry.descriptor.availability !== 'available')
          throw new AgentError('workflow_skill_unavailable');
        if (!entry.contract.invocation.allowManual)
          throw new AgentError('workflow_invocation_denied');
        if (validateWorkflowArguments(entry.contract.inputSchema, item.input))
          throw new AgentError('workflow_input_schema_invalid');
        initialActivations.push({
          key: item.key,
          skillId: entry.descriptor.capabilityId,
          input: structuredClone(item.input!),
        });
        if (
          options.flags.verification &&
          entry.contract.verification.strategy === 'script' &&
          !options.shell
        )
          throw new AgentError('workflow_verifier_unavailable');
      }
    }
  }
  const shellBinding = options.shell ? structuredClone(options.shell) : undefined;
  const scriptEntries = options.flags.verification
    ? entries.filter(
        (entry) =>
          entry.contract?.verification.strategy === 'script' &&
          entry.descriptor.availability === 'available',
      )
    : [];
  const assets =
    (scriptEntries.length ||
      (options.flags.verification &&
        options.userDecisions?.allowCompensation &&
        entries.some((entry) => entry.contract?.recovery.compensation))) &&
    shellBinding
      ? await inspectShellAssets(shellBinding)
      : null;
  const verifier =
    scriptEntries.length && assets && options.shell
      ? createSkillWorkflowVerifier({
          entries,
          resolveCapability,
          shell: {
            cwd: options.workspaceRoot,
            env: options.shell.env,
            supervisorPath: assets[0].path,
            bunExecutable: assets[1].path,
            shellExecutable: assets[2].path,
            graceMs: options.shell.graceMs,
            maxQueuedBytes: options.shell.maxQueuedBytes,
            ...(options.shell.linux && assets[3]
              ? { linux: { bubblewrapPath: assets[3].path, initExecutable: assets[0].path } }
              : {}),
          },
          ...(options.shell.platform === 'linux' && options.shell.host
            ? {
                host: {
                  ...options.shell.host,
                  filesystemScope: (context) =>
                    hostFilesystemScope(context, 'skill.workflow.verify'),
                },
              }
            : {}),
        })
      : undefined;
  const compensator =
    assets &&
    options.shell &&
    options.userDecisions?.allowCompensation &&
    options.flags.verification &&
    entries.some(
      (entry) =>
        entry.descriptor.availability === 'available' && entry.contract?.recovery.compensation,
    )
      ? createSkillWorkflowCompensator({
          entries,
          resolveCapability,
          shell: {
            cwd: options.workspaceRoot,
            env: {},
            supervisorPath: assets[0].path,
            bunExecutable: assets[1].path,
            shellExecutable: assets[2].path,
            ...(options.shell.linux && assets[3]
              ? { linux: { bubblewrapPath: assets[3].path, initExecutable: assets[0].path } }
              : {}),
            ...(options.shell.graceMs === undefined ? {} : { graceMs: options.shell.graceMs }),
            ...(options.shell.maxQueuedBytes === undefined
              ? {}
              : { maxQueuedBytes: options.shell.maxQueuedBytes }),
          },
          protectedRoots: [options.profile.dataRoot, options.profile.coordinationPath],
        })
      : undefined;
  const rejectedStarts = new WeakSet<JobHandle>();
  const supervisedExtension = (
    instance: { extension: Extension } | undefined,
    assetFailureCode: string,
  ) =>
    instance && assets && shellBinding
      ? {
          ...instance.extension,
          jobs: (instance.extension.jobs ?? []).map((job) => ({
            ...job,
            async start(
              input: Parameters<typeof job.start>[0],
              context: Parameters<typeof job.start>[1],
            ) {
              context.signal.throwIfAborted();
              let valid = false;
              try {
                valid =
                  workflowSnapshotDigest(await inspectShellAssets(shellBinding)) ===
                  workflowSnapshotDigest(assets);
              } catch {
                /* No adapter/process has been entered. */
              }
              if (!valid) {
                const handle: JobHandle = {
                  reference: {
                    kind: 'startup_rejected',
                    executionId: context.executionId,
                    code: assetFailureCode,
                  },
                };
                rejectedStarts.add(handle);
                return handle;
              }
              context.signal.throwIfAborted();
              return job.start(input, context);
            },
            async *observe(handle: JobHandle): AsyncIterable<JobEvent> {
              if (rejectedStarts.has(handle)) {
                yield {
                  type: 'terminal',
                  result: {
                    outcome: 'failed',
                    content: assetFailureCode,
                    details: { code: assetFailureCode, started: false },
                  },
                  supervision: 'ended',
                };
                return;
              }
              yield* job.observe(handle);
            },
            async cancel(handle: JobHandle) {
              return rejectedStarts.has(handle)
                ? { status: 'already_finished' as const }
                : job.cancel(handle);
            },
            async dispose(handle: JobHandle) {
              if (!rejectedStarts.has(handle)) await job.dispose(handle);
            },
          })),
        }
      : undefined;
  const verifierExtension = supervisedExtension(verifier, 'workflow_verifier_asset_changed');
  const compensatorExtension = supervisedExtension(
    compensator,
    'workflow_compensator_asset_changed',
  );
  const workflow = createSkillWorkflow({
    flags: options.flags,
    ...(options.userDecisions ? { userDecisions: structuredClone(options.userDecisions) } : {}),
    initialActivations,
    entries,
    resolveCapability,
    capabilities: options.capabilities.map(({ capability, ...binding }) => ({
      ...binding,
      capabilityId: capability.capabilityId,
    })),
    forkConfigurations: options.forkConfigurations,
    ...(verifier ? { verificationJob: verifier.verificationJob } : {}),
    ...(compensator ? { compensationJob: compensator.compensationJob } : {}),
  });
  return {
    ...workflow,
    verifierExtension,
    compensatorExtension,
    snapshot: structuredClone({
      version: 1,
      flags: options.flags,
      userDecisions: options.userDecisions ?? null,
      entries,
      capabilities: options.capabilities,
      forkConfigurations: options.forkConfigurations,
      originalActivationIntent: inputs ?? null,
      compensator: compensator
        ? {
            backend:
              options.shell?.platform === 'linux'
                ? 'linux-bubblewrap-pid-namespace'
                : 'macos-seatbelt',
            subprocesses: 'denied',
            definitionId: compensator.compensationJob.definitionId,
            definitionVersion: compensator.compensationJob.definitionVersion,
          }
        : null,
      verifier:
        assets && options.shell
          ? {
              assets,
              configurationId: options.shell.configurationId,
              envDigest: createHash('sha256')
                .update(workflowSnapshotDigest(options.shell.env))
                .digest('hex'),
              graceMs: options.shell.graceMs ?? null,
              maxQueuedBytes: options.shell.maxQueuedBytes ?? null,
            }
          : null,
    }),
    entries,
  };
}
export function composeRequirementInitializers(
  ...initializers: (RunRequirementInitializer | undefined)[]
): RunRequirementInitializer {
  return async (input) => {
    const refs = [];
    for (const initialize of initializers) if (initialize) refs.push(...(await initialize(input)));
    return refs;
  };
}

/** Authority comes from the exact parent activation Execution and sealed parent configuration. */
export async function workflowForkFence(
  parentConfiguration: Json,
  parentExecution: {
    definitionId: string | null;
    definitionVersion: string | null;
    input: Json;
    id: string;
    runId: string | null;
    sessionId: string;
    originStoreId: string;
  },
  role: { id: string; version: string; toolIds?: readonly string[] },
  scope: { runId: string; records: { get(key: string): Promise<ExtensionRecord | null> } },
) {
  if (
    !['activate_skill', 'repair_skill', 'decide_skill_verification'].includes(
      parentExecution.definitionId ?? '',
    )
  )
    return undefined;
  if (parentExecution.definitionVersion !== '1' || parentExecution.runId !== scope.runId)
    throw new AgentError('workflow_fork_unavailable');
  let snapshot = object(object(parentConfiguration).snapshot);
  if (snapshot.configuration && !snapshot.skillWorkflow) snapshot = object(snapshot.configuration);
  const workflow = object(snapshot.skillWorkflow),
    activation = object(parentExecution.input);
  const activationId =
    parentExecution.definitionId === 'activate_skill' ? activation.key : activation.activation_id;
  if (typeof activationId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(activationId))
    throw new AgentError('workflow_fork_unavailable');
  const anchorKey = `run/${scope.runId}/workflow.${createHash('sha256').update(activationId).digest('hex')}`;
  const read = async (key: string, type: string) => {
    const record = await scope.records.get(key);
    if (
      !record ||
      record.extensionId !== skillWorkflowExtensionId ||
      record.key !== key ||
      record.sessionId !== parentExecution.sessionId ||
      record.originStoreId !== parentExecution.originStoreId ||
      record.forkProvenance ||
      record.contentVersion !== 1 ||
      record.contentType !== type
    )
      throw new AgentError('workflow_fork_unavailable');
    return { record, value: object(record.value) };
  };
  const anchor = await read(anchorKey, 'application/vnd.kite.skill-activation+json');
  const head = await read(`${anchorKey}/head`, 'application/vnd.kite.skill-workflow-state+json');
  const attempt = head.value.attempt;
  if (
    head.value.kind !== 'head' ||
    head.value.waiverKey !== undefined ||
    typeof attempt !== 'number' ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    (parentExecution.definitionId === 'activate_skill' && attempt !== 1)
  )
    throw new AgentError('workflow_fork_unavailable');
  const attemptKey = `${anchorKey}/attempts/${attempt}`;
  const opening = await read(
    `${attemptKey}/opening`,
    'application/vnd.kite.skill-workflow-state+json',
  );
  const fork = await read(
    `${attemptKey}/fork-opening`,
    'application/vnd.kite.skill-workflow-state+json',
  );
  const frame = anchor.value;
  const inputDigest = createHash('sha256')
    .update(workflowSnapshotDigest(parentExecution.input))
    .digest('hex');
  if (
    frame.kind !== 'activation' ||
    frame.activationId !== activationId ||
    frame.runId !== scope.runId ||
    frame.sessionId !== parentExecution.sessionId ||
    opening.value.kind !== 'attempt' ||
    fork.value.kind !== 'fork_opening' ||
    [opening.value, fork.value].some(
      (value) =>
        value.activationId !== activationId ||
        value.attempt !== attempt ||
        value.anchorRevision !== anchor.record.revision ||
        value.skillId !== frame.skillId ||
        value.skillRevision !== frame.skillRevision ||
        value.runId !== scope.runId ||
        value.sessionId !== parentExecution.sessionId ||
        value.originStoreId !== parentExecution.originStoreId,
    ) ||
    fork.value.headRevision !== head.record.revision ||
    fork.value.carrierExecutionId !== parentExecution.id ||
    fork.value.carrierDefinitionId !== parentExecution.definitionId ||
    fork.value.carrierDefinitionVersion !== '1' ||
    fork.value.carrierInputDigest !== inputDigest ||
    fork.value.configurationId !== role.id ||
    fork.value.configurationVersion !== role.version ||
    (parentExecution.definitionId === 'activate_skill'
      ? activation.skill_id !== frame.skillId
      : activation.attempt !== attempt - 1 || opening.value.executionId !== parentExecution.id)
  )
    throw new AgentError('workflow_fork_unavailable');
  if (
    opening.value.previousAttempt !== (attempt === 1 ? null : attempt - 1) ||
    (attempt === 1
      ? opening.value.executionId !== null || opening.value.detail !== null
      : typeof opening.value.detail !== 'string' || !opening.value.detail.trim()) ||
    (opening.value.createdBy === 'repair' &&
      (parentExecution.definitionId !== 'repair_skill' ||
        typeof activation.detail !== 'string' ||
        activation.detail.trim() !== opening.value.detail))
  )
    throw new AgentError('workflow_fork_unavailable');
  let decisionFact: ExtensionRecord | null = null;
  if (opening.value.createdBy === 'replan') {
    const key = opening.value.decisionKey;
    if (
      typeof key !== 'string' ||
      key !== `${anchorKey}/attempts/${attempt - 1}/decision/${parentExecution.id}`
    )
      throw new AgentError('workflow_fork_unavailable');
    const decision = await read(key, 'application/vnd.kite.skill-workflow-state+json');
    decisionFact = decision.record;
    const request = object(decision.value.request),
      proof = object(decision.value.proof);
    const answer = object(proof.answer),
      answers = object(answer.answers);
    const verifier = await read(
      `${anchorKey}/attempts/${attempt - 1}/verification`,
      'application/vnd.kite.skill-workflow-state+json',
    );
    if (
      request.kind !== 'skill_workflow_verification' ||
      request.originStoreId !== parentExecution.originStoreId ||
      request.sessionId !== parentExecution.sessionId ||
      request.runId !== scope.runId ||
      request.activationId !== activationId ||
      request.anchorKey !== anchorKey ||
      request.anchorRevision !== anchor.record.revision ||
      request.requirementId !==
        `workflow.${createHash('sha256').update(activationId).digest('hex')}` ||
      request.requirementRevision !== anchor.record.revision ||
      request.skillId !== frame.skillId ||
      request.skillRevision !== frame.skillRevision ||
      request.attempt !== attempt - 1 ||
      request.outputDigest !== verifier.value.outputDigest ||
      verifier.value.outcome !== 'failed' ||
      workflowSnapshotDigest(request.verifier!) !== workflowSnapshotDigest(verifier.value) ||
      typeof request.headRevision !== 'string' ||
      !request.headRevision ||
      proof.originStoreId !== parentExecution.originStoreId ||
      proof.sessionId !== parentExecution.sessionId ||
      proof.runId !== scope.runId ||
      proof.executionId !== parentExecution.id ||
      typeof proof.interactionId !== 'string' ||
      !proof.interactionId ||
      typeof proof.decisionRevision !== 'string' ||
      !proof.decisionRevision ||
      !Number.isSafeInteger(proof.attempt) ||
      Number(proof.attempt) < 1 ||
      workflowSnapshotDigest(proof.request!) !== workflowSnapshotDigest(request) ||
      answer.kind !== 'question' ||
      answers.decision !== 'replan' ||
      typeof answers.detail !== 'string' ||
      answers.detail.trim() !== opening.value.detail
    )
      throw new AgentError('workflow_fork_unavailable');
    if (
      decision.value.kind !== 'user_decision' ||
      decision.value.outcome !== 'replan' ||
      typeof decision.value.detail !== 'string' ||
      !decision.value.detail.trim() ||
      decision.value.detail !== opening.value.detail ||
      parentExecution.definitionId !== 'decide_skill_verification'
    )
      throw new AgentError('workflow_fork_unavailable');
  } else if (opening.value.createdBy !== (attempt === 1 ? 'initial' : 'repair'))
    throw new AgentError('workflow_fork_unavailable');
  if (
    !Array.isArray(workflow.entries) ||
    !Array.isArray(workflow.capabilities) ||
    !Array.isArray(workflow.forkConfigurations)
  )
    throw new AgentError('workflow_fork_unavailable');
  const entry = workflow.entries
    .map(object)
    .find((entry) => object(entry.descriptor).capabilityId === frame.skillId);
  if (!entry || object(entry.descriptor).revision !== frame.skillRevision)
    throw new AgentError('workflow_fork_unavailable');
  const contract = object(entry.contract),
    context = object(contract.context);
  if (
    context.mode !== 'fork' ||
    context.agent !== role.id ||
    !workflow.forkConfigurations.some((value) => {
      const binding = object(value);
      return (
        binding.agent === role.id &&
        binding.configurationId === role.id &&
        binding.definitionVersion === role.version
      );
    }) ||
    !Array.isArray(contract.effectiveCapabilityCeiling)
  )
    throw new AgentError('workflow_fork_unavailable');
  const ceiling = new Set(contract.effectiveCapabilityCeiling as string[]);
  const capabilities = workflow.capabilities
    .map(object)
    .filter((binding) => ceiling.has(String(object(binding.capability).capabilityId)));
  const allowedTools = capabilities
    .filter((binding) => binding.kind === 'tool')
    .map((binding) => String(binding.definitionId));
  return {
    openingFacts: structuredClone({
      anchor: anchor.record,
      head: head.record,
      opening: opening.record,
      fork: fork.record,
      decision: decisionFact,
    }),
    toolIds: allowedTools.filter((id) => !role.toolIds || role.toolIds.includes(id)),
    capabilities: capabilities.map((binding) => ({
      kind: String(binding.kind),
      definitionId: String(binding.definitionId),
      definitionVersion: String(binding.definitionVersion),
    })),
    parentSkillRevision: object(entry.descriptor).revision,
    roleId: role.id,
    roleVersion: role.version,
    minimumApproval: contract.effectiveMinimumApproval ?? 'user',
    compiledEntry: structuredClone(entry) as unknown as CompiledSkillWorkflow,
    dependencyFacts: structuredClone(workflow.capabilities),
  };
}

/** Canonical finite JSON comparison includes all source/capability bindings without key-order dependence. */
export function workflowSnapshotDigest(value: Json) {
  const normalize = (item: Json): Json =>
    Array.isArray(item)
      ? item.map(normalize)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, normalize(item[key]!)]),
          )
        : item;
  return JSON.stringify(normalize(value));
}

export function assertWorkflowForkCurrent(
  fence: NonNullable<Awaited<ReturnType<typeof workflowForkFence>>>,
) {
  const facts = new Map(
    fence.dependencyFacts.map((binding) => {
      const item = object(binding);
      const fact = object(item.capability);
      return [String(fact.capabilityId), fact as unknown as WorkflowCapability] as const;
    }),
  );
  const current = revalidateSkillWorkflow(fence.compiledEntry, (id) => facts.get(id));
  if (
    current.descriptor.availability !== 'available' ||
    current.descriptor.revision !== fence.parentSkillRevision
  )
    throw new AgentError('workflow_source_changed');
}
