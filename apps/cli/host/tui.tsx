import { selectProfile } from '@kite-ai/agent/profile';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { ClientError, type Interaction, type Message } from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';
import { TuiController, type TuiPort, TuiSession, translateTuiLabel } from '@kite-ai/ui/tui';
import { Box, render, Text, useInput } from 'ink';
import { useState, useSyncExternalStore } from 'react';
import {
  type ContextOutcome,
  getCompleteContext,
  includeHistoricalResult,
  lookupContextOutcome,
  rewindContext,
} from '../src/context';
import {
  clearPermissionGrants,
  getPermissionGrants,
  getPermissionMode,
  getWorkspaceTrust,
  lookupPermissionOutcome,
  setPermissionMode,
  setWorkspaceTrust,
} from '../src/permissions';
import { lookupRecovery, submitRecovery } from '../src/recovery';
import { lookupManagementOutcome, submitManagement } from '../src/session-management';
import { openCallerJournal } from './caller-journal';
import { createTuiCallerPort } from './caller-port';
import { createTuiFileCandidates } from './file-candidates';
import { createFileRecoveryPort } from './file-recovery';
import { openFileRecoveryJournal } from './file-recovery-intents';
import {
  CLIHostError,
  type CLIServiceArtifact,
  ensureSession,
  parseCLIServiceArtifact,
  verifyArtifact,
} from './index';
import { openMcpConnectionJournal } from './mcp-connection-journal';
import { openMcpReconnectionJournal } from './mcp-reconnection-journal';
import { openMcpSelectionJournal } from './mcp-selection-journal';
import { openMcpSourceApprovalJournal } from './mcp-source-approval-journal';
import { openMcpSourceMutationJournal } from './mcp-source-mutation-journal';
import { openRecoveryJournal } from './recovery-journal';
import { connectSharedService } from './shared-service';
import { createTuiDraftPort } from './tui-draft-port';
import { openTuiDraftFile } from './tui-drafts';
import { createTuiExporter } from './tui-export';
import { createTuiMcpPort } from './tui-mcp';
import { createTuiMcpAuthPort } from './tui-mcp-auth';
import { prepareTuiObservationStart } from './tui-observation';
import { openTuiPreferenceFile } from './tui-preferences';

export { parseTUIArguments, type TUIArguments } from './tui-arguments';

function TerminalHost({
  controller,
  onNew,
  onQuit,
  shared,
}: {
  controller: TuiController;
  onNew: () => Promise<string>;
  onQuit: () => void;
  shared: boolean;
}) {
  const state = useSyncExternalStore(controller.subscribe, () => controller.state);
  const [notice, setNotice] = useState('');
  const t = (label: string) => translateTuiLabel(label, state.preferences.resolvedLanguage);
  const original =
    /^Original Session creation unknown: ([A-Za-z0-9_-]+)(; Ctrl\+N reads this ID only)?$/.exec(
      notice,
    );
  const shownNotice = original
    ? `${t('Original Session creation unknown:')} ${original[1]}${original[2] ? t(original[2]) : ''}`
    : t(notice);
  useInput((input, key) => {
    if (key.ctrl && input === 'n') void onNew().then(setNotice);
    if (key.ctrl && input === 'q') onQuit();
  });
  return (
    <Box flexDirection="column">
      <Text>
        {t('Development TUI · Ctrl+N new Workspace Session · Ctrl+Q')}{' '}
        {shared ? t('disconnect shared service') : t('quit owned host')}
      </Text>
      <TuiSession controller={controller} />
      {notice && <Text>{shownNotice}</Text>}
      {state.intent?.phase === 'unknown' && (
        <Text>{t('Original outcome unknown: Ctrl+K only reads original Command')}</Text>
      )}
    </Box>
  );
}
/** Fixed admitted Client seam; model writes and original outcome reads retain identical scope. */
export function createTuiModelPort(
  client: Pick<
    import('@kite-ai/client').AgentClient,
    'getModelSettings' | 'updateModelSettings' | 'getHostMutation'
  >,
  storeId: string,
): import('@kite-ai/ui/tui').TuiModelPort {
  return {
    read: (workspaceId, signal) =>
      client.getModelSettings('workspace', { storeId, workspaceId, signal }),
    async submit(intent) {
      try {
        const mutation = await client.updateModelSettings(intent.scope, intent.request);
        return { intent, status: mutation.state, mutation };
      } catch (error) {
        return {
          intent,
          status:
            error instanceof ClientError &&
            error.status !== undefined &&
            error.status >= 400 &&
            error.status < 500 &&
            error.code !== 'mutation_incomplete'
              ? ('failed' as const)
              : ('outcome_unknown' as const),
        };
      }
    },
    async lookup(intent) {
      const mutation = await client.getHostMutation(intent.request.commandId, {
        storeId: intent.request.expectedStoreId,
      });
      const marker = mutation.modelSettings,
        expected = intent.request;
      if (
        mutation.kind !== 'model_settings.update' ||
        mutation.scope !== intent.scope ||
        mutation.workspaceId !== expected.workspaceId ||
        mutation.ifMatch !== expected.expectedReadSet.workspaceEtag ||
        !marker ||
        ['userEtag', 'workspaceEtag', 'explicitDigest', 'effectiveDigest'].some(
          (key) =>
            marker.expectedReadSet[key as keyof typeof marker.expectedReadSet] !==
            expected.expectedReadSet[key as keyof typeof expected.expectedReadSet],
        ) ||
        marker.operation.kind !== expected.operation.kind ||
        marker.operation.modelId !== expected.operation.modelId ||
        (marker.operation.kind === 'enabled' &&
          (expected.operation.kind !== 'enabled' ||
            marker.operation.enabled !== expected.operation.enabled)) ||
        (marker.operation.kind === 'effort' &&
          (expected.operation.kind !== 'effort' ||
            marker.operation.reasoningEffort !== expected.operation.reasoningEffort))
      )
        throw new CLIHostError('model_settings_scope_mismatch');
      return { intent, status: mutation.state, mutation };
    },
  };
}
export interface TUIHostOptions {
  artifact?: CLIServiceArtifact;
  server?: string;
  dataRoot: string;
  profile?: string;
  workspace?: string;
  thread?: string;
  cwd?: string;
  exitSignal?: AbortSignal;
  /** Private host test hook, never stdout bootstrap or public token. */
  onLaunched?: (value: { pid: number }) => void;
}
/** Native composition only; no Loop or Provider implementation. */
export async function runTUIHost(input: TUIHostOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new CLIHostError('tui_terminal_unavailable');
  input.exitSignal?.throwIfAborted();
  const profile = selectProfile({
    dataRoot: input.dataRoot,
    profile: input.profile ?? 'development',
  });
  let access: ReturnType<typeof acquireProfileAccess> | undefined;
  let paired: Awaited<ReturnType<typeof launchPairedService>> | undefined;
  let connection:
    | Awaited<ReturnType<typeof launchPairedService>>
    | Awaited<ReturnType<typeof connectSharedService>>
    | undefined;
  try {
    if (input.server) {
      connection = await connectSharedService({
        profile,
        server: input.server,
        requiredCapabilities: ['sessions', 'commands', 'history', 'events', 'interactions'],
        workspace: input.workspace,
        cwd: input.cwd,
        signal: input.exitSignal,
      });
      access = acquireProfileAccess(profile);
    } else {
      const artifact = parseCLIServiceArtifact(input.artifact);
      verifyArtifact(artifact.entrypoint, artifact.entrypointSha256, false);
      verifyArtifact(artifact.executable, artifact.executableSha256, true);
      access = acquireProfileAccess(profile);
      paired = await launchPairedService({
        profile,
        entrypoint: artifact.entrypoint,
        executable: artifact.executable,
        buildId: artifact.buildId,
        ...(artifact.runtimeProtection ? { runtimeProtection: artifact.runtimeProtection } : {}),
        instanceId: crypto.randomUUID(),
        apiMajor: artifact.apiMajor,
        requiredCapabilities: ['sessions', 'commands', 'history', 'events', 'interactions'],
      });
      connection = paired;
    }
  } catch (error) {
    await connection?.close();
    access?.lock.release();
    throw error;
  }
  const profileAccess = access;
  const workspace = 'fixedWorkspace' in connection ? connection.fixedWorkspace : input.workspace;
  let controller: TuiController | undefined, terminal: ReturnType<typeof render> | undefined;
  let fileRecoveryOwner: ReturnType<typeof openFileRecoveryJournal> | undefined;
  let mcpOwner: ReturnType<typeof openMcpSelectionJournal> | undefined;
  let mcpConnectionOwner: ReturnType<typeof openMcpConnectionJournal> | undefined;
  let mcpReconnectionOwner: ReturnType<typeof openMcpReconnectionJournal> | undefined;
  let mcpSourceMutationOwner: ReturnType<typeof openMcpSourceMutationJournal> | undefined;
  let mcpSourceApprovalOwner: ReturnType<typeof openMcpSourceApprovalJournal> | undefined;
  let callerOwner: ReturnType<typeof openCallerJournal> | undefined;
  let recoveryOwner: ReturnType<typeof openRecoveryJournal> | undefined;
  let draftOwner: ReturnType<typeof createTuiDraftPort> | undefined;
  let preferenceOwner: ReturnType<typeof openTuiPreferenceFile> | undefined;
  const observer = new AbortController();
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  let ended = false,
    newBusy = false,
    refreshing = false,
    refreshAgain = false;
  const endInput = () => {
    if (ended) return;
    ended = true;
    draftOwner?.flush();
    observer.abort();
    controller?.dispose();
    try {
      terminal?.unmount();
    } catch {}
    terminal = undefined;
    process.stdin.pause();
    if (input.server) stop();
  };
  const requestQuit = () => {
    if (draftOwner && !draftOwner.flush()) {
      controller?.draftUnavailable('tui_draft_save_failed_exit_blocked');
      return;
    }
    stop();
  };
  const onExit = () => stop();
  input.exitSignal?.addEventListener('abort', onExit, { once: true });
  process.stdin.once('end', endInput);
  process.stdin.once('error', endInput);
  // A PTY master close sends SIGHUP; it is input loss, not an explicit host quit.
  process.on('SIGHUP', endInput);
  process.stdout.on('error', endInput);
  process.stderr.on('error', endInput);
  try {
    input.exitSignal?.throwIfAborted();
    if (paired) input.onLaunched?.({ pid: paired.pid });
    const { client, bootstrap } = connection;
    if (bootstrap.dataAvailability !== 'available') throw new CLIHostError('data_unavailable');
    const storeId = bootstrap.storeId;
    const initial = await ensureSession(
      {
        kind: input.thread ? 'resume' : 'run',
        task: 'TUI Session',
        ...(input.thread ? { thread: input.thread } : {}),
        ...(workspace ? { workspace } : {}),
        trustWorkspace: false,
        skills: [],
      },
      client,
      storeId,
      input.cwd ?? process.cwd(),
      () => {},
    );
    const workspaceId = initial.workspace.id;
    const contextOutcomes = new Map<string, ContextOutcome>();
    fileRecoveryOwner = openFileRecoveryJournal({
      access: profileAccess,
      acquireWriteLock: () => acquireProfileDataLock(profileAccess, 'tui_private'),
    });
    recoveryOwner = openRecoveryJournal({
      access: profileAccess,
      acquireWriteLock: () => acquireProfileDataLock(profileAccess, 'tui_private'),
    });
    draftOwner = createTuiDraftPort({
      file: openTuiDraftFile({
        access: profileAccess,
        acquireWriteLock: () => acquireProfileDataLock(profileAccess, 'tui_private'),
      }),
      notify: (code) => controller?.draftUnavailable(code),
      association: async (row) => {
        if (row.storeId !== storeId) return 'unavailable';
        try {
          const view = await client.getView(row.sessionId);
          return view.storeId === row.storeId &&
            view.session.id === row.sessionId &&
            view.session.workspaceId === row.workspaceId &&
            view.session.deletedAt === null
            ? 'current'
            : 'unavailable';
        } catch {
          return 'unavailable';
        }
      },
    });
    preferenceOwner = openTuiPreferenceFile({ access: profileAccess });
    const preferences = preferenceOwner;
    callerOwner = openCallerJournal({
      access: profileAccess,
      acquireWriteLock: () => acquireProfileDataLock(profileAccess, 'tui_private'),
    });
    mcpOwner = openMcpSelectionJournal({
      access: profileAccess,
      acquireWriteLock: () => acquireProfileDataLock(profileAccess, 'tui_private'),
    });
    mcpConnectionOwner = openMcpConnectionJournal({
      access: profileAccess,
      acquireWriteLock: () => acquireProfileDataLock(profileAccess, 'tui_private'),
    });
    mcpReconnectionOwner = openMcpReconnectionJournal({
      access: profileAccess,
      acquireWriteLock: () => acquireProfileDataLock(profileAccess, 'tui_private'),
    });
    mcpSourceApprovalOwner = openMcpSourceApprovalJournal({
      access: profileAccess,
      acquireWriteLock: () => acquireProfileDataLock(profileAccess, 'tui_private'),
    });
    mcpSourceMutationOwner = openMcpSourceMutationJournal({
      access: profileAccess,
      acquireWriteLock: () => acquireProfileDataLock(profileAccess, 'tui_private'),
    });
    const port: TuiPort = {
      preferences: {
        async read() {
          return preferences.read();
        },
        async save(edit) {
          return preferences.save(edit);
        },
      },
      skills: {
        workflowActivation: ['skill_workflow_catalogue', 'run_extension_inputs'].every(
          (capability) => client.serverInfo?.capabilities.includes(capability),
        ),
        read: (_sessionId, workspaceId, signal) =>
          client.listAllSkills(workspaceId, {
            storeId,
            signal,
            ...(['skill_workflow_catalogue', 'run_extension_inputs'].every((capability) =>
              client.serverInfo?.capabilities.includes(capability),
            )
              ? { workflow: 'manual' as const }
              : {}),
          }),
      },
      status: {
        mode: input.server ? 'shared' : 'paired',
        profile: bootstrap.profile.name,
        async read(sessionId, workspaceId, signal) {
          const facts = await client.getHostStatus({ sessionId, workspaceId, signal });
          if (
            facts.identity.profileAccessKey !== profile.profileAccessKey ||
            facts.identity.instanceId !== bootstrap.instanceId ||
            facts.identity.buildId !== bootstrap.buildId ||
            facts.identity.apiMajor !== bootstrap.apiMajor ||
            facts.identity.storeId !== storeId
          )
            throw new CLIHostError('host_status_identity_mismatch');
          return facts;
        },
      },
      drafts: draftOwner.port,
      callers: createTuiCallerPort({
        client,
        storeId,
        journal: callerOwner!,
        drafts: draftOwner.port,
      }),
      fileCandidates: createTuiFileCandidates(client, storeId),
      storeId,
      mcp: createTuiMcpPort(
        client,
        storeId,
        mcpOwner,
        mcpConnectionOwner,
        mcpSourceApprovalOwner,
        mcpReconnectionOwner,
        mcpSourceMutationOwner,
      ),
      exportLoadedText: createTuiExporter(profile.profilePath, storeId),
      recovery: {
        restore: async () =>
          recoveryOwner!
            .list()
            .filter((row) => ['submitting', 'accepted', 'outcome_unknown'].includes(row.phase))
            .map((row) => ({ intent: row.intent, status: 'outcome_unknown' as const })),
        submit: (intent, signal) =>
          submitRecovery(intent, { client, signal, journal: recoveryOwner }),
        lookup: (intent, signal) =>
          lookupRecovery(intent, { client, signal, journal: recoveryOwner }),
      },
      fileRecovery: createFileRecoveryPort({ client, journal: fileRecoveryOwner! }),
      management: {
        async readSessionControl(sessionId, signal) {
          const view = await client.getView(sessionId, { signal });
          if (view.session.workspaceId !== workspaceId)
            throw new CLIHostError('management_scope_unavailable');
          return { storeId: view.storeId, session: view.session };
        },
        readContext: (sessionId, contextSelectionId, signal) =>
          getCompleteContext(
            sessionId,
            { storeId, contextSelectionId },
            { client, write: () => {}, signal },
          ),
        manage: async (intent) => {
          if (intent.kind === 'context.select') {
            const result = await rewindContext(intent.sessionId, intent.request, {
              client,
              write: () => {},
            });
            contextOutcomes.set(intent.request.commandId, result);
            return { intent, status: result.status, command: result.command };
          }
          if (intent.kind === 'result.include') {
            const result = await includeHistoricalResult(
              intent.sessionId,
              intent.executionId,
              intent.request,
              { client, write: () => {} },
            );
            contextOutcomes.set(intent.request.commandId, result);
            return { intent, status: result.status, command: result.command };
          }
          const result = await submitManagement(intent, { client, write: () => {} });
          return { ...result, intent };
        },
        lookup: async (intent) => {
          if (intent.kind === 'context.select' || intent.kind === 'result.include') {
            const saved = contextOutcomes.get(intent.request.commandId);
            if (!saved) return { intent, status: 'outcome_unknown' };
            const result = await lookupContextOutcome(saved, { client, write: () => {} });
            contextOutcomes.set(intent.request.commandId, result);
            return { intent, status: result.status, command: result.command };
          }
          return {
            ...(await lookupManagementOutcome(intent, { client, write: () => {} })),
            intent,
          };
        },
        newSession: async () => {
          const notice = await createNew();
          if (pendingNew || notice === 'Session creation unavailable')
            throw new CLIHostError('session_creation_unknown');
          return controller!.state.sessionId!;
        },
        quit: requestQuit,
      },
      models: createTuiModelPort(client, storeId),
      permissions: {
        async read(sessionId, workspaceId, signal) {
          const options = { client, write: () => {}, signal };
          const [mode, trust, result] = await Promise.all([
            getPermissionMode(sessionId, storeId, options),
            getWorkspaceTrust(workspaceId, storeId, options),
            getPermissionGrants(sessionId, storeId, options),
          ]);
          return { mode, trust, grants: result.page };
        },
        async submit(intent) {
          const options = { client, write: () => {} };
          const result =
            intent.kind === 'permission.mode'
              ? await setPermissionMode(intent.sessionId, intent.request, options)
              : intent.kind === 'workspace.trust'
                ? await setWorkspaceTrust(intent.workspaceId, intent.request, options)
                : await clearPermissionGrants(intent.sessionId, intent.request, options);
          return {
            intent,
            status: result.status === 'not_submitted' ? 'outcome_unknown' : result.status,
            mutation: result.mutation,
          };
        },
        async lookup(intent) {
          const result = await lookupPermissionOutcome(intent, { client, write: () => {} });
          return {
            intent,
            status: result.status === 'not_submitted' ? 'outcome_unknown' : result.status,
            mutation: result.mutation,
          };
        },
      },
      nextCommandId: () => crypto.randomUUID(),
      executions: {
        getExecution: (id, signal) => client.getExecution(id, { signal }),
        getRun: (id, signal) => client.getRun(id, { signal }),
        output: (id, query, signal) => client.listExecutionOutput(id, { ...query, signal }),
        getView: (id, signal) => client.getView(id, { signal }),
        messages: (id, query, signal) => client.listMessages(id, { ...query, signal }),
        modelOutput: (id, executionId, signal) =>
          client.getModelOutput(id, executionId, { expectedStoreId: storeId, signal }),
        stop: (id, request) => client.cancelExecution(id, request),
        getCommand: (id, signal) => client.getCommand(id, { signal }),
      },
      listSessions: (signal) => client.listAllSessions({ workspaceId, signal }),
      async readSession(sessionId, signal) {
        const view = await client.getView(sessionId, { signal });
        if (view.session.workspaceId !== workspaceId)
          throw new CLIHostError('workspace_identity_mismatch');
        const messages: Message[] = [],
          interactions: Interaction[] = [];
        let afterSeq = '0';
        for (;;) {
          const page = await client.listMessages(sessionId, {
            afterSeq,
            upperSeq: view.session.nextSeq,
            limit: 200,
            signal,
          });
          for (const message of page) {
            if (
              message.sessionId !== sessionId ||
              BigInt(message.seq) <= BigInt(afterSeq) ||
              BigInt(message.seq) > BigInt(view.session.nextSeq)
            )
              throw new CLIHostError('history_identity_mismatch');
            messages.push(message);
            afterSeq = message.seq;
          }
          if (page.length < 200) break;
        }
        let afterId: string | undefined;
        for (;;) {
          const page = await client.listInteractions(
            sessionId,
            { storeId, limit: 100, ...(afterId ? { afterId } : {}) },
            { signal },
          );
          interactions.push(...page.interactions);
          if (!page.nextAfterId) break;
          if (page.nextAfterId === afterId) throw new CLIHostError('interaction_cursor_invalid');
          afterId = page.nextAfterId;
        }
        const active = view.runs.find((run) => run.isActive);
        const activeCommand = active
          ? await client.getCommand(active.originCommandId, { signal })
          : undefined;
        if (
          activeCommand &&
          (activeCommand.originStoreId !== storeId ||
            activeCommand.sessionId !== sessionId ||
            activeCommand.id !== active!.originCommandId)
        )
          throw new CLIHostError('active_command_identity_mismatch');
        return {
          storeId,
          view,
          messages,
          interactions,
          ...(activeCommand ? { activeCommand } : {}),
        };
      },
      readModelOutput: (sessionId, executionId, signal) =>
        client.getModelOutput(sessionId, executionId, { signal }),
      readAttachment: async (card, signal) =>
        (await client.readInteractionAttachment(card, { signal })).text,
      submit: (sessionId, intent) =>
        intent.kind === 'run.start'
          ? client.startRun(sessionId, intent)
          : intent.kind === 'input.follow_up'
            ? client.followUp(sessionId, intent)
            : client.steer(sessionId, intent),
      answer: (sessionId, interactionId, intent) =>
        client.answerInteraction(sessionId, interactionId, intent),
      cancel: (sessionId, intent) => client.cancelCommand(sessionId, intent),
      getCommand: async (commandId, sessionId) => {
        const command = await client.getCommand(commandId);
        if (command.originStoreId !== storeId || command.sessionId !== sessionId)
          throw new CLIHostError('command_identity_mismatch');
        return command;
      },
    };
    if (port.callers && port.mcp?.source)
      port.mcpAuth = createTuiMcpAuthPort({
        client,
        storeId,
        callers: port.callers,
        sources: port.mcp.source,
      });
    controller = new TuiController(port);
    await controller.restoreCallers();
    await controller.select(initial.session.id);
    let pendingNew: { commandId: string; sessionId: string } | undefined;
    const createNew = async (): Promise<string> => {
      if (newBusy || ended) return 'Session creation already in progress';
      newBusy = true;
      const sourceSessionId = controller!.state.sessionId;
      try {
        if (pendingNew) {
          const original = await client.getCommand(pendingNew.commandId);
          if (
            original.id !== pendingNew.commandId ||
            original.sessionId !== pendingNew.sessionId ||
            original.originStoreId !== storeId ||
            original.kind !== 'session.create'
          )
            throw new CLIHostError('session_identity_mismatch');
          if (original.status === 'rejected') {
            pendingNew = undefined;
            return 'Original Session creation rejected';
          }
          if (original.status !== 'applied')
            return `Original Session creation unknown: ${pendingNew.commandId}`;
          const session = (await client.listAllSessions({ workspaceId })).find(
            (item) => item.id === pendingNew!.sessionId,
          );
          if (!session) throw new CLIHostError('session_outcome_unknown');
          pendingNew = undefined;
          if (!ended && controller!.state.sessionId === sourceSessionId) {
            await controller!.list();
            if (controller!.state.sessionId === sourceSessionId)
              await controller!.select(session.id);
          }
          return 'Original Session creation applied';
        }
        const result = await ensureSession(
          {
            kind: 'run',
            task: 'TUI Session',
            ...(workspace ? { workspace } : {}),
            trustWorkspace: false,
            skills: [],
          },
          client,
          storeId,
          input.cwd ?? process.cwd(),
          (line) => {
            if (!line.startsWith('session intent ')) return;
            const intent = JSON.parse(line.slice('session intent '.length)) as {
              commandId: string;
              sessionId: string;
            };
            pendingNew = Object.freeze({
              commandId: intent.commandId,
              sessionId: intent.sessionId,
            });
          },
        );
        if (result.workspace.id !== workspaceId)
          throw new CLIHostError('workspace_identity_mismatch');
        pendingNew = undefined;
        if (!ended && controller!.state.sessionId === sourceSessionId) {
          await controller!.list();
          if (controller!.state.sessionId === sourceSessionId)
            await controller!.select(result.session.id);
        }
        return 'New Workspace Session selected';
      } catch {
        return pendingNew
          ? `Original Session creation unknown: ${pendingNew.commandId}; Ctrl+N reads this ID only`
          : 'Session creation unavailable';
      } finally {
        newBusy = false;
      }
    };
    const refresh = async () => {
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      refreshing = true;
      try {
        do {
          refreshAgain = false;
          const target = controller!.state.sessionId;
          if (target && !ended)
            await controller!.select(target, { preserveReconnectionReview: true });
        } while (refreshAgain && !ended);
      } finally {
        refreshing = false;
      }
    };
    process.stdin.setRawMode(true);
    terminal = render(
      <TerminalHost
        controller={controller}
        onNew={createNew}
        onQuit={requestQuit}
        shared={!!input.server}
      />,
      {
        exitOnCtrlC: false,
      },
    );
    const lookup = (chunk: string | Buffer) => {
      const text = chunk.toString();
      if (text.includes('\u0011')) requestQuit();
      if (text === '\u000b') {
        void controller!.lookup();
        void controller!.lookupManagement();
        void controller!.lookupPermission();
      }
    };
    process.stdin.on('data', lookup);
    void (async () => {
      try {
        let startAfter: { storeId: string; sequence: string } | undefined;
        while (!ended && !observer.signal.aborted) {
          let resetReason: string | undefined;
          await client.observe({
            signal: observer.signal,
            ...(startAfter &&
            (!client.lastAppliedCursor ||
              BigInt(client.lastAppliedCursor.sequence) < BigInt(startAfter.sequence))
              ? { startAfter }
              : {}),
            onChange: async (change) => {
              if (change.sessionId === controller!.state.sessionId) await refresh();
            },
            onReady: (ready) => {
              if (!ended && !observer.signal.aborted) controller!.observationReady(ready.storeId);
            },
            onReset: async (reason) => {
              resetReason = reason;
              controller!.observationUnavailable(reason);
              if (reason === 'store_changed') {
                return;
              }
              startAfter = await prepareTuiObservationStart(
                client,
                storeId,
                async () => {
                  await controller!.list();
                  await refresh();
                  if (controller!.state.snapshotStale || controller!.state.loading)
                    throw new CLIHostError('observation_snapshot_unavailable');
                  if (controller!.state.panel === 'permissions') {
                    await controller!.openPermissions();
                    if (!controller!.state.permissions)
                      throw new CLIHostError('observation_snapshot_unavailable');
                  }
                },
                observer.signal,
              );
            },
          });
          if (resetReason === 'store_changed') {
            controller!.observationUnavailable(resetReason);
            break;
          }
          // Reset closes the read stream. Reopen one observer using its read baseline until actual callbacks ACK it.
          // Snapshot reads do not advance lastAppliedCursor and no business intent is resubmitted.
          if (input.server && !resetReason) {
            controller!.observationUnavailable('network');
            void refresh();
            break;
          }
          if (!ended && !observer.signal.aborted) await Bun.sleep(250);
        }
      } catch (error: unknown) {
        if (!ended) {
          controller!.observationUnavailable(
            error !== null &&
              typeof error === 'object' &&
              'code' in error &&
              typeof error.code === 'string'
              ? error.code
              : 'network',
          );
          void refresh();
        }
      }
    })();
    void paired?.exited.then(() => {
      observer.abort();
      controller?.observationUnavailable('service_closed');
    });
    try {
      await stopped;
    } finally {
      process.stdin.removeListener('data', lookup);
    }
    const draftsSaved = draftOwner?.flush() ?? true;
    if (!draftsSaved) process.stderr.write('tui_draft_save_failed_forced_exit\n');
    return draftsSaved ? 0 : 1;
  } finally {
    try {
      mcpOwner?.close();
      mcpConnectionOwner?.close();
      mcpReconnectionOwner?.close();
      mcpSourceMutationOwner?.close();
      mcpSourceApprovalOwner?.close();
      callerOwner?.close();
      fileRecoveryOwner?.close();
      recoveryOwner?.close();
      preferenceOwner?.close();
      draftOwner?.close();
      observer.abort();
      controller?.dispose();
      process.stdin.removeListener('end', endInput);
      process.stdin.removeListener('error', endInput);
      process.removeListener('SIGHUP', endInput);
      input.exitSignal?.removeEventListener('abort', onExit);
      terminal?.unmount();
      process.stdin.pause();
      if (!ended) {
        try {
          process.stdin.setRawMode(false);
        } catch {}
      }
    } finally {
      try {
        await connection.close();
      } finally {
        process.stdout.removeListener('error', endInput);
        process.stderr.removeListener('error', endInput);
        profileAccess.lock.release();
      }
    }
  }
}
