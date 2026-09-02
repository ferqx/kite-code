import { resolve } from 'node:path';
import {
  WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import {
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  type LocalRuntimeLifecycleResult,
} from '@kite-ai/kite-local-runtime/client';
import type { KiteServiceManager } from '@kite-ai/kite-local-runtime/manager';
import type { ShellApprovalGrant } from '@kite-ai/runtime-contract';
import {
  RUNTIME_COMMAND_SCHEMA_,
  type RuntimeAccessNotification,
  type RuntimeClientInteraction,
  type RuntimeCommand,
  type RuntimeInteractionResponse,
  type RuntimeNotificationEvent,
} from '@kite-ai/runtime-contract';
import { defaultClientCheckpointPath } from '#kite-cli/preferences';
import {
  acquireKiteServiceModeController,
  connectKiteRuntimeMode,
  createKiteServiceModeSession,
  detachKiteServiceModeController,
  isKiteServiceModeConnection,
  type KiteRuntimeModeConnector,
  type KiteServiceModeControllerLease,
  releaseKiteServiceModeController,
} from '#kite-cli/service-mode';
import { filterTraceTurn, formatTrace, parseTraceJsonl } from '#kite-cli/trace/replay';

interface RuntimeCommandIdAllocator {
  next(): string;
}

function createRuntimeCommandIdAllocator(): RuntimeCommandIdAllocator {
  let next = 0;
  return { next: () => `cli-command-${Date.now().toString(36)}-${++next}` };
}

export interface CliMainDependencies {
  /** Parent-owned local Runtime connector; failures are surfaced without a Service fallback. */
  readonly runtimeConnector?: KiteRuntimeModeConnector;
  /** Narrow lifecycle control supplied by the release composition; never discovered by the CLI. */
  readonly serviceManager?: KiteServiceManager;
  /** Release-selected executable identity used by lifecycle replacement policy. */
  readonly serviceExecutableMode?: 'source' | 'installed';
  readonly appServerDaemon?: {
    start(workspace: string): Promise<Readonly<Record<string, unknown>>>;
    status(): Promise<Readonly<Record<string, unknown>>>;
    stop(): Promise<Readonly<Record<string, unknown>>>;
  };
  /** Ensures the one Service and returns its stable Web root URL. */
  readonly singleServiceWeb?: {
    readonly discover: () => Promise<string>;
  };
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
    | 'server-stdio'
    | 'server-start'
    | 'server-status'
    | 'server-stop'
    | 'service-ensure'
    | 'service-status'
    | 'service-stop'
    | 'service-restart'
    | 'web-open';
  task?: string;
  threadId: string;
  userId: string;
  workspace: string;
  /** Explicit managed Service home forwarded to release composition; the CLI never reads it. */
  kiteHome?: string;
  serverEndpoint?: string;
  checkpointPath: string;
  approve: boolean;
  approvalGrant?: ShellApprovalGrant;
  approvalHash?: string;
  replacementCommand?: string;
  answer?: string;
  trustWorkspace: boolean;
  sandbox: boolean;
  interactionMode?: 'accept_edits' | 'auto' | 'full';
  skills: string[];
  featureOverrides: Readonly<Record<string, boolean>>;
  tracePath?: string;
  traceTurn?: number;
  traceFormat?: 'text' | 'json';
  executionStatus: boolean;
  releaseStatus: boolean;
  telemetryStatus: boolean;
  serviceJson: boolean;
  webJson: boolean;
  serverJson: boolean;
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
    console.log(
      args.traceFormat === 'json'
        ? JSON.stringify(filterTraceTurn(records, args.traceTurn), null, 2)
        : formatTrace(records, {
            turn: args.traceTurn,
            color: Boolean(process.stdout.isTTY),
          }),
    );
    return;
  }
  if (args.command === 'sandbox-status' || args.command === 'sandbox-setup') {
    throw new Error('Sandbox control is owned by the managed Local Runtime Service.');
  }
  if (args.command === 'server-stdio') {
    throw new Error('Runtime stdio is a Service-owned internal entrypoint.');
  }
  if (
    args.command === 'server-start' ||
    args.command === 'server-status' ||
    args.command === 'server-stop'
  ) {
    const daemon = dependencies.appServerDaemon;
    if (!daemon) throw new Error('Explicit App Server daemon control is unavailable.');
    const result =
      args.command === 'server-start'
        ? await daemon.start(args.workspace)
        : args.command === 'server-status'
          ? await daemon.status()
          : await daemon.stop();
    console.log(args.serverJson ? JSON.stringify(result) : formatAppServerDaemonResult(result));
    if (result.state === 'incompatible' || result.state === 'unavailable') {
      throw new Error(`App Server daemon is ${String(result.state)}.`);
    }
    if (args.command === 'server-start' && result.state !== 'ready') {
      throw new Error(`App Server daemon did not start: ${String(result.state)}.`);
    }
    return;
  }
  if (isServiceLifecycleCommand(args.command)) {
    await runServiceLifecycleCommand(
      dependencies.serviceManager,
      args.command,
      args.serviceJson,
      dependencies.singleServiceWeb?.discover,
      dependencies.serviceExecutableMode,
    );
    return;
  }
  if (args.command === 'web-open') {
    if (!dependencies.singleServiceWeb) {
      throw new Error('Kite Web single-Service client is unavailable.');
    }
    await runSingleServiceWebCommand(dependencies.singleServiceWeb.discover, args.webJson);
    return;
  }
  if (args.command === 'resume' && !args.task?.trim()) {
    throw new Error('resume requires --task (or positional task text) to continue the session.');
  }
  if (!dependencies.runtimeConnector) {
    throw new Error('Managed local App Server connector is unavailable.');
  }

  const runtimeMode = await connectKiteRuntimeMode(dependencies.runtimeConnector, {
    workspace: args.workspace,
  });
  const nativeControllerConnection =
    isKiteServiceModeConnection(runtimeMode.connection) && runtimeMode.controller
      ? runtimeMode.connection
      : undefined;
  let iterator: AsyncIterator<RuntimeAccessNotification> | undefined;
  let controllerLease: KiteServiceModeControllerLease | undefined;
  let turnMayHaveStarted = false;
  let turnSettled = false;
  let primaryError: unknown;
  const commandIds = dependencies.commandIds ?? createRuntimeCommandIdAllocator();
  try {
    // Native connectors may intentionally return a prepared connection before
    // the trust gate. Preparation authenticates only the safe App Control
    // routes; Runtime initialize must wait until the Workspace is trusted.
    await runtimeMode.connection.prepareAppControl();
    const trust = await runtimeMode.appControl.queryWorkspaceTrust({
      schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
      workspace: args.workspace,
    });
    let workspace = trust.workspace;
    if (trust.status !== 'trusted') {
      if (!args.trustWorkspace) {
        throw new Error(
          `Workspace is not trusted: ${args.workspace}\n` +
            'Open this folder in the TUI and accept the trust prompt, or pass --trust-workspace.' +
            formatExternalReadScope(trust.externalReadScope.roots),
        );
      }
      const decision = await runtimeMode.appControl.decideWorkspaceTrust({
        schema: WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
        workspace,
        observedStatus: trust.status,
        expectedRevision: trust.revision,
        decision: 'trust',
        externalReadScopeDigest: trust.externalReadScope.digest,
      });
      if (decision.status !== 'trusted') {
        throw new Error('Workspace trust could not be recorded by the local App Server.');
      }
      workspace = decision.workspace;
    }
    // Never issue Runtime commands for an untrusted Workspace. App Server protocol
    // initialization permits App Control only; Runtime mutation waits for this decision.
    await runtimeMode.connection.connect();
    if (args.executionStatus) {
      console.log(
        JSON.stringify(
          await runtimeMode.appControl.getExecutionStatus({
            schema: 'kite.app.execution-status.request.v1',
            workspace,
          }),
          null,
          2,
        ),
      );
      return;
    }
    if (args.releaseStatus) {
      console.log(
        JSON.stringify(
          await runtimeMode.appControl.getReleaseStatus({
            schema: 'kite.app.release-status.request.v1',
          }),
          null,
          2,
        ),
      );
      return;
    }
    if (args.telemetryStatus) {
      const release = await runtimeMode.appControl.getReleaseStatus({
        schema: 'kite.app.release-status.request.v1',
      });
      console.log(JSON.stringify({ telemetry: release.telemetry ?? { allowed: false } }, null, 2));
      return;
    }

    const access = runtimeMode.runtime;
    const sessionId = args.threadId;
    let createdSessionRevision: number | undefined;
    if (nativeControllerConnection) {
      if (args.command === 'resume') {
        controllerLease = await acquireKiteServiceModeController(
          nativeControllerConnection,
          sessionId,
        );
      } else {
        const created = await createKiteServiceModeSession(nativeControllerConnection, sessionId);
        controllerLease = created.lease;
        createdSessionRevision = created.sessionRevision;
      }
    }
    let expectedRevision = 0;
    if (args.command === 'resume') {
      const receipt = await access.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: commandIds.next(),
        type: 'resume_session',
        sessionId,
      });
      if (receipt.status !== 'applied' && receipt.status !== 'idempotent_replay') {
        throw new Error(`Runtime session resume rejected: ${receipt.code}`);
      }
      expectedRevision = receipt.status === 'applied' ? receipt.revision : receipt.originalRevision;
    } else if (createdSessionRevision !== undefined) {
      expectedRevision = createdSessionRevision;
    } else {
      const receipt = await access.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: commandIds.next(),
        type: 'create_session',
        workspace: workspace.canonicalPath,
        bootstrapSessionId: sessionId,
      });
      if (receipt.status !== 'applied' && receipt.status !== 'idempotent_replay') {
        throw new Error(`Runtime session rejected: ${receipt.code}`);
      }
      expectedRevision = receipt.status === 'applied' ? receipt.revision : receipt.originalRevision;
    }
    if (args.interactionMode !== undefined) {
      const modeReceipt = await access.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: commandIds.next(),
        type: 'set_interaction_mode',
        sessionId,
        expectedRevision,
        mode: args.interactionMode,
      });
      if (modeReceipt.status !== 'applied' && modeReceipt.status !== 'idempotent_replay') {
        throw new Error(`Runtime interaction mode rejected: ${modeReceipt.code}`);
      }
      expectedRevision =
        modeReceipt.status === 'applied' ? modeReceipt.revision : modeReceipt.originalRevision;
    }
    const subscription = access.subscribe({
      spec: {
        scope: 'session',
        sessionId,
        afterRevision: expectedRevision,
        includeEphemeral: true,
      },
    });
    iterator = subscription[Symbol.asyncIterator]();
    turnMayHaveStarted = true;
    const startReceipt = await access.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: commandIds.next(),
      type: 'start_turn',
      sessionId,
      expectedRevision,
      input: args.task ?? '',
      ...(args.skills.length === 0
        ? {}
        : {
            initialSkills: args.skills.map((name) => ({
              skillId: `skill:${name}`,
              input: {},
            })),
          }),
    });
    if (startReceipt.status !== 'applied' && startReceipt.status !== 'idempotent_replay') {
      turnMayHaveStarted = false;
      throw new Error(`Runtime turn rejected: ${startReceipt.code}`);
    }

    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const notification = next.value;
      const event = projectRuntimeNotificationForCli(notification);
      if (!event) {
        if (!('durability' in notification)) continue;
        const status =
          notification.durability === 'durable'
            ? notification.projection.session.activeWork?.status
            : undefined;
        if (status && ['completed', 'cancelled', 'failed'].includes(status)) {
          turnSettled = true;
          break;
        }
        continue;
      }
      console.log(JSON.stringify(projectCliRuntimeEvent(event)));
      const interaction = interactionFromRuntimeNotificationEvent(event);
      if (interaction) {
        const response = await promptForRuntimeInteraction(interaction);
        const receipt = await access.command(
          respondInteractionCommand(commandIds.next(), sessionId, interaction, response),
        );
        if (receipt.status !== 'applied' && receipt.status !== 'idempotent_replay') {
          throw new Error(`Runtime interaction rejected: ${receipt.code}`);
        }
      }
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    await iterator?.return?.().catch((error: unknown) => cleanupFailures.push(error));
    if (controllerLease) {
      if (!nativeControllerConnection) {
        cleanupFailures.push(new Error('CLI Controller lease lost its native connection.'));
      }
      const settle =
        nativeControllerConnection && turnMayHaveStarted && !turnSettled
          ? detachKiteServiceModeController(nativeControllerConnection, controllerLease)
          : nativeControllerConnection
            ? releaseKiteServiceModeController(nativeControllerConnection, controllerLease)
            : undefined;
      await settle?.catch((error: unknown) => cleanupFailures.push(error));
    }
    await runtimeMode
      .close('cli_client_closed')
      .catch((error: unknown) => cleanupFailures.push(error));
    await settleCliCleanup(primaryError, cleanupFailures);
  }
}

async function settleCliCleanup(
  primaryError: unknown,
  failures: readonly unknown[],
): Promise<void> {
  if (primaryError !== undefined || failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, 'CLI Controller and connection cleanup failed.');
}

function formatExternalReadScope(roots: readonly string[]): string {
  return roots.length === 0
    ? ''
    : `\nThis workspace also requires read-only access to:\n${roots.map((root) => `  ${root}`).join('\n')}`;
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
      console.error(
        `\n[APPROVAL REQUIRED] ${interaction.command ?? interaction.title ?? 'Runtime operation'}`,
      );
      console.error(
        [
          interaction.grants.includes('approve_once') ? 'y/yes to approve once' : '',
          interaction.grants.includes('same_command') ? 's/same to approve matching commands' : '',
          'n to reject',
        ]
          .filter(Boolean)
          .join(', ')
          .replace(/^/u, 'Type ')
          .concat(':'),
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
        return {
          kind: 'plan_review',
          decision: 'feedback',
          feedback: await readCliStdin(),
        };
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
      terminalPresentation: ClientTerminalOutcomePresentation;
    }) {
  if (terminalOutcomeEnabled && event.type === 'run.terminal' && event.outcome) {
    return {
      ...event,
      terminalPresentation: projectTerminalOutcome(event.outcome),
    };
  }
  return event;
}

interface ClientTerminalOutcome {
  readonly status:
    | 'completed'
    | 'aborted'
    | 'blocked'
    | 'unknown'
    | 'budget_exhausted'
    | 'resource_saturated';
  readonly reasonCode: string;
  readonly safeRetry: boolean;
  readonly recoveryEntry: 'none' | 'retry' | 'reconcile' | 'new_run' | 'operator_action';
}

interface ClientTerminalOutcomePresentation {
  readonly label: string;
  readonly severity: 'success' | 'warning' | 'error';
  readonly complete: boolean;
  readonly safeRetry: boolean;
  readonly recoveryEntry: ClientTerminalOutcome['recoveryEntry'];
}

function projectTerminalOutcome(outcome: ClientTerminalOutcome): ClientTerminalOutcomePresentation {
  if (outcome.status === 'completed') {
    return {
      label: 'Completed',
      severity: 'success',
      complete: true,
      safeRetry: false,
      recoveryEntry: 'none',
    };
  }
  return {
    label: outcome.reasonCode.replaceAll('_', ' '),
    severity: outcome.status === 'unknown' ? 'warning' : 'error',
    complete: false,
    safeRetry: outcome.safeRetry,
    recoveryEntry: outcome.recoveryEntry,
  };
}

type ServiceLifecycleCommand =
  | 'service-ensure'
  | 'service-status'
  | 'service-stop'
  | 'service-restart';

function isServiceLifecycleCommand(
  command: ParsedArgs['command'],
): command is ServiceLifecycleCommand {
  return (
    command === 'service-ensure' ||
    command === 'service-status' ||
    command === 'service-stop' ||
    command === 'service-restart'
  );
}

function serviceOperation(command: ServiceLifecycleCommand): keyof KiteServiceManager {
  switch (command) {
    case 'service-ensure':
      return 'ensure';
    case 'service-status':
      return 'status';
    case 'service-stop':
      return 'stop';
    case 'service-restart':
      return 'restart';
  }
}

/**
 * Render the manager's already validated lifecycle DTO without exposing descriptor/token data in
 * the human-readable form. `--json` is reserved for `service status` and emits one compact JSON
 * object so scripts can consume the exact contract without scraping human text.
 */
export function formatServiceLifecycleResult(
  result: LocalRuntimeLifecycleResult,
  json = false,
): string {
  if (json) return JSON.stringify(result);
  const diagnostic = result.diagnostic === undefined ? '' : ` (${result.diagnostic})`;
  return `Service ${result.operation}: ${result.outcome} [${result.state}]${diagnostic}`;
}

function serviceLifecycleSucceeded(result: LocalRuntimeLifecycleResult): boolean {
  // `status` reports an absent service as an applied observation with `not_running`; every other
  // non-applied result is an operational failure and must produce a non-zero CLI exit.
  return result.outcome === 'applied';
}

async function runServiceLifecycleCommand(
  manager: KiteServiceManager | undefined,
  command: ServiceLifecycleCommand,
  json: boolean,
  discoverWeb?: () => Promise<string>,
  executableMode?: 'source' | 'installed',
): Promise<void> {
  if (!manager) {
    throw new Error('Managed Local Runtime Service lifecycle manager is unavailable.');
  }
  const operation = serviceOperation(command);
  const result = await manager[operation]({
    clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
    ...(executableMode === undefined ? {} : { executableMode }),
  });
  console.log(formatServiceLifecycleResult(result, command === 'service-status' && json));
  if (result.diagnostic !== undefined) {
    console.error(`Service ${result.operation}: ${result.diagnostic}.`);
  }
  if (!serviceLifecycleSucceeded(result)) {
    throw new Error(`Service ${result.operation} failed: ${result.outcome}.`);
  }
  if ((command === 'service-ensure' || command === 'service-restart') && discoverWeb) {
    const url = await discoverWeb();
    console.log(`Kite Web: ${url}`);
  }
}

async function runSingleServiceWebCommand(
  discoverWeb: () => Promise<string>,
  json: boolean,
): Promise<void> {
  const url = await discoverWeb();
  console.log(json ? JSON.stringify({ state: 'ready', url }) : url);
}

function formatAppServerDaemonResult(result: Readonly<Record<string, unknown>>): string {
  const state = typeof result.state === 'string' ? result.state : 'unavailable';
  const endpoint = typeof result.endpoint === 'string' ? ` ${result.endpoint}` : '';
  const build = typeof result.buildId === 'string' ? ` build=${result.buildId}` : '';
  return `App Server: ${state}${endpoint}${build}`;
}

// ── Argument parsing (unchanged from original cli.ts) ──

export function parseArgs(argv: string[]): ParsedArgs {
  const commandArgv = withoutKiteHome(argv);
  const command: ParsedArgs['command'] =
    commandArgv[0] === 'web' &&
    (commandArgv.length === 1 || (commandArgv.length === 2 && commandArgv[1] === '--json'))
      ? 'web-open'
      : commandArgv[0] === 'service' && commandArgv[1] === 'ensure'
        ? 'service-ensure'
        : commandArgv[0] === 'service' && commandArgv[1] === 'status'
          ? 'service-status'
          : commandArgv[0] === 'service' && commandArgv[1] === 'stop'
            ? 'service-stop'
            : commandArgv[0] === 'service' && commandArgv[1] === 'restart'
              ? 'service-restart'
              : commandArgv[0] === 'server' && commandArgv[1] === 'start'
                ? 'server-start'
                : commandArgv[0] === 'server' && commandArgv[1] === 'status'
                  ? 'server-status'
                  : commandArgv[0] === 'server' && commandArgv[1] === 'stop'
                    ? 'server-stop'
                    : commandArgv[0] === 'sandbox' && commandArgv[1] === 'setup'
                      ? 'sandbox-setup'
                      : commandArgv[0] === 'sandbox' && commandArgv[1] === 'status'
                        ? 'sandbox-status'
                        : commandArgv[0] === 'server' && commandArgv[1] === '--stdio'
                          ? 'server-stdio'
                          : commandArgv[0] === 'resume'
                            ? 'resume'
                            : commandArgv[0] === 'run'
                              ? 'run'
                              : commandArgv[0] === 'trace'
                                ? 'trace'
                                : 'help';
  rejectUnsupportedOptions(argv, command);
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
  const modeFlags = ['--ask', '--auto', '--full'].filter((flag) => argv.includes(flag));
  if (modeFlags.length > 1) {
    throw new Error('Choose only one interaction mode: --ask, --auto, or --full.');
  }
  const interactionMode =
    modeFlags[0] === '--full'
      ? 'full'
      : modeFlags[0] === '--auto'
        ? 'auto'
        : modeFlags[0] === '--ask'
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

  const featureOverrides: Record<string, boolean> = {};
  for (const feature of multi('--feature')) {
    const separator = feature.indexOf('=');
    const name = (separator < 0 ? feature : feature.slice(0, separator)).trim();
    const rawValue =
      separator < 0
        ? 'true'
        : feature
            .slice(separator + 1)
            .trim()
            .toLowerCase();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(name) || (rawValue !== 'true' && rawValue !== 'false')) {
      throw new Error(`Invalid feature override: ${feature}`);
    }
    if (
      rawValue === 'true' &&
      (name === 'executionBoundary' ||
        name === 'networkBoundary' ||
        name === 'releaseProfile' ||
        name === 'observabilityMetrics')
    ) {
      throw new Error(
        `Feature flag '${name}' is release-controlled and cannot be enabled by the CLI.`,
      );
    }
    featureOverrides[name] = rawValue === 'true';
  }
  return {
    command,
    task: command === 'run' || command === 'resume' ? value('--task', positionalTask(argv)) : '',
    threadId:
      explicitThread ||
      (command === 'run' ? freshThreadId() : command === 'server-stdio' ? '' : 'default-thread'),
    userId: value('--user', 'default-user'),
    workspace: resolve(value('--workspace', cwd)),
    kiteHome: optionalValue('--kite-home'),
    serverEndpoint: optionalValue('--server'),
    checkpointPath: resolve(value('--checkpoints', defaultClientCheckpointPath())),
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
    serviceJson: command === 'service-status' && argv.includes('--json'),
    webJson: command === 'web-open' && argv.includes('--json'),
    serverJson: command === 'server-status' && argv.includes('--json'),
  };
}

function withoutKiteHome(argv: readonly string[]): string[] {
  const output: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--kite-home') {
      index += 1;
      continue;
    }
    output.push(argv[index]!);
  }
  return output;
}

function parseApprovalGrant(argv: string[]): ShellApprovalGrant | undefined {
  if (argv.includes('--approve-same-command')) return 'same_command';
  if (argv.includes('--approve')) return 'approve_once';
  return undefined;
}

function rejectUnsupportedOptions(argv: readonly string[], command: ParsedArgs['command']): void {
  if (argv.includes('--target-generation')) {
    throw new Error("Unsupported CLI option '--target-generation'.");
  }
  const unsupported = [
    '--checkpoints',
    '--no-sandbox',
    '--feature',
    '--user',
    '--approve',
    '--approve-same-command',
    '--answer',
    '--approval-hash',
    '--replace-command',
    '--full-access',
    '--mode',
  ];
  for (const argument of argv) {
    const name = argument.split('=', 1)[0];
    if (unsupported.includes(name ?? '')) {
      throw new Error(`Unsupported CLI option '${name}' after the Local Runtime Service cutover.`);
    }
  }
  if (argv.some((argument) => ['--ask', '--auto', '--full'].includes(argument))) {
    if (command !== 'run' && command !== 'resume') {
      throw new Error('Interaction mode flags are supported only by run and resume.');
    }
  }
  const serverFlags = argv.flatMap((value, index) => (value === '--server' ? [index] : []));
  if (serverFlags.length > 1 || (serverFlags.length === 1 && !argv[serverFlags[0]! + 1])) {
    throw new Error('--server requires exactly one explicit endpoint.');
  }
  if (
    serverFlags.length === 1 &&
    command !== 'run' &&
    command !== 'resume' &&
    command !== 'server-start' &&
    command !== 'server-status' &&
    command !== 'server-stop'
  ) {
    throw new Error('--server is supported only by Runtime and server lifecycle commands.');
  }
  if (
    argv.includes('--json') &&
    command !== 'service-status' &&
    command !== 'server-status' &&
    command !== 'web-open'
  ) {
    throw new Error('The --json option is unsupported for this command.');
  }
}

function positionalTask(argv: string[]): string {
  if (argv[0] !== 'run' && argv[0] !== 'resume') return '';
  const optionNamesWithValues = new Set([
    '--task',
    '--thread',
    '--user',
    '--workspace',
    '--kite-home',
    '--checkpoints',
    '--answer',
    '--approval-hash',
    '--replace-command',
    '--skill',
    '--feature',
    '--server',
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
  bun run agent server start [--server <endpoint>]
  bun run agent server status [--server <endpoint>] [--json]
  bun run agent server stop [--server <endpoint>]
  bun run agent service ensure
  bun run agent service status [--json]
  bun run agent service stop
  bun run agent service restart
  bun run agent web [--json]
  bun run agent server --stdio --thread <id> --workspace <path>
  bun run agent sandbox status
  bun run agent sandbox setup

Options:
  --task <text>          Task for run
  trace <events.jsonl>   Replay a runtime trace
  --thread <id>          LangGraph thread id
  --workspace <path>     Tool workspace
  --kite-home <path>     Advanced: explicit managed Service home (validated by release composition)
  --server <endpoint>    Explicit App Server Unix socket or Windows named pipe; never auto-discovered
  --skill <name>         Activate a skill (repeatable)
  --execution-status     Print the effective production execution boundary and exit
  --release-status       Print the effective release profile and Gate status and exit
  --telemetry-status     Print redacted telemetry consent/export status and exit
  --json                 Emit a closed JSON result for server/service status or Web ensure/status
  --turn <n>             Limit trace output to a turn
  --format json          Emit a trace as JSON
  --trust-workspace      Record trust for --workspace and continue (source=config)
  --ask                  Ask before every tool (default)
  --auto                 Auto-review tools, ask when uncertain
  --full                 Run with full permissions, never ask`);
}
