import { resolve } from 'node:path';
import {
  discoverSandboxBackendCandidate,
  resolveSandboxRuntime,
  resolveWindowsManagedNetworkSetupStatus,
  setupWindowsManagedNetwork,
} from '@kite/builtin-runtime/sandbox';
import type { InteractionMode, ShellApprovalGrant } from '@kite/runtime-contract';
import {
  RUNTIME_COMMAND_SCHEMA_,
  type RuntimeAccess,
  type RuntimeNotification,
  type RuntimeNotificationEvent,
} from '@kite/runtime-contract';
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
  readonly createRuntimeAccess: (
    input: CliRuntimeAccessInput,
  ) => RuntimeAccess & Partial<AsyncDisposable>;
}

export interface ParsedArgs {
  command: 'run' | 'resume' | 'trace' | 'help' | 'sandbox-setup' | 'sandbox-status';
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
  interactionMode?: import('@kite/runtime-contract').InteractionMode;
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
  if (args.command === 'resume') {
    throw new Error(
      'Legacy checkpoint sessions are not compatible with the Runtime Kernel. Start a new task.',
    );
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
  const skillOptions = skillDirs(args.workspace);
  const initialSkillActivations = args.skills.map((name) => ({
    skillId: `skill:${name}`,
    input: {},
  }));

  const access = dependencies.createRuntimeAccess({
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
  });
  let iterator: AsyncIterator<RuntimeNotification> | undefined;
  try {
    const createReceipt = await access.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: `cli-create:${args.threadId}`,
      type: 'create_session',
      workspace: args.workspace,
      bootstrapSessionId: args.threadId,
    });
    if (createReceipt.status !== 'applied' && createReceipt.status !== 'idempotent_replay') {
      throw new Error(`Runtime session rejected: ${createReceipt.code}`);
    }
    const afterRevision =
      createReceipt.status === 'applied' ? createReceipt.revision : createReceipt.originalRevision;
    const subscription = access.subscribe({ sessionId: args.threadId, afterRevision });
    iterator = subscription[Symbol.asyncIterator]();
    const startReceipt = await access.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: `cli-turn:${args.threadId}:1`,
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
    }
  } finally {
    await iterator?.return?.();
    await access[Symbol.asyncDispose]?.();
    await observability.bridge.shutdown(250);
  }
}

function projectRuntimeNotificationForCli(
  notification: RuntimeNotification,
): RuntimeNotificationEvent | undefined {
  if (notification.durability === 'durable') return notification.projection.event;
  const payload = notification.payload;
  if (payload.type === 'model_delta') return { type: 'model.text_delta', text: payload.text };
  if (payload.type === 'reasoning_delta') {
    return { type: 'model.reasoning_delta', text: payload.text };
  }
  return {
    type: 'tool.progress',
    toolCallId: payload.toolId,
    chunk: payload.summary ?? '',
    stream: payload.stream ?? 'stdout',
    lineCount: payload.lineCount,
  };
}

export function projectCliRuntimeEvent(
  event: RuntimeNotificationEvent,
  terminalOutcomeEnabled = true,
):
  | RuntimeNotificationEvent
  | (RuntimeNotificationEvent & {
      terminalPresentation: ReturnType<typeof projectTerminalOutcome>;
    }) {
  if (
    terminalOutcomeEnabled &&
    (event.type === 'run.completed' || event.type === 'run.error') &&
    event.outcome
  ) {
    return {
      ...event,
      terminalPresentation: projectTerminalOutcome(
        event.outcome as Parameters<typeof projectTerminalOutcome>[0],
      ),
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
    task: command === 'run' ? value('--task', positionalTask(argv)) : '',
    threadId: explicitThread || (command === 'run' ? freshThreadId() : 'default-thread'),
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
  if (argv[0] !== 'run') return '';
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
  bun run agent resume --thread default-thread --approve
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
  --approve              Approve tool call on resume
  --approve-same-command Approve same future commands
  --trust-workspace      Record trust for --workspace and continue (source=config)
  --approval-hash <hash> Approval hash
  --replace-command <cmd> Replace pending command
  --answer <text>        Answer user input interrupt
  --ask                  Ask before every tool (default)
  --auto                 Auto-review tools, ask when uncertain
  --full           Run with full permissions, never ask
  --no-sandbox           Disable sandbox`);
}
