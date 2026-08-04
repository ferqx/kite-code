import { resolve } from 'node:path';
import { composeObservabilityV1 } from '@/app/observability/composition';
import { resolveTelemetryConsentV1 } from '@/app/observability/consent';
import {
  formatObservabilityStatusV1,
  projectObservabilityStatusV1,
} from '@/app/observability/status';
import { resolveReleaseCompositionV1 } from '@/app/release/composition-root';
import {
  formatExecutionStatusV1,
  formatUnadmittedExecutionStatusV1,
  tryProjectAdmittedExecutionStatusV1,
} from '@/app/release/execution-status';
import { formatReleaseStatusV1, projectReleaseStatusV1 } from '@/app/release/status-projection';
import { composeAppSandboxExecutorV1 } from '@/app/sandbox/composition';
import { type FeatureFlags, getFeatureFlags } from '@/core/config/features';
import { defaultCheckpointPath, loadAgentConfig, parseFeatureOverride } from '@/core/config/index';
import { skillDirs } from '@/core/config/paths';
import { shouldPromptWorkspaceTrust, trustWorkspace } from '@/core/config/workspace-trust';
import { assertAuthorizationElevation } from '@/core/policies/mode-policy';
import type { RuntimeUserAction } from '@/core/runtime/actions';
import { runRuntimeAgent } from '@/core/runtime/agent';
import type { RuntimeEvent } from '@/core/runtime/events';
import type { RuntimeActionProvider } from '@/core/runtime/runner';
import { runtimeStorePathFor } from '@/core/runtime/store';
import { projectTerminalOutcomeV1 } from '@/core/runtime/terminal-outcome';
import { resolveSandboxRuntime } from '@/core/sandbox/index';
import { createRuntimeSecretDetectorV1 } from '@/core/session-logger';
import { filterTraceTurn, formatTrace, parseTraceJsonl } from '@/core/session-logger/replay';
import type { InterruptPayload, UserAction } from '@/protocol/actions';
import type { AgentEvent, ShellApprovalGrant, WorkspaceAccessRequest } from '@/protocol/events';
import type { UserInputProvider } from '@/protocol/provider';
import packageJson from '../../../package.json' with { type: 'json' };

export interface ParsedArgs {
  command: 'run' | 'resume' | 'trace' | 'help';
  task?: string;
  threadId: string;
  userId: string;
  workspace: string;
  checkpointPath: string;
  mode: WorkspaceAccessRequest;
  authorizationMode?: 'default' | 'full_access';
  approve: boolean;
  approvalGrant?: ShellApprovalGrant;
  approvalHash?: string;
  replacementCommand?: string;
  answer?: string;
  trustWorkspace: boolean;
  sandbox: boolean;
  interactionMode?: import('@/protocol/events').InteractionMode;
  skills: string[];
  featureOverrides: Partial<FeatureFlags>;
  tracePath?: string;
  traceTurn?: number;
  traceFormat?: 'text' | 'json';
  executionStatus: boolean;
  releaseStatus: boolean;
  telemetryStatus: boolean;
}

export async function main(): Promise<void> {
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
        formatTrace(records, { turn: args.traceTurn, color: Boolean(process.stdout.isTTY) }),
      );
    }
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
    const decision = trustWorkspace({ workspace: args.workspace, source: 'config' });
    if (decision.status !== 'recorded') {
      throw new Error(`Workspace trust could not be recorded: ${decision.message}`);
    }
  }

  const loadedConfig = loadAgentConfig();
  const config = {
    ...loadedConfig,
    features: { ...loadedConfig.features, ...args.featureOverrides },
  };
  const interactionMode = args.interactionMode ?? config.interactionMode ?? 'accept_edits';
  const sandboxRuntime = resolveSandboxRuntime({
    enabled: args.sandbox && config.sandbox.enabled,
  });
  const executionStatus = tryProjectAdmittedExecutionStatusV1({ config, sandboxRuntime });
  if (args.telemetryStatus) {
    const consent = resolveTelemetryConsentV1({
      releaseChannel: 'development',
      user: config.telemetry?.user,
      project: config.telemetry?.project,
    });
    console.log(
      formatObservabilityStatusV1(
        projectObservabilityStatusV1({
          artifactTelemetryAllowed: false,
          featureEnabled: getFeatureFlags(config).observabilityMetricsV1,
          consent,
          remoteExporterConfigured: false,
        }),
      ),
    );
    return;
  }
  if (args.releaseStatus) {
    const composition = resolveReleaseCompositionV1({
      config,
      artifactReleaseProfileV1Enabled: false,
      profileId: 'internal-dogfood',
      production: false,
    });
    console.log(formatReleaseStatusV1(projectReleaseStatusV1({ composition, executionStatus })));
    return;
  }
  if (args.executionStatus) {
    console.log(
      executionStatus
        ? formatExecutionStatusV1(executionStatus)
        : formatUnadmittedExecutionStatusV1(sandboxRuntime),
    );
    return;
  }
  if (interactionMode === 'full' && !sandboxRuntime.available) {
    throw new Error('full mode requires an available workspace sandbox.');
  }
  const authorizationMode =
    args.authorizationMode ?? (args.approvalGrant === 'full_access' ? 'full_access' : undefined);
  if (authorizationMode) {
    assertAuthorizationElevation({
      mode: authorizationMode,
      source: 'config',
      sandboxAvailable: sandboxRuntime.available,
    });
  }
  const shellExecutor = composeAppSandboxExecutorV1({
    entrypoint: 'foreground_cli',
    workspace: args.workspace,
    config,
    sandboxEnabled: sandboxRuntime.enabled,
  });
  const observability = composeObservabilityV1({
    artifactTelemetryAllowed: false,
    featureEnabled: getFeatureFlags(config).observabilityMetricsV1,
    consent: resolveTelemetryConsentV1({
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

  const provider = createCliRuntimeProvider();
  const generator = runRuntimeAgent(
    {
      task,
      userId: args.userId,
      threadId: args.threadId,
      workspace: args.workspace,
      runtimeStorePath: runtimeStorePathFor(args.checkpointPath),
      config,
      shellExecutor,
      interactionMode,
      authorizationMode,
      authorizationSource: authorizationMode === 'full_access' ? 'config' : undefined,
      sandboxBackend: sandboxRuntime.backend,
      frontend: 'cli',
      sessionLoggingPolicy: config.sessionLoggingPolicy,
      sessionLoggingContentInspector: createRuntimeSecretDetectorV1({
        knownSecrets: [config.apiKey],
      }),
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
      skillOptions,
      initialSkillActivations,
    },
    provider,
  );

  try {
    for await (const event of generator) {
      observability.bridge.observeRuntimeEvent(event, new Date().toISOString());
      console.log(
        JSON.stringify(projectCliRuntimeEventV1(event, getFeatureFlags(config).terminalOutcomeV1)),
      );
    }
  } finally {
    await observability.bridge.shutdown(250);
  }
}

export function projectCliRuntimeEventV1(
  event: RuntimeEvent,
  terminalOutcomeEnabled = true,
):
  | RuntimeEvent
  | (RuntimeEvent & {
      terminalPresentation: ReturnType<typeof projectTerminalOutcomeV1>;
    }) {
  if (
    terminalOutcomeEnabled &&
    (event.type === 'run.completed' || event.type === 'run.error') &&
    event.outcome
  ) {
    return {
      ...event,
      terminalPresentation: projectTerminalOutcomeV1(event.outcome),
    };
  }
  return event;
}

function createCliRuntimeProvider(): RuntimeActionProvider {
  return {
    async requestAction(effect, state): Promise<RuntimeUserAction> {
      if (effect.type === 'request_verification_decision') {
        const record = state.verification.records[effect.verificationId];
        if (!record) throw new Error('Runtime requested a decision for missing verification.');
        console.error(`\n[VERIFICATION REQUIRED] ${record.spec.subject}: ${record.status}`);
        console.error(
          record.spec.compensation
            ? 'Type r/replan, w/waive, or c/compensate:'
            : 'Type r/replan or w/waive:',
        );
        const value = (await readStdin()).trim().toLowerCase();
        if ((value === 'c' || value === 'compensate') && record.spec.compensation) {
          return {
            type: 'request_verification_compensation',
            verificationId: effect.verificationId,
          };
        }
        console.error(
          value === 'w' || value === 'waive'
            ? 'Enter waiver reason:'
            : 'Enter replan/repair instruction:',
        );
        const detail = await readStdin();
        return value === 'w' || value === 'waive'
          ? {
              type: 'waive_verification',
              verificationId: effect.verificationId,
              reason: detail,
            }
          : {
              type: 'replan_verification',
              verificationId: effect.verificationId,
              instruction: detail,
            };
      }
      if (effect.type === 'request_provider_action') {
        console.error(
          `\n[MCP PROVIDER ACTION] ${effect.providerId} requires ${effect.action}. ` +
            'This client does not yet provide an in-process recovery handler; deferring.',
        );
        return {
          type: 'provider_action_result',
          interactionId: effect.interactionId,
          outcome: 'deferred',
        };
      }
      if (effect.type === 'request_provider_admission') {
        console.error(
          `\n[REQUIRED MCP PROVIDER] ${effect.providerId} is ${effect.providerStatus}. ` +
            'This client does not yet provide the required-provider gate; cancelling this run.',
        );
        return {
          type: 'provider_admission_decision',
          interactionId: effect.interactionId,
          decision: { kind: 'cancel' },
        };
      }
      if (state.interactions.kind === 'awaiting_tool_approval') {
        const approval = state.interactions.approval;
        console.error(`\n[APPROVAL REQUIRED] ${approval.tool}: ${approval.command}`);
        console.error(`Risk: ${approval.risk} | ${approval.summary}`);
        console.error('Type y/yes to approve, n to reject, f/full_access for full access:');
        const value = (await readStdin()).toLowerCase();
        if (value === 'f' || value === 'full_access')
          return { type: 'approve', interactionId: effect.interactionId, grant: 'full_access' };
        if (value === 'y' || value === 'yes')
          return { type: 'approve', interactionId: effect.interactionId, grant: 'approve_once' };
        return { type: 'reject', interactionId: effect.interactionId };
      }
      if (state.interactions.kind === 'awaiting_review') {
        const plan = state.interactions.plan;
        console.error(`\n[PLAN REVIEW] ${plan.name}\n${plan.description}`);
        console.error('Type a/auto, e/accept-edits, f/feedback, or c/cancel:');
        const value = (await readStdin()).toLowerCase();
        const review = {
          type: 'plan_review_decision' as const,
          interactionId: effect.interactionId,
          planId: state.interactions.planId,
          version: state.interactions.version,
          structuralDigest: state.interactions.structuralDigest,
        };
        if (value === 'a' || value === 'auto')
          return {
            ...review,
            decision: { kind: 'approve', nextMode: 'auto', clearPlanningContext: false },
          };
        if (value === 'e' || value === 'accept-edits')
          return {
            ...review,
            decision: { kind: 'approve', nextMode: 'accept_edits', clearPlanningContext: false },
          };
        if (value === 'f' || value === 'feedback') {
          console.error('Enter your feedback:');
          return { ...review, decision: { kind: 'revise', feedback: await readStdin() } };
        }
        return { ...review, decision: { kind: 'cancel' } };
      }
      if (state.interactions.kind !== 'awaiting_user_input') {
        throw new Error('Runtime requested input without an input interaction.');
      }
      const request = state.interactions.request;
      console.error(`\n[QUESTION] ${request.question}`);
      request.options.forEach((option, index) => {
        console.error(`  ${index + 1}. ${option.label}`);
      });
      return { type: 'input', interactionId: effect.interactionId, text: await readStdin() };
    },
  };
}

export function createCliProvider(_args: ParsedArgs): UserInputProvider {
  return {
    onEvent(event: AgentEvent) {
      console.log(JSON.stringify(event));
    },
    async requestAction(payload: InterruptPayload): Promise<UserAction> {
      if (payload.kind === 'approval') {
        const a = payload.approval;
        console.error(`\n[APPROVAL REQUIRED] ${a.tool}: ${a.command}`);
        console.error(`Risk: ${a.risk} | ${a.summary}`);
        console.error('Type y/yes to approve, n to reject, f/full_access for full access:');
      } else if (payload.kind === 'input') {
        const q = payload.question;
        console.error(`\n[QUESTION] ${q.question}`);
        if (q.options.length > 0) {
          q.options.forEach((o, i) => {
            console.error(`  ${i + 1}. ${o.label}`);
          });
        }
        console.error('Enter your answer:');
      } else {
        // plan_review
        const p = payload.plan;
        console.error(`\n[PLAN REVIEW] ${p.name}`);
        console.error(p.description);
        if (p.steps.length > 0) {
          p.steps.forEach((s, i) => {
            console.error(`  ${i + 1}. ${s.step} [${s.status}]`);
          });
        }
        console.error('Type a/auto, e/accept-edits, f/feedback, or c/cancel:');
      }

      const data = await readStdin();
      if (payload.kind === 'approval') {
        const lower = data.toLowerCase();
        if (lower === 'f' || lower === 'full_access')
          return { type: 'approve', grant: 'full_access' };
        if (lower === 'y' || lower === 'yes') return { type: 'approve', grant: 'approve_once' };
        return { type: 'reject' };
      }
      if (payload.kind === 'plan_review') {
        const lower = data.toLowerCase();
        if (lower === 'a' || lower === 'auto')
          return {
            type: 'plan_review_decision',
            decision: { kind: 'approve', nextMode: 'auto', clearPlanningContext: false },
          };
        if (lower === 'e' || lower === 'accept-edits')
          return {
            type: 'plan_review_decision',
            decision: { kind: 'approve', nextMode: 'accept_edits', clearPlanningContext: false },
          };
        if (lower === 'f' || lower === 'feedback') {
          console.error('Enter your feedback:');
          const feedback = await readStdin();
          return { type: 'plan_review_decision', decision: { kind: 'revise', feedback } };
        }
        return { type: 'plan_review_decision', decision: { kind: 'cancel' } };
      }
      return { type: 'input', text: data };
    },
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const { stdin } = process;
    const onData = (chunk: Buffer) => {
      stdin.removeListener('data', onData);
      resolve(chunk.toString().trim());
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

// ── Argument parsing (unchanged from original cli.ts) ──

export function parseArgs(argv: string[]): ParsedArgs {
  const command =
    argv[0] === 'resume'
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
  const mode = parseMode(value('--mode', 'auto'));
  const authorizationMode = parseAuthorizationMode(optionalValue('--authorization-mode') ?? '');
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
      override.executionBoundaryV1 === true ||
      override.networkBoundaryV1 === true ||
      override.releaseProfileV1 === true ||
      override.observabilityMetricsV1 === true
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
    mode,
    authorizationMode,
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
  if (argv.includes('--full-access')) return 'full_access';
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
    '--mode',
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

function parseMode(value: string): WorkspaceAccessRequest {
  if (value === 'write' || value === 'builder') return value;
  return 'auto';
}

function parseAuthorizationMode(value: string): 'default' | 'full_access' | undefined {
  if (value === 'full_access' || value === 'full-access') return 'full_access';
  if (value === 'default') return 'default';
  return undefined;
}

function freshThreadId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function printHelp(): void {
  console.log(`Usage:
  bun run agent run --task "Create hello.txt"
  bun run agent resume --thread default-thread --approve

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
  --full-access          Start with full authorization (requires sandbox; source=config)
  --trust-workspace      Record trust for --workspace and continue (source=config)
  --approval-hash <hash> Approval hash
  --replace-command <cmd> Replace pending command
  --answer <text>        Answer user input interrupt
  --authorization-mode <mode>  default or full-access
  --ask                  Ask before every tool (default)
  --auto                 Auto-review tools, ask when uncertain
  --full           Run with full permissions, never ask
  --no-sandbox           Disable sandbox`);
}

if (import.meta.main) {
  if (process.argv.includes('--version')) {
    console.log(`Kite Code ${packageJson.version}`);
    process.exit(0);
  }
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
