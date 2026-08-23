import { isAbsolute, resolve } from 'node:path';
import type {
  CapabilityApproval,
  CapabilityEffects,
  CapabilityPolicyCompilation,
  CapabilityPolicyCompiler,
  CapabilityPolicyContext,
  CapabilityPolicyEffects,
  CapabilityPolicyRecovery,
  CapabilityPolicyRisk,
  CapabilityRiskClass,
  RuntimeJsonValue,
} from '@kite/runtime-spi';
import { BROKERED_GIT_FEATURE_REVISION_ } from '@kite/runtime-spi';
import {
  hasBrokeredGitExecutableToken,
  isDestructiveShellCommand,
  isNetworkShellCommand,
  isReadOnlyShellCommand,
  isVcsMutationShellCommand,
  isWriteShellCommand,
  shellEffectsClassifier,
  taskEffectsClassifier,
} from './catalog-contract';
import {
  checkDangerousPaths,
  expandHomeRelativePath,
  isPathInsideWorkspace,
  msys2ToWindowsPath,
} from './sandbox';

export interface BuiltinPolicyRuleResult {
  readonly decision: CapabilityPolicyCompilation['decision'];
  readonly allowed: boolean;
  readonly requiresApproval: boolean;
  readonly risk: CapabilityPolicyRisk;
  readonly effects?: Readonly<CapabilityPolicyEffects>;
  readonly reason: string;
  readonly userVisibleSummary: string;
  readonly expectedEffects: readonly string[];
  readonly phaseConstraint?: 'planning';
  readonly effectiveEffects: CapabilityEffects;
  readonly fullAccessMayBypassApproval: boolean;
  readonly sameCommandMayBypassApproval: boolean;
  readonly recovery?: Readonly<CapabilityPolicyRecovery>;
}

export interface CreateBuiltinPolicyCompilerInput {
  readonly operationId: string;
  readonly capabilityRevision: string;
  readonly parserRevision: string;
  readonly declaredEffects: CapabilityEffects;
  readonly minimumApproval: CapabilityApproval;
  readonly rule: (
    input: RuntimeJsonValue,
    context: CapabilityPolicyContext,
    declaredEffects: CapabilityEffects,
    minimumApproval: CapabilityApproval,
    operationId: string,
  ) => BuiltinPolicyRuleResult;
}

export const BUILTIN_DYNAMIC_MCP_OPERATION_ID_ = 'mcp:dynamic_tool' as const;

/**
 * The dynamic MCP wrapper has no model-owned schema or executor semantics.
 * Its policy is compiled from the already-bound descriptor facts and the
 * current turn facts only. Authorization, grant matching, and admission stay
 * in Agent Kernel.
 */
export interface BuiltinDynamicMcpPolicyInput {
  readonly operationId: typeof BUILTIN_DYNAMIC_MCP_OPERATION_ID_;
  readonly capabilityRevision: string;
  readonly parserRevision: string;
  readonly exposedToolName: `mcp__${string}`;
  readonly effectiveEffects: CapabilityEffects;
  readonly minimumApproval: CapabilityApproval;
  readonly phase: CapabilityPolicyContext['phase'];
  readonly workspace: string;
}

/**
 * Compile the exact policy facts for one bound dynamic MCP invocation.
 *
 * This function intentionally accepts no MCP manager, Provider, executor,
 * authorization state, or fallback callback. The descriptor snapshot is the
 * sole source of effects/minimum approval; Kernel consumes the returned facts
 * for authorization and admission.
 */
export function compileBuiltinDynamicMcpPolicy(
  input: BuiltinDynamicMcpPolicyInput,
): CapabilityPolicyCompilation {
  if (
    input.operationId !== BUILTIN_DYNAMIC_MCP_OPERATION_ID_ ||
    input.capabilityRevision.length === 0 ||
    input.parserRevision.length === 0 ||
    input.exposedToolName.length === 0
  ) {
    throw new Error('Dynamic MCP policy compiler identity is invalid.');
  }

  const readOnly =
    input.minimumApproval === 'none' &&
    [
      input.effectiveEffects.filesystem,
      input.effectiveEffects.network,
      input.effectiveEffects.externalState,
    ].every((effect) => effect === 'none' || effect === 'read');

  if (readOnly) {
    return freezeCompilation({
      schema: 'kite.capability-policy-compilation.v1',
      operationId: BUILTIN_DYNAMIC_MCP_OPERATION_ID_,
      capabilityRevision: input.capabilityRevision,
      parserRevision: input.parserRevision,
      decision: 'allow',
      allowed: true,
      requiresApproval: false,
      risk: 'read',
      reason: 'Runtime-local MCP policy classifies this bound capability as read-only.',
      userVisibleSummary: `Run MCP tool: ${input.exposedToolName}`,
      expectedEffects: ['Calls a locally classified read-only MCP capability'],
      effectiveEffects: input.effectiveEffects,
      minimumApproval: input.minimumApproval,
      fullAccessMayBypassApproval: false,
      sameCommandMayBypassApproval: false,
    });
  }

  if (input.phase === 'planning') {
    return freezeCompilation({
      schema: 'kite.capability-policy-compilation.v1',
      operationId: BUILTIN_DYNAMIC_MCP_OPERATION_ID_,
      capabilityRevision: input.capabilityRevision,
      parserRevision: input.parserRevision,
      decision: 'deny',
      allowed: false,
      requiresApproval: false,
      risk: 'mcp',
      reason: `planning phase allows read-only inspection and plan updates only; rejected ${input.exposedToolName}.`,
      userVisibleSummary:
        'Plan mode is read-only. This operation did not run and cannot be approved while planning. Use read-only inspection or describe the intended implementation in the plan, then run it after plan approval.',
      expectedEffects: ['No workspace mutation or code execution will run'],
      phaseConstraint: 'planning',
      effectiveEffects: input.effectiveEffects,
      minimumApproval: input.minimumApproval,
      fullAccessMayBypassApproval: false,
      sameCommandMayBypassApproval: false,
    });
  }

  return freezeCompilation({
    schema: 'kite.capability-policy-compilation.v1',
    operationId: BUILTIN_DYNAMIC_MCP_OPERATION_ID_,
    capabilityRevision: input.capabilityRevision,
    parserRevision: input.parserRevision,
    decision: 'ask',
    allowed: true,
    requiresApproval: true,
    risk: 'mcp',
    effects: { uncertainEffects: true },
    reason: 'MCP tools require user approval by default.',
    userVisibleSummary: `Run MCP tool: ${input.exposedToolName}`,
    expectedEffects: ['Calls external MCP server tool', 'May have side effects'],
    effectiveEffects: input.effectiveEffects,
    minimumApproval: input.minimumApproval,
    fullAccessMayBypassApproval: false,
    sameCommandMayBypassApproval: false,
  });
}

/**
 * Bind one operation-specific rule to its exact immutable identity.  The
 * catalog calls this callback only after the same Builtin parser has produced
 * canonical input; no authorization state or execution handle is accepted.
 */
export function createBuiltinPolicyCompiler(
  input: CreateBuiltinPolicyCompilerInput,
): CapabilityPolicyCompiler {
  return (value, context) => {
    const result = input.rule(
      value,
      context,
      input.declaredEffects,
      input.minimumApproval,
      input.operationId,
    );
    return freezeCompilation({
      schema: 'kite.capability-policy-compilation.v1',
      operationId: input.operationId,
      capabilityRevision: input.capabilityRevision,
      parserRevision: input.parserRevision,
      ...result,
      minimumApproval: input.minimumApproval,
    });
  };
}

export function readOnlyBuiltinPolicyRule(
  input: RuntimeJsonValue,
  _context: CapabilityPolicyContext,
  declaredEffects: CapabilityEffects,
  _minimumApproval: CapabilityApproval,
  operationId: string,
): BuiltinPolicyRuleResult {
  const field = (name: string): string => stringField(input, name) ?? '';
  if (operationId === 'builtin:list_mcp_tools') {
    const provider = field('provider');
    return allowRule({
      risk: 'read',
      reason: 'MCP tool inventory reads in-memory capability and provider snapshots.',
      userVisibleSummary: `List MCP tools${provider ? ` from ${provider}` : ''}.`,
      expectedEffects: [
        'Reads cached capability metadata from in-memory snapshots',
        'Does not mutate workspace files',
        'Does not access remote MCP servers',
      ],
      effectiveEffects: readOnlyEffects(declaredEffects),
    });
  }
  if (operationId === 'builtin:list_mcp_resources') {
    const server = field('server');
    return allowRule({
      risk: 'read',
      reason: 'MCP resource metadata and content may be remote or externally managed.',
      userVisibleSummary: `List MCP resources${server ? ` from ${server}` : ''}.`,
      expectedEffects: [
        'Reads cached resource metadata from connected MCP servers',
        'Does not mutate workspace files',
      ],
      effectiveEffects: readOnlyEffects(declaredEffects),
    });
  }
  if (operationId === 'builtin:read_mcp_resource') {
    const server = field('server') || 'MCP server';
    const uri = field('uri') || '?';
    return allowRule({
      risk: 'read',
      reason: 'MCP resource metadata and content may be remote or externally managed.',
      userVisibleSummary: `Read MCP resource from ${server}: ${uri}`,
      expectedEffects: [
        'Reads content from external MCP server',
        'Does not mutate workspace files',
      ],
      effectiveEffects: readOnlyEffects(declaredEffects),
    });
  }
  if (operationId === 'builtin:tool_search') {
    return allowRule({
      risk: 'read',
      reason: 'Registry classifies tool_search as read-only.',
      userVisibleSummary: 'Run tool_search',
      expectedEffects: ['Reads data without mutating workspace or external state'],
      effectiveEffects: readOnlyEffects(declaredEffects),
    });
  }
  if (
    operationId === 'builtin:read_skill_reference' ||
    operationId === 'builtin:complete_skill' ||
    operationId === 'builtin:git_inspect'
  ) {
    const toolName = operationId.slice('builtin:'.length);
    return allowRule({
      risk: 'read',
      reason: `Registry classifies ${toolName} as read-only.`,
      userVisibleSummary: `Run ${toolName}`,
      expectedEffects: ['Reads data without mutating workspace or external state'],
      effectiveEffects: readOnlyEffects(declaredEffects),
    });
  }
  return allowRule({
    risk: 'read',
    reason: 'Builtin capability is classified as read-only.',
    userVisibleSummary: 'Run the read-only Builtin capability.',
    expectedEffects: [
      'Reads governed Runtime data',
      'Does not intentionally mutate workspace files',
    ],
    effectiveEffects: readOnlyEffects(declaredEffects),
  });
}

export function planBuiltinPolicyRule(
  _input: RuntimeJsonValue,
  _context: CapabilityPolicyContext,
  declaredEffects: CapabilityEffects,
  _minimumApproval: CapabilityApproval,
  operationId: string,
): BuiltinPolicyRuleResult {
  if (operationId === 'builtin:read_plan') {
    return allowRule({
      risk: 'read',
      reason: 'Registry classifies read_plan as read-only.',
      userVisibleSummary: 'Run read_plan',
      expectedEffects: ['Reads data without mutating workspace or external state'],
      effectiveEffects: readOnlyEffects(declaredEffects),
    });
  }
  if (operationId === 'builtin:update_plan') {
    return allowRule({
      risk: 'plan',
      reason: 'Plan progress updates do not mutate the workspace.',
      userVisibleSummary: 'Update plan step progress.',
      expectedEffects: ['Updates runtime state only'],
      effectiveEffects: declaredEffects,
    });
  }
  return allowRule({
    risk: 'plan',
    reason: 'Plan draft writes do not mutate the workspace.',
    userVisibleSummary: 'Save plan draft.',
    expectedEffects: ['Updates runtime state only'],
    effectiveEffects: declaredEffects,
  });
}

export function askUserBuiltinPolicyRule(
  _input: RuntimeJsonValue,
  _context: CapabilityPolicyContext,
  declaredEffects: CapabilityEffects,
  _minimumApproval: CapabilityApproval,
): BuiltinPolicyRuleResult {
  return allowRule({
    risk: 'plan',
    reason: 'User clarification interrupts do not mutate the workspace.',
    userVisibleSummary: 'Ask the user a focused clarification question.',
    expectedEffects: ['Interrupts for user input', 'Does not read or write workspace files'],
    effectiveEffects: declaredEffects,
  });
}

/** Preserve the existing planning role ceiling while keeping child approval independent. */
export function taskBuiltinPolicyRule(
  input: RuntimeJsonValue,
  context: CapabilityPolicyContext,
  declaredEffects: CapabilityEffects,
  _minimumApproval: CapabilityApproval,
): BuiltinPolicyRuleResult {
  const role = stringField(input, 'subagent_type');
  const effectiveEffects = taskEffectsClassifier(declaredEffects)(input, context).effectiveEffects;
  if (context.phase === 'planning' && role !== 'explore' && role !== 'plan') {
    return denyRule({
      risk: 'execute_code',
      reason: 'planning phase allows read-only sub-agents only.',
      userVisibleSummary: `Plan mode did not start the ${role ?? 'unknown'} sub-agent. Use an explore or plan sub-agent, or describe the implementation in the plan for execution after plan approval.`,
      expectedEffects: ['No implementation sub-agent will run during planning'],
      phaseConstraint: 'planning',
      effectiveEffects,
    });
  }
  return allowRule({
    risk: 'plan',
    reason:
      'Sub-agent dispatch is a coordination tool; sub-agent actions have their own approval flow.',
    userVisibleSummary: 'Dispatch a specialized sub-agent for an isolated task.',
    expectedEffects: [
      'Runs a sub-agent in an isolated context',
      'Sub-agent tool calls follow their own approval rules',
    ],
    effectiveEffects,
  });
}

export function activateSkillBuiltinPolicyRule(
  _input: RuntimeJsonValue,
  context: CapabilityPolicyContext,
  declaredEffects: CapabilityEffects,
  _minimumApproval: CapabilityApproval,
): BuiltinPolicyRuleResult {
  if (context.phase === 'planning') {
    return denyRule({
      risk: 'unknown',
      reason: 'planning phase rejects external side effects (activate_skill).',
      userVisibleSummary: 'Rejected activate_skill during planning phase.',
      expectedEffects: ['No external side effects from planning'],
      phaseConstraint: 'planning',
      effectiveEffects: declaredEffects,
    });
  }
  return askRule({
    risk: 'unknown',
    effects: { uncertainEffects: true },
    reason: 'activate_skill may have external side effects.',
    userVisibleSummary: 'Run activate_skill',
    expectedEffects: ['May have external side effects'],
    effectiveEffects: declaredEffects,
    fullAccessMayBypassApproval: false,
    sameCommandMayBypassApproval: false,
  });
}

export function shellBuiltinPolicyRule(
  input: RuntimeJsonValue,
  context: CapabilityPolicyContext,
  declaredEffects: CapabilityEffects,
  _minimumApproval: CapabilityApproval,
): BuiltinPolicyRuleResult {
  const command = stringField(input, 'command')?.trim() ?? '';
  if (!command) {
    return denyRule({
      risk: 'unknown',
      reason: 'shell_execute requires a non-empty command.',
      userVisibleSummary: 'Rejected empty shell command.',
      expectedEffects: ['No command will be executed'],
      effectiveEffects: declaredEffects,
    });
  }

  if (
    context.featureFlags?.brokeredGit === true &&
    context.brokeredGitFeatureRevision === BROKERED_GIT_FEATURE_REVISION_ &&
    hasBrokeredGitExecutableToken(command)
  ) {
    return denyRule({
      risk: 'vcs_mutation',
      reason: 'Git commands are denied through shell_execute by the brokered Git boundary.',
      userVisibleSummary: 'Use git_inspect for local Git status, diff, log, or branch inspection.',
      expectedEffects: [
        'No shell command will be executed',
        'Use the governed git_inspect capability for local Git inspection',
      ],
      effectiveEffects: shellEffectiveEffects(command, context.workspace, declaredEffects)
        .effectiveEffects,
      recovery: {
        disposition: 'never',
        maximumAdditionalCalls: 0,
        safeAutomaticRetry: false,
        capabilityIntent: 'git_inspect',
      },
    });
  }

  const dangerousPath = checkDangerousPaths(command);
  if (dangerousPath) {
    return denyRule({
      risk: 'destructive',
      reason: `Protected path '${dangerousPath}' cannot be accessed by model-driven Shell.`,
      userVisibleSummary: `Blocked protected path access: ${dangerousPath}`,
      expectedEffects: ['No command will be executed'],
      effectiveEffects: declaredEffects,
    });
  }

  const destructive = isDestructiveShellCommand(command.toLowerCase());
  if (destructive) {
    if (isWorkspaceRootRemoval(command, context.workspace)) {
      return denyRule({
        risk: 'destructive',
        reason: 'rm -rf must not delete workspace code.',
        userVisibleSummary: `Rejected destructive rm targeting workspace: ${command}`,
        expectedEffects: ['No command will be executed'],
        effectiveEffects: declaredEffects,
      });
    }
    if (isCriticalSystemRemoval(command)) {
      return denyRule({
        risk: 'destructive',
        reason: 'rm -rf must not delete critical system paths.',
        userVisibleSummary: `Rejected destructive rm targeting critical system paths: ${command}`,
        expectedEffects: ['No command will be executed'],
        effectiveEffects: declaredEffects,
      });
    }
    if (context.phase === 'planning') {
      return denyRule({
        risk: 'write_file',
        reason:
          'planning phase allows read-only inspection and plan updates only; rejected shell_execute.',
        userVisibleSummary:
          'Plan mode is read-only. This operation did not run and cannot be approved while planning. Use read-only inspection or describe the intended implementation in the plan, then run it after plan approval.',
        expectedEffects: ['No workspace mutation or code execution will run'],
        phaseConstraint: 'planning',
        effectiveEffects: shellEffectiveEffects(command, context.workspace, declaredEffects)
          .effectiveEffects,
      });
    }
    return askRule({
      risk: 'write_file',
      effects: shellPolicyEffects(command, context.workspace),
      reason: 'rm -rf on non-critical paths; downgraded to write_file risk.',
      userVisibleSummary: `Remove files: ${command}`,
      expectedEffects: ['Deletes files and directories outside workspace and system paths'],
      effectiveEffects: shellEffectiveEffects(command, context.workspace, declaredEffects)
        .effectiveEffects,
      fullAccessMayBypassApproval: false,
      sameCommandMayBypassApproval: false,
    });
  }

  const shellEffects = shellEffectiveEffects(command, context.workspace, declaredEffects);
  if (isReadOnlyShellCommand(command)) {
    if (shellEffects.policyEffects?.externalRead) {
      return askRule({
        risk: 'read',
        effects: shellEffects.policyEffects,
        reason: 'This shell command reads files outside the workspace.',
        userVisibleSummary: `Read external files with Shell: ${command}`,
        expectedEffects: ['Reads files outside the workspace boundary'],
        effectiveEffects: shellEffects.effectiveEffects,
        fullAccessMayBypassApproval: false,
        sameCommandMayBypassApproval: false,
      });
    }
    return allowRule({
      risk: 'read',
      reason: 'Command is classified as read-only.',
      userVisibleSummary: `Run read-only shell command: ${command}`,
      expectedEffects: [
        'Reads local workspace or git metadata',
        'Does not intentionally mutate files',
      ],
      effectiveEffects: shellEffects.effectiveEffects,
    });
  }

  if (context.phase === 'planning') {
    return denyRule({
      risk: shellRisk(command),
      reason:
        'planning phase allows read-only inspection and plan updates only; rejected shell_execute.',
      userVisibleSummary:
        'Plan mode is read-only. This operation did not run and cannot be approved while planning. Use read-only inspection or describe the intended implementation in the plan, then run it after plan approval.',
      expectedEffects: ['No workspace mutation or code execution will run'],
      phaseConstraint: 'planning',
      effectiveEffects: shellEffects.effectiveEffects,
    });
  }

  const risk = shellRisk(command);
  return askRule({
    risk,
    effects: shellEffects.policyEffects,
    reason:
      risk === 'vcs_mutation'
        ? 'This command mutates version-control state.'
        : risk === 'write_file'
          ? 'This shell command may modify workspace files.'
          : risk === 'network'
            ? 'This shell command may access the network.'
            : 'This shell command executes local project code or an arbitrary program.',
    userVisibleSummary:
      risk === 'vcs_mutation'
        ? `Run version-control mutation command: ${command}`
        : risk === 'write_file'
          ? `Run workspace-mutating shell command: ${command}`
          : risk === 'network'
            ? `Run network-capable shell command: ${command}`
            : `Run shell command: ${command}`,
    expectedEffects:
      risk === 'vcs_mutation'
        ? ['Mutates git state', 'May change staged files, commits, or branches']
        : risk === 'write_file'
          ? [
              'May modify files inside the workspace',
              'May create cache, temp, or dependency output',
            ]
          : risk === 'network'
            ? ['May access network resources', 'May write downloaded or generated output']
            : ['Executes local project code', 'May create cache or temporary output'],
    effectiveEffects: shellEffects.effectiveEffects,
    fullAccessMayBypassApproval: true,
    sameCommandMayBypassApproval: true,
  });
}

export function fileBuiltinPolicyRule(
  input: RuntimeJsonValue,
  context: CapabilityPolicyContext,
  declaredEffects: CapabilityEffects,
  _minimumApproval: CapabilityApproval,
  operationId: string,
): BuiltinPolicyRuleResult {
  const isRead =
    operationId === 'builtin:read_file' ||
    operationId === 'builtin:search_content' ||
    operationId === 'builtin:search_files';
  const path = stringField(input, 'path') ?? (isRead ? '.' : '<unknown>');
  if (isRead) {
    const external = isExternalPath(path, context.workspace);
    return allowRule({
      risk: 'read',
      ...(external ? { effects: { externalRead: true } } : {}),
      reason: external
        ? 'Read-only file tools may inspect paths outside the workspace without approval.'
        : 'Read-only workspace inspection.',
      userVisibleSummary: external
        ? `${operationId === 'builtin:read_file' ? 'Read external file' : operationId === 'builtin:search_content' ? 'Search content in external path' : 'Search files in external path'}: ${path}`
        : `Read workspace data using ${operationId.slice('builtin:'.length)}.`,
      expectedEffects: external
        ? ['Reads files outside the workspace boundary']
        : ['Reads workspace files', 'Does not intentionally mutate files'],
      effectiveEffects: readOnlyEffects(declaredEffects),
    });
  }
  if (context.phase === 'planning') {
    const outcome =
      operationId === 'builtin:write_file' ? 'No file was written.' : 'No file was edited.';
    return denyRule({
      risk: 'write_file',
      reason:
        'Plan mode is read-only. Workspace edits must be described in the plan and applied only after plan approval.',
      userVisibleSummary: `Plan mode is read-only. ${outcome} Describe the intended change in the plan and apply it after plan approval.`,
      expectedEffects: ['No workspace file was modified'],
      phaseConstraint: 'planning',
      effectiveEffects: declaredEffects,
    });
  }
  const external = isExternalPath(path, context.workspace);
  return askRule({
    risk: 'write_file',
    ...(external ? { effects: { externalWrite: true } } : {}),
    reason: external
      ? 'This tool modifies files outside the workspace.'
      : 'This tool modifies workspace files.',
    userVisibleSummary: `Modify ${external ? 'external ' : 'workspace '}file: ${path}`,
    expectedEffects: external
      ? ['Modifies files outside the workspace boundary', 'May overwrite existing content']
      : ['Modifies files inside the workspace', 'May overwrite existing content'],
    effectiveEffects: external ? { ...declaredEffects, filesystem: 'write' } : declaredEffects,
    fullAccessMayBypassApproval: !external,
    sameCommandMayBypassApproval: false,
  });
}

export function webFetchBuiltinPolicyRule(
  input: RuntimeJsonValue,
  _context: CapabilityPolicyContext,
  declaredEffects: CapabilityEffects,
  _minimumApproval: CapabilityApproval,
): BuiltinPolicyRuleResult {
  const rawUrl = stringField(input, 'url')?.trim() ?? '';
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return denyRule({
      risk: 'network',
      reason: 'Invalid URL format.',
      userVisibleSummary: 'Blocked a web fetch with an invalid URL.',
      expectedEffects: ['No request will be sent'],
      effectiveEffects: declaredEffects,
    });
  }
  if (url.username || url.password) {
    return denyRule({
      risk: 'network',
      reason: 'URL must not contain embedded credentials (userinfo).',
      userVisibleSummary: 'Blocked a web fetch to a URL with embedded credentials.',
      expectedEffects: ['No request will be sent'],
      effectiveEffects: declaredEffects,
    });
  }
  if (/[?&](?:token|key|secret|password|auth|api_key)=[^&]{20,}/i.test(rawUrl)) {
    return denyRule({
      risk: 'network',
      reason: 'URL query parameters appear to contain credentials.',
      userVisibleSummary: 'Blocked a web fetch to a URL containing credentials in query.',
      expectedEffects: ['No request will be sent'],
      effectiveEffects: declaredEffects,
    });
  }
  return allowRule({
    risk: 'network',
    effects: { network: true },
    reason: 'Read-only web fetch with SSRF and privacy protection.',
    userVisibleSummary: `Fetch: ${rawUrl.slice(0, 60)}`,
    expectedEffects: [
      'Fetches a public web page',
      'Extracts and returns clean Markdown or raw text content',
    ],
    effectiveEffects: { ...declaredEffects, network: 'read' },
  });
}

function allowRule(input: {
  readonly risk: CapabilityPolicyRisk;
  readonly effects?: Readonly<CapabilityPolicyEffects>;
  readonly reason: string;
  readonly userVisibleSummary: string;
  readonly expectedEffects: readonly string[];
  readonly effectiveEffects: CapabilityEffects;
  readonly fullAccessMayBypassApproval?: boolean;
  readonly sameCommandMayBypassApproval?: boolean;
  readonly recovery?: Readonly<CapabilityPolicyRecovery>;
}): BuiltinPolicyRuleResult {
  return {
    decision: 'allow',
    allowed: true,
    requiresApproval: false,
    ...input,
    fullAccessMayBypassApproval: input.fullAccessMayBypassApproval ?? false,
    sameCommandMayBypassApproval: input.sameCommandMayBypassApproval ?? false,
  };
}

function askRule(input: {
  readonly risk: CapabilityPolicyRisk;
  readonly effects?: Readonly<CapabilityPolicyEffects>;
  readonly reason: string;
  readonly userVisibleSummary: string;
  readonly expectedEffects: readonly string[];
  readonly effectiveEffects: CapabilityEffects;
  readonly phaseConstraint?: 'planning';
  readonly fullAccessMayBypassApproval?: boolean;
  readonly sameCommandMayBypassApproval?: boolean;
  readonly recovery?: Readonly<CapabilityPolicyRecovery>;
}): BuiltinPolicyRuleResult {
  return {
    decision: 'ask',
    allowed: true,
    requiresApproval: true,
    ...input,
    fullAccessMayBypassApproval: input.fullAccessMayBypassApproval ?? false,
    sameCommandMayBypassApproval: input.sameCommandMayBypassApproval ?? false,
  };
}

function denyRule(input: {
  readonly risk: CapabilityPolicyRisk;
  readonly effects?: Readonly<CapabilityPolicyEffects>;
  readonly reason: string;
  readonly userVisibleSummary: string;
  readonly expectedEffects: readonly string[];
  readonly effectiveEffects: CapabilityEffects;
  readonly phaseConstraint?: 'planning';
  readonly recovery?: Readonly<CapabilityPolicyRecovery>;
}): BuiltinPolicyRuleResult {
  return {
    decision: 'deny',
    allowed: false,
    requiresApproval: false,
    ...input,
    fullAccessMayBypassApproval: false,
    sameCommandMayBypassApproval: false,
  };
}

function readOnlyEffects(effects: CapabilityEffects): CapabilityEffects {
  return Object.freeze({
    filesystem: effects.filesystem === 'none' ? 'none' : 'read',
    network: effects.network === 'none' ? 'none' : 'read',
    externalState: effects.externalState === 'none' ? 'none' : 'read',
  });
}

function stringField(input: RuntimeJsonValue, key: string): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = (input as Readonly<Record<string, RuntimeJsonValue>>)[key];
  return typeof value === 'string' ? value : undefined;
}

function shellRisk(command: string): CapabilityPolicyRisk {
  if (isVcsMutationShellCommand(command.toLowerCase())) return 'vcs_mutation';
  if (isWriteShellCommand(command.toLowerCase())) return 'write_file';
  if (isNetworkShellCommand(command.toLowerCase())) return 'network';
  return 'execute_code';
}

function shellPolicyEffects(
  command: string,
  workspace: string,
): CapabilityPolicyEffects | undefined {
  const effects: {
    network?: true;
    externalRead?: true;
    externalWrite?: true;
    uncertainEffects?: true;
  } = {};
  const normalized = command.toLowerCase();
  const readOnly = isReadOnlyShellCommand(command);
  if (isNetworkShellCommand(normalized)) effects.network = true;
  const writeTargets = readOnly
    ? []
    : isVcsMutationShellCommand(normalized)
      ? shellGitWriteTargets(command)
      : shellWriteTargets(command);
  if (writeTargets === null) effects.uncertainEffects = true;
  else if (writeTargets.some((target) => isExternalPath(target, workspace)))
    effects.externalWrite = true;
  const readTargets = [
    ...(readOnly ? shellReadTargets(command) : []),
    ...(isNetworkShellCommand(normalized) ? shellNetworkReadTargets(command) : []),
  ];
  if (readTargets.some((target) => isExternalPath(target, workspace))) effects.externalRead = true;
  if (Object.keys(effects).length > 0) return Object.freeze(effects);
  return isVcsMutationShellCommand(normalized) ? Object.freeze({}) : undefined;
}

function shellEffectiveEffects(
  command: string,
  workspace: string,
  declaredEffects: CapabilityEffects,
): {
  readonly policyEffects?: Readonly<CapabilityPolicyEffects>;
  readonly effectiveEffects: CapabilityEffects;
} {
  const effects = shellPolicyEffects(command, workspace);
  const effectiveEffects = shellEffectsClassifier(declaredEffects)(
    { command },
    {},
  ).effectiveEffects;
  return Object.freeze({
    ...(effects ? { policyEffects: effects } : {}),
    effectiveEffects,
  });
}

function isExternalPath(value: string, workspace: string): boolean {
  const normalized = expandHomeRelativePath(msys2ToWindowsPath(stripQuotes(value)));
  try {
    const target = isAbsolute(normalized) ? resolve(normalized) : resolve(workspace, normalized);
    return !isPathInsideWorkspace(workspace, target);
  } catch {
    return true;
  }
}

function shellWriteTargets(command: string): string[] | null {
  const trimmed = command.trim();
  if (!trimmed || /[;&|`$(){}[\]*?]/.test(trimmed)) return null;
  const redirect = /(?:^|[^>])>{1,2}\s*([^\s]+)/.exec(trimmed);
  if (redirect?.[1]) return [redirect[1]];
  const tokens = trimmed.split(/\s+/);
  const program = tokens[0]?.toLowerCase().replace(/\.(?:cmd|exe)$/iu, '');
  const paths = tokens.slice(1).filter((token) => !token.startsWith('-'));
  if (['touch', 'mkdir', 'tee', 'rm', 'unlink'].includes(program ?? '')) {
    return paths.length > 0 ? paths : null;
  }
  if (program === 'cp' || program === 'mv') return paths.length >= 2 ? [paths.at(-1)!] : null;
  if (program === 'curl' || program === 'wget') {
    const targets: string[] = [];
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (['-o', '-O', '--output', '--output-document'].includes(token) && tokens[index + 1]) {
        targets.push(tokens[index + 1]!);
        index += 1;
      }
    }
    return targets;
  }
  return null;
}

function shellGitWriteTargets(command: string): string[] | null {
  const trimmed = command.trim();
  if (!trimmed || /[;&|`$(){}[\]*?]/.test(trimmed)) return null;
  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(stripQuotes) ?? [];
  const gitIndex = tokens.findIndex(
    (token) => token.toLowerCase().replace(/\.(?:cmd|exe)$/iu, '') === 'git',
  );
  if (gitIndex < 0) return null;
  const args = tokens.slice(gitIndex + 1);
  const targets: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '-C' && args[index + 1]) {
      targets.push(args[index + 1]!);
      index += 1;
    } else if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) {
      targets.push(arg.slice(arg.indexOf('=') + 1));
    }
  }
  const cloneIndex = args.findIndex((arg) => arg.toLowerCase() === 'clone');
  if (cloneIndex >= 0) {
    const operands = args.slice(cloneIndex + 1).filter((arg) => !arg.startsWith('-'));
    if (operands.length >= 2) targets.push(operands.at(-1)!);
  }
  return targets;
}

function shellReadTargets(command: string): string[] {
  const targets: string[] = [];
  for (const segment of command.split(/\s*(?:\|\||&&|[|;])\s*/g)) {
    const tokens = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    const program = stripQuotes(tokens[0] ?? '')
      .toLowerCase()
      .replace(/\.(?:cmd|exe)$/iu, '');
    if (!program) continue;
    for (let index = 1; index < tokens.length; index += 1) {
      const token = stripQuotes(tokens[index]!);
      if (token === '<' && tokens[index + 1]) {
        targets.push(tokens[index + 1]!);
        index += 1;
      } else if (token.startsWith('<')) {
        targets.push(token.slice(1));
      }
    }
    const operands = tokens.slice(1).filter((token) => {
      const value = stripQuotes(token);
      return value !== '<' && !value.startsWith('<') && !value.startsWith('-');
    });
    if (program === 'rg' || program === 'grep') {
      for (let index = 1; index < tokens.length; index += 1) {
        const token = stripQuotes(tokens[index]!);
        if (['-f', '--file', '--ignore-file'].includes(token) && tokens[index + 1]) {
          targets.push(tokens[index + 1]!);
          index += 1;
        } else if (['--file', '--ignore-file'].some((name) => token.startsWith(`${name}=`))) {
          targets.push(token.slice(token.indexOf('=') + 1));
        }
      }
    }
    if (['grep', 'rg', 'sed', 'awk'].includes(program)) targets.push(...operands.slice(1));
    else if (!['echo', 'pwd', 'test'].includes(program)) targets.push(...operands);
  }
  return targets;
}

function shellNetworkReadTargets(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed || /[;&|`$(){}[\]*?]/.test(trimmed)) return [];
  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(stripQuotes) ?? [];
  const program = (tokens[0] ?? '').toLowerCase().replace(/\.(?:cmd|exe)$/iu, '');
  const targets: string[] = [];
  const optionValues = (names: readonly string[]): void => {
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (names.includes(token) && tokens[index + 1]) {
        targets.push(tokens[index + 1]!);
        index += 1;
      } else if (names.some((name) => token.startsWith(`${name}=`))) {
        targets.push(token.slice(token.indexOf('=') + 1));
      }
    }
  };
  if (program === 'curl') {
    optionValues(['-T', '--upload-file', '-K', '--config', '-b', '--cookie']);
  } else if (program === 'wget') {
    optionValues(['-i', '--input-file']);
  }
  return targets;
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

function shellTargets(command: string): readonly string[] {
  const withoutPrefix = command.replace(/^(?:sudo|runas)\s+/i, '').trim();
  const tokens = withoutPrefix.split(/\s+/);
  const rmIndex = tokens.findIndex((token) => token.toLowerCase() === 'rm');
  if (rmIndex < 0) return [];
  return tokens.slice(rmIndex + 1).filter((token) => !token.startsWith('-'));
}

function isWorkspaceRootRemoval(command: string, workspace: string): boolean {
  return shellTargets(command).some((target) => {
    const clean = stripQuotes(target);
    if (clean === '.') return true;
    try {
      const resolvedTarget = isAbsolute(clean) ? resolve(clean) : resolve(workspace, clean);
      return resolvedTarget === resolve(workspace);
    } catch {
      return true;
    }
  });
}

function isCriticalSystemRemoval(command: string): boolean {
  const critical = [
    '/',
    '/etc',
    '/boot',
    '/bin',
    '/sbin',
    '/lib',
    '/lib64',
    '/sys',
    '/proc',
    '/dev',
    'c:/windows',
    'c:/windows/system32',
  ];
  return shellTargets(command).some((target) => {
    const lexicalTarget = stripQuotes(target).replace(/\\/g, '/').toLowerCase();
    const normalized = lexicalTarget === '/' ? '/' : lexicalTarget.replace(/\/$/u, '');
    return critical.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
  });
}

function freezeCompilation(value: CapabilityPolicyCompilation): CapabilityPolicyCompilation {
  const effects = value.effects ? Object.freeze({ ...value.effects }) : undefined;
  const effectiveEffects = Object.freeze({ ...value.effectiveEffects });
  const expectedEffects = Object.freeze([...value.expectedEffects]);
  return Object.freeze({
    ...value,
    ...(effects ? { effects } : {}),
    ...(value.recovery ? { recovery: Object.freeze({ ...value.recovery }) } : {}),
    effectiveEffects,
    expectedEffects,
  });
}

export function capabilityRiskFromEffects(
  effectClass: CapabilityRiskClass,
  effects: CapabilityEffects,
): CapabilityPolicyRisk {
  if (
    effects.filesystem === 'destructive' ||
    effects.network === 'destructive' ||
    effects.externalState === 'destructive'
  ) {
    return 'destructive';
  }
  if (effects.filesystem === 'write') return 'write_file';
  if (effects.network === 'read' || effects.network === 'write') return 'network';
  if (effects.externalState === 'read' || effects.externalState === 'write') return 'mcp';
  if (effectClass === 'read') return 'read';
  if (effectClass === 'plan') return 'plan';
  if (effectClass === 'workspace_write') return 'write_file';
  if (effectClass === 'execute') return 'execute_code';
  return 'unknown';
}
