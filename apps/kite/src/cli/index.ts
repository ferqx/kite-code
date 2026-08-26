import { resolve } from 'node:path';
import {
  discoverSandboxBackendCandidate,
  resolveSandboxRuntime,
  resolveWindowsManagedNetworkSetupStatus,
  setupWindowsManagedNetwork,
} from '@kite-ai/builtin-runtime/sandbox';
import type { InteractionMode, ShellApprovalGrant } from '@kite-ai/runtime-contract';
import {
  RUNTIME_COMMAND_SCHEMA_,
  type RuntimeAccess,
  type RuntimeAccessNotification,
  type RuntimeClientInteraction,
  type RuntimeCommand,
  type RuntimeInteractionResponse,
  type RuntimeNotificationEvent,
} from '@kite-ai/runtime-contract';
import { type FeatureFlags, getFeatureFlags } from '#app/config/features';
import {
  type AgentConfig,
  defaultCheckpointPath,
  loadAgentConfig,
  parseFeatureOverride,
} from '#app/config/index';
import { skillDirs } from '#app/config/paths';
import { shouldPromptWorkspaceTrust, trustWorkspace } from '#app/config/workspace-trust';
import { composeAppGitBroker, resolveAppGitExecutable } from '#app/git/composition';
import { composeObservability, observeRuntimeFact } from '#app/observability/composition';
import { resolveTelemetryConsent } from '#app/observability/consent';
import { formatObservabilityStatus, projectObservabilityStatus } from '#app/observability/status';
import { resolveReleaseComposition } from '#app/release/composition-root';
import {
  formatExecutionStatus,
  formatUnadmittedExecutionStatus,
  tryProjectAdmittedExecutionStatus,
} from '#app/release/execution-status';
import { formatReleaseStatus, projectReleaseStatus } from '#app/release/status-projection';
import {
  createRuntimeCommandIdAllocator,
  type RuntimeCommandIdAllocator,
} from '#app/runtime-client/command-id';
import { projectTerminalOutcome } from '#app/runtime-projection';
import type { SandboxBackend } from '#app/sandbox/types';
import { filterTraceTurn, formatTrace, parseTraceJsonl } from '#app/trace/replay';
import { composeAppSandboxExecutor } from '@/app/sandbox/composition';

export interface CliRuntimeAccessInput {
  readonly sessionId: string;
  readonly userId: string;
  readonly workspace: string;
  readonly checkpointPath: string;
  readonly config: AgentConfig;
  readonly shellExecutor: ReturnType<typeof composeAppSandboxExecutor>;
  readonly gitBroker?: ReturnType<typeof composeAppGitBroker>;
  readonly interactionMode: InteractionMode;
  readonly sandboxBackend: SandboxBackend;
  readonly skillOptions: ReturnType<typeof skillDirs>;
  readonly initialSkillActivations: readonly {
    readonly skillId: string;
    readonly input: Readonly<Record<string, unknown>>;
  }[];
  readonly onSessionLoggingStatus?: (status: {
    readonly mode: 'off' | 'metadata' | 'content';
  }) => void;
  readonly onSessionLoggingDiagnostic?: (message: string) => void;
}

export interface CliMainDependencies {
  readonly prepareRuntimeSessionResume: (
    checkpointPath: string,
    sessionId: string,
  ) => 'ready' | 'not_found' | 'failed';
  readonly createRuntimeAccess: (
    input: CliRuntimeAccessInput,
  ) => RuntimeAccess & Partial<AsyncDisposable>;
  readonly runRuntimeServerStdio?: (input: CliRuntimeAccessInput) => Promise<void>;
  readonly commandIds?: RuntimeCommandIdAllocator;
}

export interface ParsedArgs {
  command:
    | 'run'
    | 'resume'
    | 'trace'
    | 'help'
    | 'sandbox-setup'
    | 'sandbox-status'
    | 'server-stdio';
  task?: string;
  threadId: string;
  userId: string;
  workspace: string;
  checkpointPath: string;
  approve: boolean;
  approvalGrant?: ShellApprovalGrant;
  approvalHash?: string;
  replacementCommand?: string;
  answer?: string;
  trustWorkspace: boolean;
  sandbox: boolean;
  interactionMode?: import('@kite-ai/runtime-contract').InteractionMode;
  skills: string[];
  featureOverrides: Partial<FeatureFlags>;
  tracePath?: string;
  traceTurn?: number;
  traceFormat?: 'text' | 'json';
  executionStatus: boolean;
  releaseStatus: boolean;
  telemetryStatus: boolean;
}

export async function main(dependencies: CliMainDependencies): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    printHelp();
    return;
  }
  if (args.command === 'trace') {
    if (!args.tracePath) throw new Error('trace requires a JSONL path.');
    const records = parseTraceJsonl(args.tracePath);
    if (args.traceFormat === 'json') {
      const turn = args.traceTurn;
      const selected = filterTraceTurn(records, turn);
      console.log(JSON.stringify(selected, null, 2));
    } else {
      console.log(
        formatTrace(records, {
          turn: args.traceTurn,
          color: Boolean(process.stdout.isTTY),
        }),
      );
    }
    return;
  }
  if (args.command === 'sandbox-status') {
    console.log(JSON.stringify(await resolveWindowsManagedNetworkSetupStatus(), null, 2));
    return;
  }
  if (args.command === 'sandbox-setup') {
    const status = await setupWindowsManagedNetwork();
    console.log(`Windows network sandbox is ${status.state}.`);
    return;
  }
  if (args.command === 'resume' && !args.task?.trim()) {
    throw new Error('resume requires --task (or positional task text) to continue the session.');
  }
  if (args.command === 'server-stdio' && !args.threadId) {
    throw new Error('server --stdio requires an explicit --thread owned by the parent process.');
  }

  // Workspace trust gate (docs/active/workspace-trust.md). `run` executes
  // project-derived configuration, skills and MCP declarations, so an untrusted
  // directory is rejected before anything loads — same fail-closed policy as the
  // TUI gate. `trace`/`help` do not execute project code and stay ungated.
  if (shouldPromptWorkspaceTrust(args.workspace)) {
    if (!args.trustWorkspace) {
      throw new Error(
        `Workspace is not trusted: ${args.workspace}\n` +
          'Open this folder in the TUI (bun run tui) and accept the trust prompt, ' +
          'or pass --trust-workspace to record trust explicitly from this entry point.',
      );
    }
    const decision = trustWorkspace({
      workspace: args.workspace,
      source: 'config',
    });
    if (decision.status !== 'recorded') {
      throw new Error(`Workspace trust could not be recorded: ${decision.message}`);
    }
  }

  const loadedConfig = loadAgentConfig();
  const config = {
    ...loadedConfig,
    features: { ...loadedConfig.features, ...args.featureOverrides },
  };
  const interactionMode = args.interactionMode ?? config.interactionMode ?? 'auto';
  const sandboxRuntime = resolveSandboxRuntime({
    enabled: args.sandbox && config.sandbox.enabled,
    detectBackend: discoverSandboxBackendCandidate,
  });
  const executionStatus = tryProjectAdmittedExecutionStatus({
    config,
    sandboxRuntime,
  });
  if (args.telemetryStatus) {
    const consent = resolveTelemetryConsent({
      releaseChannel: 'development',
      user: config.telemetry?.user,
      project: config.telemetry?.project,
    });
    console.log(
      formatObservabilityStatus(
        projectObservabilityStatus({
          artifactTelemetryAllowed: false,
          featureEnabled: getFeatureFlags(config).observabilityMetrics,
          consent,
          remoteExporterConfigured: false,
        }),
      ),
    );
    return;
  }
  if (args.releaseStatus) {
    const composition = resolveReleaseComposition({
      config,
      artifactReleaseProfileV1Enabled: false,
      profileId: 'internal-dogfood',
      production: false,
    });
    console.log(formatReleaseStatus(projectReleaseStatus({ composition, executionStatus })));
    return;
  }
  if (args.executionStatus) {
    console.log(
      executionStatus
        ? formatExecutionStatus(executionStatus)
        : formatUnadmittedExecutionStatus(sandboxRuntime),
    );
    return;
  }
  const shellExecutor = composeAppSandboxExecutor({
    entrypoint: 'foreground_cli',
    workspace: args.workspace,
    config,
    sandboxEnabled: sandboxRuntime.enabled,
    onDiagnostic: (message) => console.warn(`[sandbox] ${message}`),
  });
  const shellRuntime = await shellExecutor.prepare();
  const gitExecutable = resolveAppGitExecutable();
  const gitBroker =
    gitExecutable && config.brokeredGitShellDenyEvidence
      ? composeAppGitBroker({
          workspace: args.workspace,
          executable: gitExecutable,
          config,
          shellDenyEvidence: config.brokeredGitShellDenyEvidence,
        })
      : undefined;
  const effectiveSandboxRuntime =
    shellRuntime.mode === 'sandbox'
      ? { enabled: true, backend: shellRuntime.backend, available: true }
      : { enabled: false, backend: 'none' as const, available: false };
  const observability = composeObservability({
    artifactTelemetryAllowed: false,
    featureEnabled: getFeatureFlags(config).observabilityMetrics,
    consent: resolveTelemetryConsent({
      releaseChannel: 'development',
      user: config.telemetry?.user,
      project: config.telemetry?.project,
    }),
  });

  const task = args.task ?? '';
  if (args.command === 'resume') {
    const preparation = dependencies.prepareRuntimeSessionResume(
      args.checkpointPath,
      args.threadId,
    );
    if (preparation !== 'ready') {
      throw new Error('Historical session could not be opened; no new session was created.');
    }
  }
  const skillOptions = skillDirs(args.workspace);
  const initialSkillActivations = args.skills.map((name) => ({
    skillId: `skill:${name}`,
    input: {},
  }));

  const runtimeInput: CliRuntimeAccessInput = {
    sessionId: args.threadId,
    userId: args.userId,
    workspace: args.workspace,
    checkpointPath: args.checkpointPath,
    config,
    shellExecutor,
    gitBroker,
    interactionMode,
    sandboxBackend: effectiveSandboxRuntime.backend,
    skillOptions,
    initialSkillActivations,
    onSessionLoggingStatus: ({ mode }) => {
      console.error(`[SESSION LOGGING] mode=${mode}`);
      if (mode === 'content') {
        console.error(
          '[SESSION LOGGING] Content logging is enabled by the release artifact and explicit user opt-in; reasoning, tool/file content, secrets, and credentials remain excluded.',
        );
      }
    },
    onSessionLoggingDiagnostic: (message) => {
      console.error(`[SESSION LOGGING DISABLED] ${message}`);
    },
  };
  if (args.command === 'server-stdio') {
    if (!dependencies.runRuntimeServerStdio) {
      throw new Error('Runtime stdio Server composition is unavailable.');
    }
    try {
      await dependencies.runRuntimeServerStdio(runtimeInput);
    } finally {
      await observability.bridge.shutdown(250);
    }
    return;
  }
  const access = dependencies.createRuntimeAccess(runtimeInput);
  let iterator: AsyncIterator<RuntimeAccessNotification> | undefined;
  const commandIds = dependencies.commandIds ?? createRuntimeCommandIdAllocator();
  try {
    const createReceipt = await access.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: commandIds.next(),
      type: 'create_session',
      workspace: args.workspace,
      bootstrapSessionId: args.threadId,
    });
    if (createReceipt.status !== 'applied' && createReceipt.status !== 'idempotent_replay') {
      throw new Error(`Runtime session rejected: ${createReceipt.code}`);
    }
    let afterRevision =
      createReceipt.status === 'applied' ? createReceipt.revision : createReceipt.originalRevision;
    const subscription = access.subscribe({
      spec: {
        scope: 'session',
        sessionId: args.threadId,
        afterRevision,
        includeEphemeral: true,
      },
    });
    iterator = subscription[Symbol.asyncIterator]();
    if (args.command === 'resume') {
      const resumeReceipt = await access.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: commandIds.next(),
        type: 'resume_session',
        sessionId: args.threadId,
        afterRevision,
      });
      if (resumeReceipt.status !== 'applied' && resumeReceipt.status !== 'idempotent_replay') {
        throw new Error(`Runtime session resume rejected: ${resumeReceipt.code}`);
      }
      afterRevision =
        resumeReceipt.status === 'applied'
          ? resumeReceipt.revision
          : resumeReceipt.originalRevision;
    }
    const startReceipt = await access.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: commandIds.next(),
      type: 'start_turn',
      sessionId: args.threadId,
      expectedRevision: afterRevision,
      input: task,
    });
    if (startReceipt.status !== 'applied' && startReceipt.status !== 'idempotent_replay') {
      throw new Error(`Runtime turn rejected: ${startReceipt.code}`);
    }

    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const notification = next.value;
      if (!('durability' in notification)) continue;
      const event = projectRuntimeNotificationForCli(notification);
      if (!event) {
        const status =
          notification.durability === 'durable'
            ? notification.projection.session.activeWork?.status
            : undefined;
        if (status && ['completed', 'cancelled', 'failed'].includes(status)) break;
        continue;
      }
      observeRuntimeFact(observability, event, new Date().toISOString());
      console.log(
        JSON.stringify(projectCliRuntimeEvent(event, getFeatureFlags(config).terminalOutcome)),
      );
      const interaction = interactionFromRuntimeNotificationEvent(event);
      if (interaction) {
        const response = await promptForRuntimeInteraction(interaction);
        const receipt = await access.command(
          respondInteractionCommand(commandIds.next(), args.threadId, interaction, response),
        );
        if (receipt.status !== 'applied' && receipt.status !== 'idempotent_replay') {
          throw new Error(`Runtime interaction rejected: ${receipt.code}`);
        }
      }
    }
  } finally {
    await iterator?.return?.();
    await access[Symbol.asyncDispose]?.();
    await observability.bridge.shutdown(250);
  }
}

function interactionFromRuntimeNotificationEvent(
  event: RuntimeNotificationEvent,
): RuntimeClientInteraction | undefined {
  switch (event.type) {
    case 'interaction.available':
    case 'approval.queued':
    case 'input.requested':
    case 'plan.review_requested':
      return event.interaction;
    case 'provider.action':
      return event.status === 'required' ? event.interaction : undefined;
    case 'verification.status':
      return event.status === 'pending' ? event.interaction : undefined;
    default:
      return undefined;
  }
}

async function promptForRuntimeInteraction(
  interaction: RuntimeClientInteraction,
): Promise<RuntimeInteractionResponse> {
  switch (interaction.kind) {
    case 'approval': {
      console.error(`\n[APPROVAL REQUIRED] ${interaction.title ?? 'Runtime operation'}`);
      if (interaction.summary) console.error(interaction.summary);
      console.error(
        interaction.grants.includes('same_command')
          ? 'Type y/yes to approve once, s/same to approve matching commands, or n to reject:'
          : 'Type y/yes to approve once, or n to reject:',
      );
      const value = (await readCliStdin()).toLowerCase();
      return {
        kind: 'approval',
        decision:
          interaction.grants.includes('same_command') &&
          (value === 's' || value === 'same' || value === 'same_command')
            ? 'same_command'
            : value === 'y' || value === 'yes'
              ? 'approve_once'
              : 'reject',
      };
    }
    case 'input': {
      console.error(`\n[QUESTION] ${interaction.question}`);
      interaction.options?.forEach((option, index) => {
        console.error(`  ${index + 1}. ${option.label}`);
      });
      return { kind: 'text', value: await readCliStdin() };
    }
    case 'plan_review': {
      console.error(`\n[PLAN REVIEW] ${interaction.title ?? interaction.plan.planId}`);
      if (interaction.summary) console.error(interaction.summary);
      console.error('Type a/auto, e/accept-edits, f/feedback, or c/cancel:');
      const value = (await readCliStdin()).toLowerCase();
      if (value === 'a' || value === 'auto') {
        return { kind: 'plan_review', decision: 'auto' };
      }
      if (value === 'e' || value === 'accept-edits') {
        return { kind: 'plan_review', decision: 'accept_edits' };
      }
      if (value === 'f' || value === 'feedback') {
        console.error('Enter your feedback:');
        return { kind: 'plan_review', decision: 'feedback', feedback: await readCliStdin() };
      }
      return { kind: 'plan_review', decision: 'cancel' };
    }
    case 'provider_action': {
      console.error(
        `\n[PROVIDER ACTION] ${interaction.provider.providerId} requires ${interaction.action}.`,
      );
      console.error('Type c/completed, d/defer, or x/cancel:');
      const value = (await readCliStdin()).toLowerCase();
      return {
        kind: 'provider_action',
        outcome:
          value === 'c' || value === 'completed'
            ? 'completed'
            : value === 'd' || value === 'defer' || value === 'deferred'
              ? 'deferred'
              : 'cancelled',
      };
    }
    case 'verification': {
      console.error(`\n[VERIFICATION REQUIRED] ${interaction.title ?? 'Verification failed'}`);
      console.error('Type r/replan, w/waive, or c/compensate:');
      const value = (await readCliStdin()).toLowerCase();
      if (value === 'c' || value === 'compensate') {
        return {
          kind: 'verification',
          decision: 'compensate',
          detail: 'Client requested compensation.',
        };
      }
      console.error(
        value === 'w' || value === 'waive'
          ? 'Enter waiver reason:'
          : 'Enter replan/repair instruction:',
      );
      return {
        kind: 'verification',
        decision: value === 'w' || value === 'waive' ? 'waive' : 'replan',
        detail: await readCliStdin(),
      };
    }
  }
}

function respondInteractionCommand(
  commandId: string,
  sessionId: string,
  interaction: RuntimeClientInteraction,
  response: RuntimeInteractionResponse,
): RuntimeCommand {
  const base = {
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId,
    type: 'respond_interaction' as const,
    sessionId,
    expectedRevision: interaction.sessionRevision,
  };
  switch (interaction.kind) {
    case 'approval':
      if (response.kind !== 'approval') throw new Error('Approval response kind changed.');
      return { ...base, interaction, response };
    case 'input':
      if (response.kind !== 'text') throw new Error('Input response kind changed.');
      return { ...base, interaction, response };
    case 'plan_review':
      if (response.kind !== 'plan_review') throw new Error('Plan response kind changed.');
      return { ...base, interaction, response };
    case 'provider_action':
      if (response.kind !== 'provider_action') throw new Error('Provider response kind changed.');
      return { ...base, interaction, response };
    case 'verification':
      if (response.kind !== 'verification') throw new Error('Verification response kind changed.');
      return { ...base, interaction, response };
  }
}

function readCliStdin(): Promise<string> {
  return new Promise((resolveInput) => {
    const { stdin } = process;
    const onData = (chunk: Buffer): void => {
      stdin.removeListener('data', onData);
      resolveInput(chunk.toString().trim());
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

function projectRuntimeNotificationForCli(
  notification: RuntimeAccessNotification,
): RuntimeNotificationEvent | undefined {
  if (!('durability' in notification)) return undefined;
  if (notification.durability === 'durable') return notification.projection.event;
  return notification.event;
}

export function projectCliRuntimeEvent(
  event: RuntimeNotificationEvent,
  terminalOutcomeEnabled = true,
):
  | RuntimeNotificationEvent
  | (RuntimeNotificationEvent & {
      terminalPresentation: ReturnType<typeof projectTerminalOutcome>;
    }) {
  if (terminalOutcomeEnabled && event.type === 'run.terminal' && event.outcome) {
    return {
      ...event,
      terminalPresentation: projectTerminalOutcome(event.outcome),
    };
  }
  return event;
}

// ── Argument parsing (unchanged from original cli.ts) ──

export function parseArgs(argv: string[]): ParsedArgs {
  const command =
    argv[0] === 'sandbox' && argv[1] === 'setup'
      ? 'sandbox-setup'
      : argv[0] === 'sandbox' && argv[1] === 'status'
        ? 'sandbox-status'
        : argv[0] === 'server' && argv[1] === '--stdio'
          ? 'server-stdio'
          : argv[0] === 'resume'
            ? 'resume'
            : argv[0] === 'run'
              ? 'run'
              : argv[0] === 'trace'
                ? 'trace'
                : 'help';
  const cwd = process.cwd();
  const value = (name: string, fallback: string) => {
    const index = argv.indexOf(name);
    const next = index >= 0 ? argv[index + 1] : undefined;
    return next || fallback;
  };
  const optionalValue = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? (argv[index + 1] ?? '') : undefined;
  };
  const noSandbox = argv.includes('--no-sandbox');
  const interactionMode = argv.includes('--full')
    ? 'full'
    : argv.includes('--auto')
      ? 'auto'
      : argv.includes('--ask')
        ? 'accept_edits'
        : undefined;
  const explicitThread = value('--thread', '');
  const answer = optionalValue('--answer');
  const approvalHash = optionalValue('--approval-hash');
  const replacementCommand = optionalValue('--replace-command');
  const approvalGrant = parseApprovalGrant(argv);
  const traceTurnValue = optionalValue('--turn');
  const traceTurn = traceTurnValue === undefined ? undefined : Number(traceTurnValue);
  if (traceTurn !== undefined && (!Number.isSafeInteger(traceTurn) || traceTurn < 1)) {
    throw new Error('--turn must be a positive integer.');
  }

  const multi = (flag: string): string[] => {
    const values: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === flag && i + 1 < argv.length) {
        const val = argv[i + 1];
        if (val !== undefined) values.push(val);
        i++;
      }
    }
    return values;
  };

  const featureOverrides: Partial<FeatureFlags> = {};
  for (const feature of multi('--feature')) {
    const override = parseFeatureOverride(feature);
    if (
      override.executionBoundary === true ||
      override.networkBoundary === true ||
      override.releaseProfile === true ||
      override.observabilityMetrics === true
    ) {
      throw new Error(
        `Feature flag '${feature.split('=', 1)[0]}' is release-controlled and cannot be enabled by the CLI.`,
      );
    }
    Object.assign(featureOverrides, override);
  }
  return {
    command,
    task: command === 'run' || command === 'resume' ? value('--task', positionalTask(argv)) : '',
    threadId:
      explicitThread ||
      (command === 'run' ? freshThreadId() : command === 'server-stdio' ? '' : 'default-thread'),
    userId: value('--user', 'default-user'),
    workspace: resolve(value('--workspace', cwd)),
    checkpointPath: resolve(value('--checkpoints', defaultCheckpointPath())),
    approve: approvalGrant !== undefined,
    approvalGrant,
    approvalHash,
    replacementCommand,
    answer,
    trustWorkspace: argv.includes('--trust-workspace'),
    sandbox: !noSandbox,
    interactionMode,
    skills: multi('--skill'),
    featureOverrides,
    tracePath: command === 'trace' ? argv[1] : undefined,
    traceTurn,
    traceFormat: optionalValue('--format') === 'json' ? 'json' : 'text',
    executionStatus: argv.includes('--execution-status'),
    releaseStatus: argv.includes('--release-status'),
    telemetryStatus: argv.includes('--telemetry-status'),
  };
}

function parseApprovalGrant(argv: string[]): ShellApprovalGrant | undefined {
  if (argv.includes('--approve-same-command')) return 'same_command';
  if (argv.includes('--approve')) return 'approve_once';
  return undefined;
}

function positionalTask(argv: string[]): string {
  if (argv[0] !== 'run' && argv[0] !== 'resume') return '';
  const optionNamesWithValues = new Set([
    '--task',
    '--thread',
    '--user',
    '--workspace',
    '--checkpoints',
    '--answer',
    '--approval-hash',
    '--replace-command',
    '--skill',
    '--feature',
  ]);
  const parts: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const item = argv[index];
    if (item === undefined) continue;
    if (optionNamesWithValues.has(item)) {
      index++;
      continue;
    }
    if (item.startsWith('--')) continue;
    parts.push(item);
  }
  return parts.join(' ').trim();
}

function freshThreadId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function printHelp(): void {
  console.log(`Usage:
  bun run agent run --task "Create hello.txt"
  bun run agent resume --thread default-thread --task "Continue the task"
  bun run agent server --stdio --thread <id> --workspace <path>
  bun run agent sandbox status
  bun run agent sandbox setup

Options:
  --task <text>          Task for run
  trace <events.jsonl>   Replay a runtime trace
  --thread <id>          LangGraph thread id
  --user <id>            User id
  --workspace <path>     Tool workspace
  --checkpoints <path>   SQLite checkpoint path
  --mode <mode>          auto, write, or builder
  --skill <name>         Activate a skill (repeatable)
  --feature <name[=bool]> Temporarily override a registered feature flag (repeatable)
  --execution-status     Print the effective production execution boundary and exit
  --release-status       Print the effective release profile and Gate status and exit
  --telemetry-status     Print redacted telemetry consent/export status and exit
  --turn <n>             Limit trace output to a turn
  --format json          Emit a trace as JSON
  --trust-workspace      Record trust for --workspace and continue (source=config)
  --ask                  Ask before every tool (default)
  --auto                 Auto-review tools, ask when uncertain
  --full           Run with full permissions, never ask
  --no-sandbox           Disable sandbox`);
}
