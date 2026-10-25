import type { Message } from '@kite-ai/client';
import {
  InteractionCard,
  ModelInputs,
  PermissionGrantsPanel,
  PermissionPanel,
  PermissionSubmissionStatus,
  type PlanReviewDraft,
  type QuestionAnswerDraft,
  questionDraftKey,
} from '@kite-ai/ui';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button as DesktopButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  MessageContent,
  ReadingStateCache,
  type SessionChildTabRequest,
  type SessionChildTarget,
  SessionPage,
  type SessionPageProps,
  ToolActivity,
} from '@kite-ai/ui/desktop';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DesktopEditor } from './file-changes-bridge';
import { inputImageCount } from './input-images-bridge';
import { nativeAgentActivityForTool } from './native-agent-activity';
import { NativeApproval } from './native-approval';
import { isOrdinaryNativeApproval, NativeApprovalGroup } from './native-approval-group';
import { NativeBackgroundPanel } from './native-background-panel';
import type {
  NativeBranchFacts,
  NativeBridge,
  NativeCallerMetadata,
  NativeConversationResult,
  NativeCreation,
  NativeDirectory,
  NativeDraft,
  NativeGrantFacts,
  NativeRequest,
  NativeResult,
  NativeState,
} from './native-bridge';
import { closeNativeBrowserTab, renderNativeBrowser } from './native-browser-pane';
import { useNativeCacheMetrics } from './native-cache-metrics';
import { NativeCallerView } from './native-caller';
import { NativeChildDetail } from './native-child-detail';
import { NativeContextView } from './native-context';
import { useNativeContextUsage } from './native-context-usage';
import {
  NativeDiagnostic,
  NativeDiagnosticsProvider,
  useNativeDiagnostics,
} from './native-diagnostics';
import { NativeDisplayCache } from './native-display-cache';
import { useNativeEnvironment } from './native-environment';
import { NativeExtensions } from './native-extensions';
import { NativeFileChanges, NativeOutputFile } from './native-file-changes';
import { NativeFileRecoveryPanel } from './native-file-recovery';
import { useNativeFileTargets } from './native-file-targets';
import { NativeGeneralSettings } from './native-general-settings';
import { type HistoryState, NativeHistory } from './native-history';
import { nativeInputFailureMessage, nativeTextIntent } from './native-input';
import { useNativeInputImages } from './native-input-images';
import { useNativeInputQueue } from './native-input-queue';
import { readNativeInteractionAttachment } from './native-interaction-attachment';
import { NativeInteractionHistory } from './native-interaction-history';
import { NativeJobOutputPanel } from './native-job-output-panel';
import { NativeMcpSettings } from './native-mcp-settings';
import { createNativeModelInputPort } from './native-model-input';
import { readNativeModelOutput } from './native-model-output';
import { NativeModelOutputMessage } from './native-model-output-message';
import {
  type NativeModelChoice,
  NativeModelPicker,
  NativeModelSnapshots,
  type NativePreparedModels,
  nativeModelScope,
  prepareNativeModels,
} from './native-model-picker';
import { NativeModelSettings } from './native-model-settings';
import {
  desktopConversationMessages,
  desktopDirectory,
  desktopMessages,
} from './native-presentation';
import { NativeProviderSettings } from './native-provider-settings';
import { NativeRecoveryView } from './native-recovery';
import { NativeExecutionResult } from './native-result';
import { useNativeScheduledTasks } from './native-scheduled-tasks';
import { NativeSessionRecovery } from './native-session-recovery';
import { NativeSessionPanel } from './native-sessions';
import { NativeSkillsSettings } from './native-skills-settings';
import { NativeStartup } from './native-startup';
import { useNativeTheme } from './native-theme';
import {
  groupNativeToolMessages,
  liveToolMessages,
  useNativeToolMessages,
} from './native-tool-messages';
import {
  desktopTranscript,
  nativeInputTurnId,
  nativePendingInputMessage,
  nativeReplyKey,
  useNativeRuns,
} from './native-transcript';
import { NativeTranscriptDisplay } from './native-transcript-display';
import { NativePendingAttachments, NativeUserImages } from './native-user-images';
import { NativeWindowFrame } from './native-window-frame';
import { promptTextForSend } from './prompt-text';

const imageScope = (storeId: string | undefined, sessionId: string) =>
  JSON.stringify([storeId, sessionId]);

function savedNativeInput(
  message: Message,
  commandId: string,
  scope: { storeId: string; sessionId: string },
  selection: NativeState['selection'],
) {
  return (
    message.role === 'user' &&
    !message.originMessage &&
    message.sessionId === scope.sessionId &&
    selection?.storeId === scope.storeId &&
    selection.session.id === scope.sessionId &&
    (message.humanInput?.publicCommandId === commandId ||
      message.originCommandId === commandId ||
      (message.sourceIds?.includes(commandId) &&
        selection.runs.some(
          (run) =>
            run.id === message.runId &&
            run.originStoreId === scope.storeId &&
            run.sessionId === scope.sessionId &&
            run.originCommandId === commandId,
        )))
  );
}

/** The renderer owns only public presentation; all I/O is the named preload bridge. */
export function nativeRootInteractionBlocksComposer(selection: NativeState['selection']): boolean {
  return !!selection?.interactions.some(
    (card) =>
      ['approval', 'question', 'plan_review'].includes(card.kind) &&
      !isOrdinaryNativeApproval(card) &&
      card.state === 'pending' &&
      card.originStoreId === selection.storeId &&
      card.sessionId === selection.session.id &&
      card.presentationSessionId === selection.session.id &&
      selection.executions.some(
        (execution) =>
          execution.id === card.executionId &&
          execution.originStoreId === selection.storeId &&
          execution.sessionId === selection.session.id &&
          execution.runId === card.runId &&
          ['planned', 'dispatching', 'running'].includes(execution.status),
      ) &&
      (card.runId === null ||
        selection.runs.some(
          (run) =>
            run.id === card.runId &&
            run.originStoreId === selection.storeId &&
            run.sessionId === selection.session.id &&
            run.isActive,
        )),
  );
}

export function NativeDesktop({
  testDiagnostics = false,
  nativeWindow = false,
}: {
  testDiagnostics?: boolean;
  nativeWindow?: boolean;
} = {}) {
  const bridge = window.kiteNative;
  return bridge ? (
    <NativeDiagnosticsProvider enabled={testDiagnostics}>
      <NativeDesktopContent bridge={bridge} nativeWindow={nativeWindow} />
    </NativeDiagnosticsProvider>
  ) : nativeWindow ? (
    <NativeWindowFrame showHeader={false}>
      <NativeStartup phase="failed" error="原生桥不可用，请核对客户端资源。" />
    </NativeWindowFrame>
  ) : (
    <NativeStartup phase="failed" error="原生桥不可用，请核对客户端资源。" />
  );
}

function NativeDesktopContent({
  bridge,
  nativeWindow,
}: {
  bridge: NativeBridge & Partial<import('./native-bridge').NativeStartupBridge>;
  nativeWindow: boolean;
}) {
  const diagnostics = useNativeDiagnostics();
  const [interactionHistoryOpen, setInteractionHistoryOpen] = useState(false);
  const [startup, setStartup] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [startupError, setStartupError] = useState('');
  const [diagnosticAvailable, setDiagnosticAvailable] = useState(false);
  const [diagnosticSaveError, setDiagnosticSaveError] = useState('');
  const [startupAttempt, setStartupAttempt] = useState(0);
  const startupAttemptRef = useRef(startupAttempt);
  startupAttemptRef.current = startupAttempt;
  const startupPhase = useRef(startup);
  startupPhase.current = startup;
  const startupDirectoryUnavailable = useRef(false);
  const theme = useNativeTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsEditorHost, setSettingsEditorHost] = useState<HTMLDivElement | null>(null);
  const settingsEditorControl = useRef<{ close: () => void } | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [scheduledTasksView, setScheduledTasksView] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [newDraft, setNewDraft] = useState('');
  const newDraftRevision = useRef(0);
  const [newWorkspace, setNewWorkspace] = useState('');
  const [newBranch, setNewBranch] = useState<NativeBranchFacts>();
  const [targetBranch, setTargetBranch] = useState<string>();
  const [contextBusy, setContextBusy] = useState(false);
  const [newPermission, setNewPermission] = useState<'accept_edits' | 'auto' | 'full'>();
  const [newPlanMode, setNewPlanMode] = useState(false);
  const [newChoice, setNewChoice] = useState<NativeModelChoice>({});
  const [newModelRevision, setNewModelRevision] = useState(0);
  const [newModelReady, setNewModelReady] = useState<{
    ready: boolean;
    choice?: NativeModelChoice;
  }>({ ready: false });
  const [firstSubmission, setFirstSubmission] = useState<{
    creation: NativeCreation['input'];
    commandId: string;
    text: string;
    draft: { content: string };
    preparationRevision: number;
    choice: NativeModelChoice;
    plan: boolean;
    permissionMode: 'accept_edits' | 'auto' | 'full';
    imageIds?: readonly string[];
    images?: readonly { name: string }[];
    files?: readonly { id: string; name: string; uri: string; prepared?: boolean }[];
    imageScope?: string;
    result?: NativeConversationResult;
  }>();
  const firstRef = useRef(firstSubmission);
  firstRef.current = firstSubmission;
  const firstAcceptedDraft = useRef<{ commandId: string; draft: { content: string } } | undefined>(
    undefined,
  );
  const contextIntent = useRef(0);
  const draftCache = useRef(new Map<string, { content: string }>());
  const draftOwner = useRef<string | undefined>(undefined);
  const submittedDrafts = useRef(
    new Map<string, { storeId: string; sessionId: string; draft: { content: string } }>(),
  );
  const consumedDraft = useRef<
    | {
        generation: number;
        view: number;
        storeId: string;
        workspaceId: string;
        sessionId: string;
        commandId: string;
        proof: NonNullable<NativeCallerMetadata['draft']>;
      }
    | undefined
  >(undefined);
  const [state, setState] = useState<NativeState>();
  const [directory, setDirectory] = useState<NativeDirectory>();
  const imageDrafts = useNativeInputImages(bridge, state?.generation, directory?.storeId);
  const newImageScope = imageScope(directory?.storeId, 'new-conversation');
  const [messages, setMessages] = useState<Message[]>([]);
  const childTabSequence = useRef(0);
  const [childTabRequest, setChildTabRequest] = useState<
    SessionChildTabRequest & { parent: string }
  >();
  const [activeChildTab, setActiveChildTab] = useState<SessionChildTarget & { parent: string }>();
  const childReadings = useRef(new ReadingStateCache());
  const [historyState, setHistoryState] = useState<HistoryState>({
    messages: [],
    phase: 'loading',
  });
  const history = useRef<NativeHistory | undefined>(undefined);
  if (bridge && !history.current)
    history.current = new NativeHistory(bridge, (value) => {
      setMessages(value.messages);
      setHistoryState(value);
    });
  const [savedDrafts, setSavedDrafts] = useState<{
    drafts: Omit<NativeDraft, 'content'>[];
    nextId: string | null;
  }>();
  const [originalDraft, setOriginalDraft] = useState<NativeDraft>();
  const [grantFacts, setGrantFacts] = useState<NativeGrantFacts>();
  const [draft, setDraft] = useState('');
  const [queueFocusKey, setQueueFocusKey] = useState(0);
  const [planMode, setPlanMode] = useState(false);
  const [settingsPage, setSettingsPage] = useState<
    'general' | 'models' | 'providers' | 'mcp' | 'skills'
  >('general');
  const [editor, setEditor] = useState<DesktopEditor>('vscode');
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [, choiceChanged] = useState(0);
  const modelChoices = useRef(new Map<string, NativeModelChoice>());
  const modelSnapshots = useRef(new NativeModelSnapshots());
  const [preparedModels, setPreparedModels] = useState<NativePreparedModels>();
  const [resolvedChoice, setResolvedChoice] = useState<{
    identity: string;
    choice?: NativeModelChoice;
    ready: boolean;
  }>();
  const planModes = useRef(new Map<string, boolean>());
  const [error, setError] = useState('');
  const [businessError, setBusinessError] = useState(false);
  const [failedReads, setFailedReads] = useState<{
    state?: string;
    directory?: string;
    selection?: { key: string; sessionId: string };
  }>({});
  const sessionRecovery = useRef(new NativeSessionRecovery());
  const [, recoveryVisibilityChanged] = useState(0);
  const [pending, setPending] = useState(false);
  const [sending, setSending] = useState(false);
  const [inputDeliveries, setInputDeliveries] = useState(
    new Map<
      string,
      {
        storeId: string;
        sessionId: string;
        kind: 'run.start' | 'input.steer' | 'input.follow_up';
        targetRunId?: string;
        afterMessageId?: string;
        afterInputCommandId?: string;
        text: string;
        phase: 'sending' | 'unknown' | 'failed' | 'accepted';
        files?: readonly { name: string }[];
        images?: readonly { name: string }[];
      }
    >(),
  );

  const [removingWorkspace, setRemovingWorkspace] = useState<string>();
  const [expandedExecutions, setExpandedExecutions] = useState<{
    identity: string;
    ids: Set<string>;
  }>({ identity: '', ids: new Set() });
  const generation = useRef(0),
    historyEpoch = useRef<number | undefined>(undefined),
    viewIntent = useRef(0),
    pageIntent = useRef(0),
    firstOpenPage = useRef<number | undefined>(undefined),
    draftRevision = useRef(0),
    writing = useRef(false);
  const readLifecycle = useRef({ epoch: 0, quitting: false });
  const selectionRead = useRef<
    | {
        sessionId: string;
        holdPresentation: boolean;
        latest?: NativeState;
      }
    | undefined
  >(undefined);
  const rememberLatestDraft = useRef<() => void>(() => {});
  rememberLatestDraft.current = rememberDraft;
  const selected = useRef<string | undefined>(undefined);
  const parentHistoryVisible = useRef(true);
  type StateReadIntent = { current: number; nonce: number; epoch: number };
  type QueuedStateRead = {
    intent: StateReadIntent;
    promise: Promise<void>;
    resolve: () => void;
    reject: (cause: unknown) => void;
  };
  const stateRefresh = useRef<{
    active?: { promise: Promise<void> };
    queued?: QueuedStateRead;
  }>({});
  const verifiedReplyBodies = useRef(new Map<string, { identity: string; text: string }>());
  const [verifiedReplyRevision, renderVerifiedReply] = useState(0);
  const transcriptDisplay = useRef(new NativeTranscriptDisplay());
  const questionDrafts = useRef(
    new Map<
      string,
      {
        storeId: string;
        sourceSessionId: string;
        presentationSessionId: string;
        cardId: string;
        draft: QuestionAnswerDraft;
      }
    >(),
  );
  const planDrafts = useRef(
    new Map<
      string,
      {
        storeId: string;
        sourceSessionId: string;
        presentationSessionId: string;
        cardId: string;
        draft: PlanReviewDraft;
        runId: string | null;
      }
    >(),
  );
  function acceptDirectory(value: NativeDirectory) {
    setDirectory(value);
    if (startupPhase.current === 'loading' && value.unavailable) {
      startupDirectoryUnavailable.current = true;
      startupPhase.current = 'failed';
      setStartupError('native_directory_unavailable');
      setStartup('failed');
    } else if (
      !value.unavailable &&
      (startupPhase.current === 'loading' || startupDirectoryUnavailable.current)
    ) {
      // A complete observation from this generation may recover while the user
      // is still on the retry page. Explicit retries revoke the old generation.
      startupDirectoryUnavailable.current = false;
      startupPhase.current = 'ready';
      setStartupError('');
      setStartup('ready');
    }
  }
  function apply(result: NativeResult) {
    if (result && 'generation' in result && result.generation === generation.current) {
      const reading = selectionRead.current;
      const hold = reading?.holdPresentation && result.selection?.session.id === reading.sessionId;
      if (reading?.holdPresentation) reading.latest = result;
      // Global failures and directory facts still publish while the current
      // reading stays paused until the target footer can be painted coherently.
      const value: NativeState = hold ? { ...result, selection: undefined } : result;
      for (const input of value.inputSubmissions)
        if (['accepted', 'applied', 'terminal'].includes(input.phase))
          consumeInputDraft(input.intent.commandId, input.intent.expectedStoreId, input.sessionId);
      for (const caller of value.callerSubmissions ?? [])
        if (['accepted', 'applied'].includes(caller.phase)) {
          rememberConsumedDraft(caller.request.commandId, caller.scope, caller.draft);
          consumeInputDraft(caller.request.commandId, caller.scope.storeId, caller.scope.sessionId);
        }
      if (value.directory) acceptDirectory(value.directory);
      historyEpoch.current = value.historyEpoch;
      // Main has verified the exact answer_saved receipt. Promise resolution and
      // omission from a bounded pending page are not confirmation of an answer.
      for (const drafts of [questionDrafts.current, planDrafts.current]) {
        for (const submission of value.interactionSubmissions)
          if (submission.phase === 'accepted' && submission.receipt)
            drafts.delete(questionDraftKey(submission.interaction));
        for (const card of value.selection?.interactions ?? []) {
          const currentKey = questionDraftKey(card);
          for (const [key, saved] of drafts)
            if (
              saved.storeId === card.originStoreId &&
              saved.sourceSessionId === card.sessionId &&
              saved.presentationSessionId === card.presentationSessionId &&
              saved.cardId === card.id &&
              (key !== currentKey || card.state !== 'pending')
            )
              drafts.delete(key);
        }
      }
      for (const [key, saved] of planDrafts.current)
        if (
          saved.storeId === value.selection?.storeId &&
          saved.sourceSessionId === value.selection.session.id &&
          value.selection.runs.some(
            (run) =>
              run.id === saved.runId &&
              run.originStoreId === saved.storeId &&
              run.status === 'cancelled' &&
              !run.isActive,
          )
        )
          planDrafts.current.delete(key);
      if (value.selection)
        setPlanMode(
          planModes.current.get(
            JSON.stringify([
              value.selection.storeId,
              value.selection.session.workspaceId,
              value.selection.session.id,
            ]),
          ) ?? false,
        );
      const selecting = !!selectionRead.current;
      setState((previous) => {
        if (
          !value.selection &&
          selecting &&
          previous?.selection &&
          previous.generation === value.generation &&
          (!value.directory || value.directory.storeId === previous.selection.storeId)
        )
          return {
            ...value,
            selection: {
              ...previous.selection,
              permissions: undefined,
              permissionUnavailable: true,
              viewLoading: true,
            },
          };
        return value;
      });
    }
  }
  async function report(action: () => Promise<unknown>, clearError = true, business = false) {
    try {
      if (clearError) {
        setError('');
        setBusinessError(business);
      }
      return await action();
    } catch (cause) {
      const code =
        (cause as { code?: string; message?: string }).code ??
        (cause as { message?: string }).message;
      setBusinessError(business);
      setError(code && /^[a-z][a-z0-9_]{0,80}$/.test(code) ? code : '结果待核实；请查询原命令。');
      return undefined;
    }
  }
  function isCurrentRead(current: number, epoch: number, nonce?: number) {
    return (
      !readLifecycle.current.quitting &&
      current === generation.current &&
      epoch === readLifecycle.current.epoch &&
      (nonce === undefined || nonce === viewIntent.current)
    );
  }
  function refresh(): Promise<void> {
    if (!bridge || !generation.current || readLifecycle.current.quitting) return Promise.resolve();
    const intent = {
      nonce: viewIntent.current,
      current: generation.current,
      epoch: readLifecycle.current.epoch,
    };
    const owned = (promise: Promise<void>) =>
      promise.catch((cause) => {
        if (isCurrentRead(intent.current, intent.epoch, intent.nonce)) throw cause;
      });
    if (!stateRefresh.current.active) return owned(startStateRead(intent));
    const queued = stateRefresh.current.queued;
    if (queued) {
      queued.intent = intent;
      return owned(queued.promise);
    }
    let resolve!: () => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<void>((success, failure) => {
      resolve = success;
      reject = failure;
    });
    stateRefresh.current.queued = { intent, promise, resolve, reject };
    return owned(promise);
  }
  function startStateRead({ current, nonce, epoch }: StateReadIntent): Promise<void> {
    const promise = (async () => {
      if (!bridge || !isCurrentRead(current, epoch, nonce)) return;
      let value: NativeResult;
      try {
        value = await bridge.request({ method: 'state', generation: current });
      } catch (cause) {
        if (!isCurrentRead(current, epoch, nonce)) return;
        setFailedReads((previous) => ({
          ...previous,
          state: JSON.stringify([current, epoch, nonce]),
        }));
        throw cause;
      }
      if (!isCurrentRead(current, epoch, nonce)) return;
      setFailedReads((previous) => (previous.state ? { ...previous, state: undefined } : previous));
      apply(value);
      if (
        value &&
        'generation' in value &&
        value.selection &&
        selected.current === value.selection.session.id &&
        !selectionRead.current?.holdPresentation &&
        parentHistoryVisible.current
      )
        history.current?.select(current, value.selection, value.historyEpoch);
    })();
    const active = { promise };
    stateRefresh.current.active = active;
    const finish = () => {
      if (stateRefresh.current.active !== active) return;
      const queued = stateRefresh.current.queued;
      stateRefresh.current = {};
      if (queued) {
        const { current, epoch, nonce } = queued.intent;
        if (!isCurrentRead(current, epoch, nonce)) queued.resolve();
        else void startStateRead(queued.intent).then(queued.resolve, queued.reject);
      }
    };
    // Settling a forced refresh does not wait forever for notifications arriving later.
    void promise.then(finish, finish);
    return promise;
  }
  async function readDirectory(): Promise<NativeDirectory | undefined> {
    if (!bridge || readLifecycle.current.quitting) return;
    const current = generation.current,
      epoch = readLifecycle.current.epoch;
    try {
      const value = await bridge.request({ method: 'directory', generation: current });
      if (!isCurrentRead(current, epoch)) return;
      if (!value || !('workspaces' in value)) throw Error('native_directory_unavailable');
      acceptDirectory(value);
      setFailedReads((previous) => ({
        ...previous,
        directory: value.unavailable ? JSON.stringify([current, epoch]) : undefined,
      }));
      return value;
    } catch (cause) {
      if (!isCurrentRead(current, epoch)) return;
      // Main's observer reset replaces this GET; the next directory state owns the display.
      const code = (cause as { code?: string; message?: string }).code ?? (cause as Error).message;
      if (code === 'directory_observation_changed') return;
      setFailedReads((previous) => ({
        ...previous,
        directory: JSON.stringify([current, epoch]),
      }));
      throw cause;
    }
  }
  async function readGrants(nextPage = false) {
    const scope = state?.selection;
    if (!bridge || !scope?.canReadPermissionGrants) return;
    const current = generation.current,
      nonce = viewIntent.current;
    const previous = nextPage ? grantFacts?.page : undefined;
    setGrantFacts(undefined);
    const value = await bridge.request({
      method: 'grants.read',
      generation: current,
      sessionId: scope.session.id,
      ...(previous
        ? {
            afterSeq: previous.nextAfterSeq!,
            upperSeq: previous.upperSeq,
            revision: previous.revision,
          }
        : {}),
    });
    if (
      current !== generation.current ||
      nonce !== viewIntent.current ||
      selected.current !== scope.session.id
    )
      return;
    if (value && 'observationId' in value && 'page' in value && 'items' in value.page)
      setGrantFacts({ observationId: value.observationId, page: value.page });
  }
  async function select(sessionId: string, keepCurrentDraft = true, keepTaskPage = false) {
    if (!bridge || readLifecycle.current.quitting) return;
    if (keepCurrentDraft) rememberDraft();
    const firstHandoff =
      preparing && !keepCurrentDraft && firstRef.current?.creation.sessionId === sessionId;
    // Keep the submitted preparation visible until its own selected facts arrive.
    if (firstHandoff) firstOpenPage.current = pageIntent.current;
    if (!keepTaskPage) {
      if (!firstHandoff) setPreparing(false);
      setScheduledTasksView(false);
    }
    const nonce = ++viewIntent.current,
      current = generation.current,
      epoch = readLifecycle.current.epoch;
    selected.current = sessionId;
    history.current?.close();
    // Revoke actions now; retain the current reading until the target facts arrive.
    setHistoryState((previous) => ({ ...previous, phase: 'loading', error: undefined }));
    setModelInputTarget(undefined);
    setGrantFacts(undefined);
    await readSelection(sessionId, current, nonce, epoch);
  }
  async function readSelection(sessionId: string, current: number, nonce: number, epoch: number) {
    if (!isCurrentRead(current, epoch, nonce)) return;
    const original: NonNullable<typeof selectionRead.current> = {
      sessionId,
      holdPresentation: true,
    };
    selectionRead.current = original;
    try {
      let value = await bridge.request({
        method: 'select',
        generation: current,
        sessionId,
        activationId: nonce,
      });
      if (!isCurrentRead(current, epoch, nonce)) return;
      if (value && 'generation' in value && value.selection?.session.id === sessionId) {
        const targetSelection = value.selection;
        const scope = nativeModelScope(
          current,
          targetSelection,
          undefined,
          String(settingsRevision),
        );
        original.latest = undefined;
        if (!modelSnapshots.current.get(scope)) {
          const prepared = await prepareNativeModels(
            bridge,
            current,
            targetSelection,
            undefined,
            String(settingsRevision),
          );
          if (!isCurrentRead(current, epoch, nonce)) return;
          const latestStore = selectionRead.current?.latest?.directory?.storeId;
          if (latestStore && latestStore !== targetSelection.storeId) return;
          if (prepared.facts) modelSnapshots.current.set(scope, prepared.facts);
          setPreparedModels(prepared);
        } else setPreparedModels(undefined);
        const latest = selectionRead.current?.latest;
        if (latest) {
          const matching =
            latest.selection?.session.id === sessionId &&
            latest.selection.storeId === targetSelection.storeId &&
            latest.selection.viewSelection === targetSelection.viewSelection;
          value = matching
            ? latest
            : {
                ...latest,
                // The acknowledged identity remains readable, but a later withdrawal
                // must revoke its facts rather than resurrect the earlier permissions.
                selection: {
                  ...targetSelection,
                  permissions: undefined,
                  permissionUnavailable: true,
                  viewLoading: !latest.backgroundUnavailable && !latest.callerUnavailable,
                },
              };
        }
        original.holdPresentation = false;
        history.current?.preview(sessionId);
        draftOwner.current = imageScope(targetSelection.storeId, sessionId);
        setDraft(draftCache.current.get(draftOwner.current)?.content ?? '');
      }
      apply(value);
      if (value && 'generation' in value && value.selection && parentHistoryVisible.current)
        history.current?.select(current, value.selection, value.historyEpoch);
      if (value && 'generation' in value && !value.selection?.session.parentSessionId) {
        const saved = await bridge.request({
          method: 'draft.read',
          generation: current,
          sessionId,
        });
        if (!isCurrentRead(current, epoch, nonce)) return;
        if (saved && 'content' in saved && 'revision' in saved) {
          setDraft(
            draftCache.current.get(imageScope(saved.storeId, sessionId))?.content ?? saved.content,
          );
          draftRevision.current = saved.revision;
        }
      }
      if (isCurrentRead(current, epoch, nonce)) {
        setFailedReads((previous) =>
          previous.selection ? { ...previous, selection: undefined } : previous,
        );
        // A recovered first selection completes the same handoff as its initial
        // read. Keep this here so an automatic retry cannot leave preparing set.
        if (
          !original.holdPresentation &&
          selected.current === sessionId &&
          firstOpenPage.current === pageIntent.current &&
          firstRef.current?.creation.sessionId === sessionId &&
          value &&
          'generation' in value &&
          value.selection?.storeId === firstRef.current.creation.expectedStoreId
        )
          setPreparing(false);
      }
    } catch (cause) {
      if (!isCurrentRead(current, epoch, nonce)) return;
      setFailedReads((previous) => ({
        ...previous,
        selection: { key: JSON.stringify([current, epoch, nonce]), sessionId },
      }));
      throw cause;
    } finally {
      if (selectionRead.current === original && epoch === readLifecycle.current.epoch)
        selectionRead.current = undefined;
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Startup retries replace only this bridge observation; other facts are read through refs.
  useEffect(() => {
    let alive = true;
    const startupEpoch = readLifecycle.current.epoch;
    const unwatch = bridge.watch((event) => {
      if (!alive) return;
      if (event.kind === 'lifecycle') {
        const quitting = event.phase === 'quitting';
        if (quitting === readLifecycle.current.quitting) return;
        if (quitting) sessionRecovery.current.close();
        if (quitting && !selectionRead.current) rememberLatestDraft.current();
        readLifecycle.current = { epoch: readLifecycle.current.epoch + 1, quitting };
        viewIntent.current++;
        if (!quitting) {
          if (!generation.current) setStartupAttempt((value) => value + 1);
          else {
            const current = generation.current,
              nonce = viewIntent.current,
              epoch = readLifecycle.current.epoch;
            void report(async () => {
              await refresh();
              if (!isCurrentRead(current, epoch, nonce)) return;
              if (selected.current) await readSelection(selected.current, current, nonce, epoch);
              if (!isCurrentRead(current, epoch, nonce)) return;
              await readDirectory();
            }, false);
          }
        }
        return;
      }
      if (
        !readLifecycle.current.quitting &&
        generation.current > 0 &&
        event.generation === generation.current
      ) {
        const nonce = viewIntent.current,
          epoch = readLifecycle.current.epoch;
        void refresh().catch((cause) => {
          if (alive && isCurrentRead(event.generation, epoch, nonce))
            void report(async () => {
              throw cause;
            }, false);
        });
      }
    });
    void (async () => {
      const page = pageIntent.current;
      const value = await bridge.request({ method: 'attach' });
      if (!alive || startupEpoch !== readLifecycle.current.epoch) return;
      if (
        !value ||
        !('generation' in value) ||
        !Number.isSafeInteger(value.generation) ||
        value.generation < 1
      )
        throw Error('native_initialization_unavailable');
      generation.current = value.generation;
      apply(value);
      if (!value.selection) setPreparing(true);
      const initialDirectory = await readDirectory();
      if (
        alive &&
        startupEpoch === readLifecycle.current.epoch &&
        pageIntent.current === page &&
        !value.selection &&
        !initialDirectory?.unavailable &&
        initialDirectory?.workspaces[0]
      )
        await chooseWorkspace(initialDirectory.workspaces[0].id, initialDirectory);
    })().catch(async (cause) => {
      if (!alive || startupEpoch !== readLifecycle.current.epoch) return;
      const code = (cause as { code?: string })?.code ?? (cause as Error)?.message;
      if (startupPhase.current === 'ready') {
        setError(/^[a-z][a-z0-9_]{0,80}$/.test(code ?? '') ? code! : '目录状态待核实。');
        return;
      }
      startupDirectoryUnavailable.current = false;
      startupPhase.current = 'failed';
      setStartupError(
        /^[a-z][a-z0-9_]{0,80}$/.test(code ?? '') ? code! : '请重新尝试准备工作空间。',
      );
      setStartup('failed');
      try {
        const status = await bridge.startupStatus?.();
        if (alive && startupPhase.current === 'failed')
          setDiagnosticAvailable(
            status?.diagnosticAvailable === true && !!bridge.saveStartupDiagnostic,
          );
      } catch {
        // Missing diagnostics do not turn a generic startup error into a report.
      }
    });
    return () => {
      alive = false;
      unwatch();
      history.current?.clear();
      const attached = generation.current;
      generation.current = 0;
      viewIntent.current++;
      if (attached) void bridge.request({ method: 'detach', generation: attached }).catch(() => {});
    };
  }, [bridge, startupAttempt]);
  const selection = useMemo(
    () =>
      state?.selection
        ? {
            ...state.selection,
            permissionUnavailable:
              state.selection.permissionUnavailable ||
              historyState.phase !== 'complete' ||
              selected.current !== state.selection.session.id,
            viewLoading:
              state.selection.viewLoading ||
              historyState.phase === 'loading' ||
              selected.current !== state.selection.session.id,
            permissions:
              historyState.phase === 'complete' ? state.selection.permissions : undefined,
          }
        : undefined,
    [state?.selection, historyState.phase],
  );
  // Selection counters govern IO, not the identity of an already observed display label.
  const selectionHandoff =
    !!selectionRead.current && selected.current !== state?.selection?.session.id;
  const sessionLoading =
    selectionHandoff ||
    (!state?.callerUnavailable &&
      !state?.backgroundUnavailable &&
      !(state?.selection?.permissionUnavailable && !state.selection.viewLoading) &&
      (!!state?.selection?.viewLoading || historyState.phase === 'loading'));
  const permissionLabels = useRef(
    new NativeDisplayCache<NonNullable<NonNullable<SessionPageProps['composer']>['permission']>>(),
  );
  const permissionBoundary = JSON.stringify([state?.generation, state?.selection?.storeId]);
  const previousPermissionBoundary = useRef(permissionBoundary);
  if (previousPermissionBoundary.current !== permissionBoundary) {
    permissionLabels.current.clear();
    previousPermissionBoundary.current = permissionBoundary;
  }
  const permissionLabelKey = JSON.stringify([
    state?.selection?.session.workspaceId,
    state?.selection?.session.id,
  ]);
  const permissionFailed =
    (state?.selection?.permissionUnavailable && !state.selection.viewLoading) ||
    state?.backgroundUnavailable;
  const observedPermission = !permissionFailed
    ? state?.selection?.permissions?.mode.mode
    : undefined;
  if (permissionFailed) permissionLabels.current.delete(permissionLabelKey);
  else if (observedPermission && !state?.selection?.permissionUnavailable)
    permissionLabels.current.set(permissionLabelKey, observedPermission);
  const composerPermission =
    observedPermission ??
    (sessionLoading ? permissionLabels.current.get(permissionLabelKey) : undefined);
  const choiceKey = JSON.stringify([
    selection?.storeId,
    selection?.session.workspaceId,
    selection?.session.id,
  ]);
  const choiceIdentity = JSON.stringify([
    state?.generation,
    selection?.storeId,
    selection?.session.id,
    selection?.viewSelection,
  ]);
  const activeInputRun = selection?.runs.find((run) => run.isActive);
  const directoryActivity =
    directory?.storeId === selection?.storeId
      ? directory?.sessions.find((session) => session.id === selection?.session.id)?.activity
      : undefined;
  // 目录观察只属于其原活动 Run；已协调终态或后来的新轮次不继承旧 owner 提示。
  // A failed directory refresh cannot confirm ownership or revive cached activity.
  const executionOwner =
    activeInputRun &&
    directoryActivity?.run?.isActive &&
    directoryActivity.run.id === activeInputRun.id
      ? directory?.unavailable
        ? 'unknown'
        : directoryActivity.executionOwner
      : undefined;
  const executionUnconfirmed = executionOwner === 'unheld' || executionOwner === 'unknown';
  const jobs =
    selection?.executions.filter(
      (execution) =>
        execution.kind === 'job' &&
        execution.sessionId === selection.session.id &&
        execution.originStoreId === selection.storeId,
    ) ?? [];
  const unfinishedJobs = jobs.filter((job) =>
    ['planned', 'dispatching', 'running'].includes(job.status),
  ).length;
  const unknownJobs = jobs.filter((job) => job.status === 'outcome_unknown').length;
  const needsNextModel =
    executionUnconfirmed ||
    !activeInputRun ||
    planMode ||
    ['context.compress', 'context.compression.reset'].includes(
      selection?.activeCommand?.kind ?? '',
    );
  const nextModelReady = resolvedChoice?.identity === choiceIdentity && resolvedChoice.ready;
  const preparedPermission = newPermission ?? selection?.permissions?.mode.mode ?? 'auto';
  const attachmentGeneration = state?.generation,
    attachmentSessionId = selection?.session.id,
    attachmentView = selection?.viewSelection,
    attachmentEpoch = state?.historyEpoch;
  const attachmentReader = useMemo(() => {
    if (!bridge || !attachmentGeneration || !attachmentSessionId || !attachmentView)
      return undefined;
    const current = attachmentGeneration,
      nonce = viewIntent.current,
      sessionId = attachmentSessionId,
      epoch = attachmentEpoch;
    return (
      attachment: import('@kite-ai/client').InteractionAttachment,
      options: { signal: AbortSignal },
    ) =>
      readNativeInteractionAttachment({
        bridge,
        generation: current,
        viewSelection: attachmentView,
        attachment,
        signal: options.signal,
        isCurrent: () =>
          current === generation.current &&
          epoch === historyEpoch.current &&
          nonce === viewIntent.current &&
          selected.current === sessionId,
      });
  }, [bridge, attachmentGeneration, attachmentSessionId, attachmentView, attachmentEpoch]);
  useEffect(() => {
    if (selection?.permissionUnavailable && !selection.viewLoading) setGrantFacts(undefined);
  }, [selection?.permissionUnavailable, selection?.viewLoading]);
  const [modelInputTarget, setModelInputTarget] = useState<{
    executionId: string;
    revision: number;
  }>();
  const inputStore = selection?.storeId,
    inputSession = selection?.session.id,
    inputEnabled = selection?.canReadModelInput === true,
    inputGeneration = state?.generation ?? 0,
    inputView = selection?.viewSelection ?? 0;
  const modelInputPort = useMemo(() => {
    if (!bridge || !inputStore || !inputSession || !inputView) return undefined;
    const nonce = viewIntent.current;
    return createNativeModelInputPort({
      bridge,
      generation: inputGeneration,
      storeId: inputStore,
      sessionId: inputSession,
      enabled: inputEnabled,
      isCurrent: () =>
        generation.current === inputGeneration &&
        viewIntent.current === nonce &&
        selected.current === inputSession,
    });
  }, [bridge, inputStore, inputSession, inputEnabled, inputGeneration, inputView]);
  const childParent = JSON.stringify([selection?.storeId, selection?.session.id]);
  const environment = useNativeEnvironment({
    bridge,
    generation: state?.generation ?? generation.current,
    historyEpoch: state?.historyEpoch ?? 0,
    selection: !preparing && !scheduledTasksView ? state?.selection : undefined,
    revision: state?.selectedEnvironmentRevision ?? state?.environmentRevision ?? 0,
    unavailable:
      state?.environmentReadUnavailable ??
      !!(
        state?.selection?.viewLoading ||
        state?.selection?.permissionUnavailable ||
        state?.backgroundUnavailable
      ),
    paused: selectionHandoff,
    executionUnconfirmed,
    controlUnavailable: !!(
      executionUnconfirmed ||
      state?.callerUnavailable ||
      state?.selection?.viewLoading ||
      state?.selection?.permissionUnavailable
    ),
    submissions: state?.callerSubmissions,
    onChanged: async () => {
      await report(refresh, false);
    },
    onOpenChild: (sessionId, executionId, title) => {
      setChildTabRequest({
        parent: childParent,
        requestId: ++childTabSequence.current,
        sessionId,
        executionId,
        title,
      });
    },
  });
  const visibleChildTab = activeChildTab?.parent === childParent ? activeChildTab : undefined;
  const childReader = useRef(environment);
  childReader.current = environment;
  const childScope = environment.childScope;
  const childReadAvailable = environment.childReadAvailable;
  const childSessionId = visibleChildTab?.sessionId;
  const childExecutionId = visibleChildTab?.executionId;
  const childViewIdentity = childSessionId
    ? JSON.stringify([childScope, childSessionId, childExecutionId])
    : undefined;
  useEffect(() => {
    if (!childViewIdentity) return;
    return () => childReader.current.closeChild();
  }, [childViewIdentity]);
  useEffect(() => {
    const reader = childReader.current;
    if (!childScope || !childSessionId || !childReadAvailable) return;
    const child = reader.child;
    if (child?.sessionId !== childSessionId || child.executionId !== childExecutionId)
      reader.openChild(childSessionId, childExecutionId);
  }, [childScope, childReadAvailable, childSessionId, childExecutionId]);
  const displayMessages = useMemo(() => desktopConversationMessages(messages), [messages]);
  const readingParent = !preparing && !scheduledTasksView;
  const inputQueue = useNativeInputQueue({
    bridge,
    generation: state?.generation ?? generation.current,
    selection,
    historyEpoch: state?.historyEpoch ?? 0,
    available:
      readingParent &&
      !pending &&
      historyState.phase === 'complete' &&
      !selection?.viewLoading &&
      !selection?.permissionUnavailable &&
      !directory?.unavailable &&
      selected.current === selection?.session.id &&
      !selectionRead.current?.holdPresentation,
    onEditText: (text) => {
      if (
        !selection ||
        selected.current !== selection.session.id ||
        draftOwner.current !== imageScope(selection.storeId, selection.session.id) ||
        draftCache.current.get(imageScope(selection.storeId, selection.session.id))?.content
      )
        return false;
      changeDraft(text);
      setQueueFocusKey((value) => value + 1);
      return true;
    },
  });
  parentHistoryVisible.current = readingParent;
  useLayoutEffect(() => {
    if (!readingParent || selectionRead.current?.holdPresentation) {
      history.current?.close();
      return;
    }
    if (state?.selection && selected.current === state.selection.session.id)
      history.current?.select(state.generation, state.selection, state.historyEpoch);
  }, [readingParent, state]);
  const fileTargets = useNativeFileTargets({
    bridge,
    generation: state?.generation ?? generation.current,
    selection: !preparing && !scheduledTasksView ? selection : undefined,
    historyEpoch: state?.historyEpoch ?? 0,
    messages,
    includeRead: true,
  });
  const toolMessages = useNativeToolMessages({
    bridge,
    generation: state?.generation ?? generation.current,
    selection: !preparing && !scheduledTasksView ? selection : undefined,
    historyEpoch: state?.historyEpoch ?? 0,
    messages,
    observationRevision: selection?.viewGeneration ?? 0,
  });
  const liveTools = useMemo(
    () =>
      liveToolMessages(
        readingParent ? state?.selection : undefined,
        displayMessages,
        executionUnconfirmed,
        toolMessages.entries,
      ),
    [readingParent, state?.selection, displayMessages, executionUnconfirmed, toolMessages.entries],
  );
  const runMessages = useNativeRuns({
    bridge,
    generation: state?.generation ?? generation.current,
    selection: !preparing && !scheduledTasksView ? selection : undefined,
    historyEpoch: state?.historyEpoch ?? 0,
    messages,
    observationRevision: selection?.viewGeneration ?? 0,
  });
  // Retry only observations and original-ID lookups; never replay a submitted mutation.
  // Scope keys revoke pending callbacks on navigation, Store/generation change or shutdown.
  useEffect(() => {
    const work = new Map<string, () => unknown | Promise<unknown>>();
    const current = generation.current,
      epoch = readLifecycle.current.epoch,
      nonce = viewIntent.current,
      sessionId = selected.current;
    const scope = JSON.stringify([current, selection?.storeId, sessionId, epoch, nonce]);
    const active = () => isCurrentRead(current, epoch, nonce);
    const retrying = (key: string) => sessionRecovery.current.has(`${scope}:${key}`);
    const add = (key: string, action: () => unknown | Promise<unknown>) =>
      work.set(`${scope}:${key}`, async () => {
        if (active()) await action();
      });
    if (!readLifecycle.current.quitting && current > 0 && document.visibilityState !== 'hidden') {
      const readKey = JSON.stringify([current, epoch, nonce]);
      if (failedReads.state === readKey) add('state-read', refresh);
      if (failedReads.directory === JSON.stringify([current, epoch]))
        add('directory-read', readDirectory);
      if (failedReads.selection?.key === readKey) {
        const target = failedReads.selection.sessionId;
        add(`selection-read:${target}`, () => readSelection(target, current, nonce, epoch));
      }
      if (readingParent && selection && selection.session.id === sessionId) {
        if (
          historyState.phase === 'unavailable' ||
          selection.permissionUnavailable ||
          state?.callerUnavailable ||
          state?.backgroundUnavailable ||
          executionUnconfirmed ||
          (retrying('observation') && (historyState.phase === 'loading' || selection.viewLoading))
        )
          add('observation', refresh);
        if (fileTargets.error || (retrying('files') && fileTargets.loading))
          add('files', () => {
            if (!fileTargets.loading) fileTargets.retry();
          });
        if (toolMessages.error || (retrying('tools') && toolMessages.loading))
          add('tools', () => {
            if (!toolMessages.loading) toolMessages.retry();
          });
        if (runMessages.error || (retrying('runs') && runMessages.loading))
          add('runs', () => {
            if (!runMessages.loading) runMessages.retry();
          });
        if (inputQueue.error || (retrying('queue') && inputQueue.loading))
          add('queue', () => {
            if (!inputQueue.loading) inputQueue.retry();
          });
        for (const row of inputQueue.submissions)
          add(`queue:${row.commandId}`, () => inputQueue.lookup(row.commandId));
      }
      const lookup = (
        method: 'lookupInput' | 'caller.lookup' | 'lookupPermission' | 'lookupInteraction',
        commandId: string,
      ) =>
        add(`${method}:${commandId}`, async () => {
          await bridge.request({ method, generation: current, commandId });
          if (active()) await refresh();
        });
      for (const [id, input] of inputDeliveries)
        if (
          input.sessionId === sessionId &&
          input.storeId === selection?.storeId &&
          input.phase === 'unknown' &&
          !state?.inputSubmissions.some(
            (row) => row.intent.commandId === id && row.phase !== 'unknown',
          )
        )
          lookup('lookupInput', id);
      for (const row of state?.inputSubmissions ?? [])
        if (
          row.sessionId === sessionId &&
          row.intent.expectedStoreId === selection?.storeId &&
          (row.phase === 'unknown' ||
            (row.phase === 'accepted' && firstSubmission?.commandId !== row.intent.commandId))
        )
          lookup('lookupInput', row.intent.commandId);
      for (const row of state?.callerSubmissions ?? [])
        if (
          row.scope.sessionId === sessionId &&
          row.scope.storeId === selection?.storeId &&
          (row.phase === 'unknown' ||
            (row.phase === 'accepted' &&
              ['run.start', 'input.follow_up'].includes(row.request.kind) &&
              !state?.inputSubmissions.some(
                (input) => input.intent.commandId === row.request.commandId,
              )))
        )
          lookup('caller.lookup', row.request.commandId);
      for (const row of state?.permissionSubmissions ?? [])
        if (
          row.sessionId === sessionId &&
          row.intent.expectedStoreId === selection?.storeId &&
          row.phase === 'unknown'
        )
          lookup('lookupPermission', row.intent.commandId);
      for (const row of state?.interactionSubmissions ?? [])
        if (
          row.interaction.sessionId === sessionId &&
          row.intent.expectedStoreId === selection?.storeId &&
          row.phase === 'unknown'
        )
          lookup('lookupInteraction', row.intent.commandId);
      for (const row of state?.answerSubmissions ?? [])
        if (
          row.scope.sessionId === sessionId &&
          row.scope.storeId === selection?.storeId &&
          row.phase === 'unknown'
        )
          lookup('lookupInteraction', row.request.commandId);
      const original = firstSubmission;
      if (
        original &&
        (original.result?.phase === 'unknown' ||
          (original.result?.phase === 'accepted' &&
            state?.inputSubmissions.some(
              (input) =>
                input.intent.commandId === original.commandId && input.phase === 'accepted',
            ))) &&
        !scheduledTasksView &&
        original.creation.expectedStoreId === directory?.storeId &&
        (preparing || sessionId === original.creation.sessionId)
      ) {
        const page = pageIntent.current;
        add(`conversation:${original.commandId}`, async () => {
          const result = await bridge.request({
            method: 'conversation.lookup',
            generation: current,
            commandId: original.commandId,
          });
          if (
            active() &&
            result &&
            'kind' in result &&
            result.kind === 'conversation' &&
            'stage' in result
          ) {
            await acceptFirstResult(result, original, current, page);
            if (active()) await refresh();
          }
        });
      }
    }
    sessionRecovery.current.reconcile(work);
  });
  useEffect(() => {
    const changed = () => recoveryVisibilityChanged((value) => value + 1);
    document.addEventListener('visibilitychange', changed);
    return () => {
      document.removeEventListener('visibilitychange', changed);
      sessionRecovery.current.close();
    };
  }, []);
  const cacheMetrics = useNativeCacheMetrics({
    bridge,
    generation: state?.generation ?? generation.current,
    selection: !preparing && !scheduledTasksView ? selection : undefined,
    historyEpoch: state?.historyEpoch ?? 0,
    messages,
    historyComplete: historyState.phase === 'complete',
    observationRevision: selection?.viewGeneration ?? 0,
  });
  const contextUsage = useNativeContextUsage({
    bridge,
    generation: state?.generation ?? generation.current,
    selection: !preparing && !scheduledTasksView ? selection : undefined,
    historyEpoch: state?.historyEpoch ?? 0,
    messages,
    historyComplete: historyState.phase === 'complete',
    modelId:
      modelChoices.current.get(choiceKey)?.modelId ??
      (resolvedChoice?.identity === choiceIdentity ? resolvedChoice.choice?.modelId : undefined),
  });
  // File targets gate reads only. Run/Tool facts also determine the first history layout.
  const historyMetadataLoading = runMessages.loading || toolMessages.loading || fileTargets.loading;
  const conversationDomScope = JSON.stringify([
    state?.generation ?? generation.current,
    directory?.storeId,
  ]);
  const domMembership = useRef({ scope: '', sessions: new Set<string>(), revision: 0, directory });
  if (directory && !directory.unavailable) {
    const previous = domMembership.current;
    if (previous.scope !== conversationDomScope || previous.directory !== directory) {
      const sessions = new Set(directory.sessions.map((session) => session.id));
      domMembership.current = {
        scope: conversationDomScope,
        sessions,
        revision:
          previous.scope !== conversationDomScope
            ? 0
            : previous.revision + ([...previous.sessions].some((id) => !sessions.has(id)) ? 1 : 0),
        directory,
      };
    }
  }
  // Once presented, metadata continues to enrich the reading without hiding it.
  // Writes still require current history EOF and fresh selection authority.
  const replyDisplayScope = JSON.stringify([
    state?.generation ?? generation.current,
    selection?.storeId,
    selection?.session.id,
  ]);
  async function write(action: () => Promise<unknown>, requiresHistory = true, business = false) {
    if (
      writing.current ||
      (requiresHistory && state?.selection && historyState.phase !== 'complete')
    )
      return;
    writing.current = true;
    setPending(true);
    try {
      await report(action, true, business);
    } finally {
      writing.current = false;
      setPending(false);
      await report(refresh, false);
    }
  }
  async function writeInput(action: () => Promise<unknown>, requiresHistory = true) {
    await write(async () => {
      setSending(true);
      try {
        await action();
      } finally {
        setSending(false);
      }
    }, requiresHistory);
  }
  async function setPermissionMode(mode: 'accept_edits' | 'auto' | 'full', makeDefault: boolean) {
    if (!bridge || !selection?.permissions || !state) throw Error('permission_facts_unavailable');
    const sessionId = selection.session.id;
    const receipt = await bridge.request({
      method: 'permission.mode',
      generation: state.generation,
      observationId: selection.permissions.observationId,
      mode,
      makeDefault,
    });
    if (receipt && 'state' in receipt && receipt.state === 'applied')
      setFirstSubmission((previous) =>
        previous?.creation.sessionId === sessionId
          ? { ...previous, permissionMode: mode }
          : previous,
      );
    await refresh();
  }
  async function stopCurrentRun() {
    if (
      !bridge ||
      !selection ||
      !state ||
      !activeInputRun?.isActive ||
      activeInputRun.sessionId !== selection.session.id ||
      activeInputRun.originStoreId !== selection.storeId
    )
      throw Error('native_run_unavailable');
    const commandId = crypto.randomUUID();
    await bridge.request({
      method: 'caller.prepare',
      generation: state.generation,
      sessionId: selection.session.id,
      intent: {
        kind: 'command.cancel',
        expectedStoreId: selection.storeId,
        commandId,
        targetCommandId: activeInputRun.originCommandId,
      },
    });
    await bridge.request({ method: 'caller.submit', generation: state.generation, commandId });
  }
  function rememberDraft() {
    if (state?.selection && selected.current === state.selection.session.id) {
      const key = imageScope(state.selection.storeId, state.selection.session.id);
      // An input event already owns newer content, even before React commits it.
      if (!draftCache.current.has(key)) draftCache.current.set(key, { content: draft });
    }
  }
  function consumeInputDraft(commandId: string, storeId: string, sessionId: string) {
    const submitted = submittedDrafts.current.get(commandId);
    if (!submitted || submitted.storeId !== storeId || submitted.sessionId !== sessionId) return;
    submittedDrafts.current.delete(commandId);
    const key = imageScope(storeId, sessionId);
    if (draftCache.current.get(key) !== submitted.draft) return;
    draftCache.current.set(key, { content: '' });
    if (draftOwner.current === key && selected.current === sessionId) setDraft('');
  }
  function rememberConsumedDraft(
    commandId: string,
    scope: NativeCallerMetadata['scope'],
    proof: NativeCallerMetadata['draft'],
  ) {
    if (
      !proof ||
      proof.revision !== String(draftRevision.current) ||
      draftOwner.current !== imageScope(scope.storeId, scope.sessionId) ||
      selected.current !== scope.sessionId
    )
      return;
    // A receipt proves the submitted version, not that storage actually consumed it.
    // Reconcile lazily on Save without changing newer editor content or Plan state.
    consumedDraft.current = {
      ...scope,
      commandId,
      generation: generation.current,
      view: viewIntent.current,
      proof,
    };
  }
  function changeDraft(content: string) {
    if (!selection || selected.current !== selection.session.id) return;
    const key = imageScope(selection.storeId, selection.session.id);
    if (draftOwner.current !== key) return;
    // Publish edits synchronously so late saved reads cannot replace them.
    draftCache.current.set(key, { content });
    setDraft(content);
  }
  function changeNewDraft(content: string) {
    newDraftRevision.current++;
    setNewDraft(content);
  }
  async function chooseWorkspace(workspaceId: string, observedDirectory = directory) {
    if (!bridge || !observedDirectory?.workspaces.some((workspace) => workspace.id === workspaceId))
      return;
    const nonce = ++contextIntent.current,
      current = generation.current,
      storeId = observedDirectory.storeId;
    setContextBusy(true);
    try {
      const value = await bridge.request({
        method: 'conversation.branch',
        generation: current,
        workspaceId,
      });
      if (nonce !== contextIntent.current || generation.current !== current) return;
      if (
        !value ||
        !('kind' in value) ||
        value.kind !== 'conversation.branch' ||
        !('repository' in value) ||
        value.storeId !== storeId ||
        value.workspaceId !== workspaceId
      )
        throw Error('workspace_observation_unavailable');
      setNewWorkspace(workspaceId);
      setNewBranch(value);
      setTargetBranch(undefined);
    } catch (cause) {
      if (nonce === contextIntent.current && generation.current === current)
        setNewBranch(undefined);
      throw cause;
    } finally {
      if (nonce === contextIntent.current) setContextBusy(false);
    }
  }
  function prepareConversation(workspaceId?: string) {
    setNewChoice({});
    setNewModelReady({ ready: false });
    setNewModelRevision((value) => value + 1);
    rememberDraft();
    pageIntent.current++;
    setScheduledTasksView(false);
    setToolsOpen(false);
    setPreparing(true);
    if (newPermission === undefined && selection?.permissions)
      setNewPermission(selection.permissions.mode.mode);
    if (firstRef.current?.result?.phase !== 'unknown' && !pending) setFirstSubmission(undefined);
    const target = workspaceId ?? directory?.workspaces[0]?.id;
    // The directory already identifies the target. Branch reads qualify sending,
    // rather than temporarily clearing the project shown by the page and sidebar.
    setNewWorkspace(target ?? '');
    if (target !== newWorkspace || newBranch?.storeId !== directory?.storeId)
      setNewBranch(undefined);
    setTargetBranch(undefined);
    if (target) void report(() => chooseWorkspace(target), true, true);
    else {
      contextIntent.current++;
      setContextBusy(false);
    }
  }
  async function acceptWorkspaceRemoval(value: NativeResult) {
    if (
      !value ||
      !('kind' in value) ||
      value.kind !== 'workspace.removal' ||
      !('phase' in value) ||
      !('storeId' in value) ||
      value.phase !== 'applied' ||
      value.storeId !== directory?.storeId
    )
      return;
    history.current?.evictStore(value.storeId);
    if (
      selection?.session.workspaceId === value.workspaceId ||
      newWorkspace === value.workspaceId
    ) {
      pageIntent.current++;
      viewIntent.current++;
      contextIntent.current++;
      selected.current = undefined;
      setMessages([]);
      setDraft('');
      setPreparing(true);
      setScheduledTasksView(false);
      setToolsOpen(false);
      setNewWorkspace('');
      setNewBranch(undefined);
      setTargetBranch(undefined);
      if (firstRef.current?.creation.workspaceId === value.workspaceId)
        setFirstSubmission(undefined);
    }
    await readDirectory();
    await refresh();
  }
  async function removeWorkspace(workspaceId: string) {
    if (!bridge || removingWorkspace) return;
    const current = generation.current,
      label = directory?.workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId;
    setRemovingWorkspace(label);
    try {
      const value = await bridge.request({
        method: 'workspace.remove',
        generation: current,
        workspaceId,
      });
      if (generation.current === current) await acceptWorkspaceRemoval(value);
    } finally {
      setRemovingWorkspace(undefined);
      await report(refresh, false);
    }
  }
  async function lookupWorkspaceRemoval(commandId: string) {
    if (!bridge) return;
    const value = await bridge.request({
      method: 'workspace.removal.lookup',
      generation: generation.current,
      commandId,
    });
    await acceptWorkspaceRemoval(value);
    await refresh();
  }
  async function addWorkspace() {
    if (!bridge) return;
    await write(
      async () => {
        const current = generation.current,
          page = pageIntent.current;
        const picked = await bridge.request({ method: 'workspace.pick', generation: current });
        await readDirectory();
        if (
          current !== generation.current ||
          page !== pageIntent.current ||
          !picked ||
          !('kind' in picked) ||
          picked.kind !== 'workspace.picked' ||
          !('workspaceId' in picked)
        )
          return;
        rememberDraft();
        setPreparing(true);
        setScheduledTasksView(false);
        setToolsOpen(false);
        // The host returns the actual registered identity, never a guessed new directory item.
        const value = await bridge.request({
          method: 'conversation.branch',
          generation: current,
          workspaceId: picked.workspaceId,
        });
        if (
          current === generation.current &&
          page === pageIntent.current &&
          value &&
          'kind' in value &&
          value.kind === 'conversation.branch' &&
          'repository' in value
        ) {
          setNewWorkspace(value.workspaceId);
          setNewBranch(value);
          setTargetBranch(undefined);
        }
      },
      false,
      true,
    );
  }
  function firstIntent(
    commandId: string,
    text: string,
    files: readonly { name: string; uri: string }[] = [],
  ): Extract<NativeRequest, { method: 'conversation.send' }>['intent'] {
    return {
      kind: 'run.start',
      expectedStoreId: directory!.storeId,
      commandId,
      content: text,
      ...(files.length ? { files: files.map(({ name, uri }) => ({ name, uri })) } : {}),
      ...newModelReady.choice,
      ...(newPlanMode
        ? {
            extensionInputs: [
              { extensionId: 'builtin.planning', definitionVersion: '1', input: { mode: 'plan' } },
            ],
          }
        : {}),
    };
  }
  async function acceptFirstResult(
    value: NativeConversationResult,
    original: NonNullable<typeof firstSubmission>,
    current: number,
    page: number,
  ) {
    if (current !== generation.current || firstRef.current?.commandId !== original.commandId)
      return;
    setFirstSubmission({ ...original, result: value });
    if (
      value.phase === 'unknown' &&
      original.result?.phase === 'unknown' &&
      value.creation?.phase === original.result.creation?.phase &&
      value.creation?.input.sessionId === original.result.creation?.input.sessionId
    )
      return;
    // Directory observation is recoverable independently of the known receipt.
    // Do not turn an acknowledged submission back into unknown or stop handoff.
    void readDirectory().catch(() => {});
    if (value.creation?.phase === 'created') {
      if (value.phase === 'accepted') setNewPlanMode(false);
      const sessionId = value.creation.input.sessionId;
      if (value.phase === 'accepted')
        imageDrafts.removeIds([
          ...(original.imageIds ?? []),
          ...(original.files?.map((file) => file.id) ?? []),
        ]);
      else if (original.imageScope)
        imageDrafts.move(
          original.imageScope,
          imageScope(value.creation.input.expectedStoreId, sessionId),
        );
      modelChoices.current.set(
        JSON.stringify([
          value.creation.input.expectedStoreId,
          value.creation.input.workspaceId,
          sessionId,
        ]),
        original.choice,
      );
      planModes.current.set(
        JSON.stringify([
          value.creation.input.expectedStoreId,
          value.creation.input.workspaceId,
          sessionId,
        ]),
        value.phase === 'accepted' ? false : original.plan,
      );
      const key = imageScope(value.creation.input.expectedStoreId, sessionId);
      if (draftCache.current.get(key) === original.draft) {
        const next = value.phase === 'accepted' ? { content: '' } : original.draft;
        draftCache.current.set(key, next);
        if (value.phase === 'accepted')
          firstAcceptedDraft.current = { commandId: original.commandId, draft: next };
      }
      if (
        (page === pageIntent.current || firstOpenPage.current === pageIntent.current) &&
        (selected.current !== sessionId || preparing)
      ) {
        // The selection records its own read recovery. Its failure cannot
        // invalidate the already acknowledged first-submission receipt.
        await select(sessionId, false).catch(() => {});
      }
    } else if (
      value.phase !== 'accepted' &&
      newDraftRevision.current === original.preparationRevision
    )
      setNewDraft((draft) => draft || original.draft.content);
    if (value.code && value.code !== 'conversation_continue_explicit') {
      setBusinessError(false);
      setError(value.code);
    }
  }
  function sendFirst() {
    if (
      writing.current ||
      contextBusy ||
      !bridge ||
      !directory ||
      !newWorkspace ||
      newBranch?.workspaceId !== newWorkspace ||
      newBranch.storeId !== directory.storeId ||
      !newModelReady.ready ||
      (!newDraft.trim() &&
        !imageDrafts.get(newImageScope).length &&
        !imageDrafts.files(newImageScope).length) ||
      imageDrafts.get(newImageScope).some((image) => image.loading || image.error) ||
      firstSubmission?.result?.phase === 'unknown'
    )
      return;
    const current = generation.current,
      page = pageIntent.current;
    firstOpenPage.current = page;
    const original = {
      creation: {
        expectedStoreId: directory.storeId,
        workspaceId: newWorkspace,
        commandId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        title: '',
      },
      commandId: crypto.randomUUID(),
      text: promptTextForSend(newDraft),
      draft: { content: newDraft },
      preparationRevision: newDraftRevision.current,
      imageScope: newImageScope,
      imageIds: imageDrafts.get(newImageScope).map((image) => image.id),
      images: imageDrafts.get(newImageScope).map(({ name }) => ({ name })),
      files: imageDrafts.files(newImageScope),
      choice: newModelReady.choice ?? newChoice,
      plan: newPlanMode,
      permissionMode: preparedPermission,
    };
    firstRef.current = original;
    setFirstSubmission(original);
    draftCache.current.set(
      imageScope(original.creation.expectedStoreId, original.creation.sessionId),
      original.draft,
    );
    setNewDraft('');
    void writeInput(async () => {
      try {
        const value = await bridge.request({
          method: 'conversation.send',
          generation: current,
          creation: original.creation,
          intent: firstIntent(original.commandId, original.text, original.files),
          imageIds: original.imageIds,
          fileIds: original.files?.filter((file) => file.prepared).map((file) => file.id),
          permissionMode: original.permissionMode,
          targetBranch,
        });
        if (!value || !('kind' in value) || value.kind !== 'conversation' || !('stage' in value))
          throw Error('conversation_response_unknown');
        await acceptFirstResult(value, original, current, page);
      } catch (cause) {
        const code = (cause as { code?: string })?.code ?? (cause as Error)?.message;
        const value: NativeConversationResult = {
          kind: 'conversation',
          commandId: original.commandId,
          phase: [
            'invalid_native_request',
            'native_request_too_large',
            'native_sender_denied',
          ].includes(code)
            ? 'failed'
            : 'unknown',
          stage: 'create',
          code: code === 'native_request_too_large' ? code : 'conversation_response_unknown',
        };
        if (firstRef.current?.commandId === original.commandId) {
          setFirstSubmission({ ...original, result: value });
          setNewDraft((draft) => draft || original.draft.content);
        }
        throw cause;
      }
    }, false);
  }
  function sendInput() {
    if (!bridge || !selection) return;
    const images = imageDrafts.get(imageScope(selection.storeId, selection.session.id));
    const files = imageDrafts.files(imageScope(selection.storeId, selection.session.id));
    const draftKey = imageScope(selection.storeId, selection.session.id);
    const submittedDraft = draftCache.current.get(draftKey) ?? { content: draft };
    const submittedText = promptTextForSend(submittedDraft.content);
    if (!submittedText.trim() && !images.length && !files.length) return;
    if (images.some((image) => image.loading || image.error)) return;
    const imageIds = images.map((image) => image.id);
    void writeInput(async () => {
      const current = state?.generation ?? 0,
        nonce = viewIntent.current,
        sessionId = selection.session.id,
        commandId = crypto.randomUUID(),
        submittedRevision = draftRevision.current;
      draftCache.current.set(draftKey, submittedDraft);
      const intent = {
        ...nativeTextIntent(
          selection,
          commandId,
          submittedText,
          planMode,
          resolvedChoice?.identity === choiceIdentity ? resolvedChoice.choice : undefined,
          executionUnconfirmed,
        ),
        ...(files.length ? { files: files.map(({ name, uri }) => ({ name, uri })) } : {}),
      };
      if (intent.kind !== 'input.steer' && !nextModelReady)
        throw Error('model_selection_unavailable');
      if (
        firstSubmission?.creation.sessionId === sessionId &&
        firstSubmission.result?.phase === 'failed' &&
        intent.kind === 'run.start'
      ) {
        const original = {
          ...firstSubmission,
          commandId,
          text: submittedText,
          draft: submittedDraft,
          imageScope: imageScope(selection.storeId, sessionId),
          imageIds,
          files,
          images: images.map(({ name }) => ({ name })),
          choice: resolvedChoice?.choice ?? {},
          plan: planMode,
          result: undefined,
        };
        firstRef.current = original;
        setFirstSubmission(original);
        setDraft('');
        const page = pageIntent.current;
        try {
          const value = await bridge.request({
            method: 'conversation.send',
            generation: current,
            creation: original.creation,
            intent,
            permissionMode: original.permissionMode,
            imageIds,
            fileIds: files.filter((file) => file.prepared).map((file) => file.id),
          });
          if (!value || !('kind' in value) || value.kind !== 'conversation' || !('stage' in value))
            throw Error('conversation_response_unknown');
          await acceptFirstResult(value, original, current, page);
        } catch (cause) {
          const code = (cause as { code?: string })?.code ?? (cause as Error)?.message;
          if (firstRef.current?.commandId === original.commandId) {
            setFirstSubmission({
              ...original,
              result: {
                kind: 'conversation',
                commandId,
                stage: 'input',
                creation: { input: original.creation, phase: 'created' },
                phase: [
                  'invalid_native_request',
                  'native_request_too_large',
                  'native_sender_denied',
                ].includes(code)
                  ? 'failed'
                  : 'unknown',
                code: 'conversation_response_unknown',
              },
            });
            if (
              draftCache.current.get(draftKey) === submittedDraft &&
              nonce === viewIntent.current &&
              current === generation.current
            )
              setDraft((draft) => draft || original.draft.content);
          }
          throw cause;
        }
        return;
      }
      submittedDrafts.current.set(commandId, {
        storeId: selection.storeId,
        sessionId,
        draft: submittedDraft,
      });
      setInputDeliveries((previous) => {
        const predecessor = [...previous]
          .reverse()
          .find(
            ([, input]) => input.storeId === selection.storeId && input.sessionId === sessionId,
          );
        return new Map(previous).set(commandId, {
          storeId: selection.storeId,
          sessionId,
          kind: intent.kind,
          ...(intent.kind === 'input.steer' ? { targetRunId: intent.targetRunId } : {}),
          afterMessageId: displayMessages.at(-1)?.id,
          afterInputCommandId: predecessor?.[0],
          text: submittedText,
          phase: 'sending',
          files: files.map(({ name }) => ({ name })),
          images: images.map(({ name }) => ({ name })),
        });
      });
      let value: NativeResult;
      try {
        value = await bridge.request({
          method: 'submit',
          generation: current,
          sessionId,
          intent,
          imageIds,
          fileIds: files.filter((file) => file.prepared).map((file) => file.id),
        });
      } catch (cause) {
        const code =
          (cause as { code?: string; message?: string })?.code ?? (cause as Error)?.message;
        setInputDeliveries((previous) => {
          const next = new Map(previous),
            original = next.get(commandId);
          if (original)
            next.set(commandId, {
              ...original,
              phase: [
                'invalid_native_request',
                'native_request_too_large',
                'native_sender_denied',
              ].includes(code)
                ? 'failed'
                : 'unknown',
            });
          return next;
        });
        throw cause;
      }
      setInputDeliveries((previous) => {
        const next = new Map(previous),
          original = next.get(commandId);
        if (original)
          next.set(commandId, {
            ...original,
            phase:
              value && 'phase' in value && ['accepted', 'applied', 'terminal'].includes(value.phase)
                ? 'accepted'
                : value && 'phase' in value && ['failed', 'rejected'].includes(value.phase)
                  ? 'failed'
                  : 'unknown',
          });
        return next;
      });
      const accepted =
        value && 'phase' in value && ['accepted', 'applied', 'terminal'].includes(value.phase);
      if (accepted) imageDrafts.removeIds([...imageIds, ...files.map((file) => file.id)]);
      if (accepted && current === generation.current) {
        if (value && 'draft' in value)
          rememberConsumedDraft(
            commandId,
            { storeId: selection.storeId, workspaceId: selection.session.workspaceId, sessionId },
            value.draft,
          );
        consumeInputDraft(commandId, selection.storeId, sessionId);
      }
      if (
        nonce === viewIntent.current &&
        current === generation.current &&
        draftRevision.current === submittedRevision &&
        accepted
      ) {
        setPlanMode(false);
        planModes.current.delete(
          JSON.stringify([selection.storeId, selection.session.workspaceId, sessionId]),
        );
      }
    });
  }
  const hasPendingInteraction = selection?.interactions.some(
    (card) =>
      ['approval', 'question', 'plan_review'].includes(card.kind) && card.state === 'pending',
  );
  const hasPendingRootInteraction = nativeRootInteractionBlocksComposer(selection);
  const canCompose =
    !!selection && !selection.session.parentSessionId && !hasPendingRootInteraction;
  const savedFirstInput = useRef<string | undefined>(undefined);
  const firstInputIdentity =
    firstSubmission &&
    JSON.stringify([firstSubmission.creation.expectedStoreId, firstSubmission.commandId]);
  const firstVisible =
    firstSubmission &&
    directory?.storeId === firstSubmission.creation.expectedStoreId &&
    (preparing ||
      (selection?.storeId === firstSubmission.creation.expectedStoreId &&
        selection.session.id === firstSubmission.creation.sessionId));
  const firstSaved =
    firstVisible &&
    (savedFirstInput.current === firstInputIdentity ||
      messages.some((message) =>
        savedNativeInput(
          message,
          firstSubmission.commandId,
          {
            storeId: firstSubmission.creation.expectedStoreId,
            sessionId: firstSubmission.creation.sessionId,
          },
          selection,
        ),
      ));
  useEffect(() => {
    if (!firstSubmission) return;
    const original = firstSubmission;
    const rejected = state?.inputSubmissions.find(
      (input) =>
        input.intent.commandId === original.commandId &&
        input.intent.expectedStoreId === original.creation.expectedStoreId &&
        input.sessionId === original.creation.sessionId &&
        input.phase === 'rejected',
    );
    if (!rejected) return;
    setFirstSubmission((previous) =>
      previous?.commandId === original.commandId && previous.result?.phase !== 'failed'
        ? {
            ...previous,
            result: {
              kind: 'conversation',
              commandId: original.commandId,
              stage: 'input',
              creation: { input: original.creation, phase: 'created' },
              input: rejected,
              phase: 'failed',
              code: rejected.error,
            },
          }
        : previous,
    );
    const accepted = firstAcceptedDraft.current;
    const key = imageScope(original.creation.expectedStoreId, original.creation.sessionId);
    if (
      accepted?.commandId === original.commandId &&
      draftCache.current.get(key) === accepted.draft &&
      selection?.storeId === original.creation.expectedStoreId &&
      selection.session.id === original.creation.sessionId &&
      selected.current === original.creation.sessionId
    ) {
      draftCache.current.set(key, original.draft);
      setDraft((current) => current || original.draft.content);
      firstAcceptedDraft.current = undefined;
    }
  }, [firstSubmission, state?.inputSubmissions, selection]);
  useLayoutEffect(() => {
    // A later cold read must not revive a first-input placeholder already
    // replaced by verified history. Keep its receipt/retry owner intact.
    if (firstSaved) savedFirstInput.current = firstInputIdentity;
  }, [firstSaved, firstInputIdentity]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The revision invalidates the current-view body map after verified reads and reader disposal.
  const freshTranscript = useMemo(() => {
    if (!readingParent) return { messages: [] };
    if (!selection) return { messages: desktopMessages(displayMessages) };
    return desktopTranscript({
      messages: displayMessages,
      runs: runMessages.runs,
      tools: toolMessages.entries,
      executions: selection.executions,
      compressionMessages: selection.compressionMessages,
      compressionProgress: selection.compressionProgress,
      storeId: selection.storeId,
      sessionId: selection.session.id,
      fullReply: (message) => {
        const body = verifiedReplyBodies.current.get(
          JSON.stringify([replyDisplayScope, message.id]),
        );
        return body?.identity === nativeReplyKey(replyDisplayScope, message)
          ? body.text
          : undefined;
      },
    });
  }, [
    readingParent,
    displayMessages,
    runMessages.runs,
    toolMessages.entries,
    selection,
    replyDisplayScope,
    verifiedReplyRevision,
  ]);
  const transcript = transcriptDisplay.current.project({
    bridge,
    boundary: JSON.stringify([state?.generation, directory?.storeId ?? selection?.storeId]),
    key:
      readingParent && selection
        ? JSON.stringify([
            state?.generation,
            selection.storeId,
            selection.session.id,
            selection.session.workspaceId,
            state?.historyEpoch ?? 0,
          ])
        : undefined,
    messages: displayMessages,
    replies: displayMessages.map((message) =>
      verifiedReplyBodies.current.get(JSON.stringify([replyDisplayScope, message.id])),
    ),
    transcript: freshTranscript,
    loading: historyMetadataLoading,
    unavailable:
      historyState.phase === 'unavailable' ||
      !!runMessages.error ||
      !!toolMessages.error ||
      !!fileTargets.error ||
      !!(selection?.permissionUnavailable && !selection.viewLoading),
    complete:
      historyState.phase === 'complete' &&
      !!selection &&
      !selection.viewLoading &&
      !selection.permissionUnavailable,
  });
  useEffect(() => {
    if (!displayMessages.length || !selection) return;
    setInputDeliveries((previous) => {
      const next = new Map(
        [...previous].filter(
          ([id, input]) =>
            !displayMessages.some((message) => savedNativeInput(message, id, input, selection)),
        ),
      );
      return next.size === previous.size ? previous : next;
    });
  }, [displayMessages, selection]);
  const pendingInputModels = useMemo(
    () =>
      [...inputDeliveries].flatMap(([id, input]) => {
        if (
          preparing ||
          input.storeId !== selection?.storeId ||
          input.sessionId !== selection.session.id ||
          displayMessages.some((message) => savedNativeInput(message, id, input, selection))
        )
          return [];
        const metadata = state?.inputSubmissions.find(
          (row) =>
            row.intent.commandId === id &&
            row.sessionId === input.sessionId &&
            row.intent.expectedStoreId === input.storeId,
        );
        const phase = metadata
          ? ['accepted', 'applied', 'terminal'].includes(metadata.phase)
            ? 'accepted'
            : ['failed', 'rejected'].includes(metadata.phase)
              ? 'failed'
              : metadata.phase === 'unknown'
                ? 'unknown'
                : 'sending'
          : input.phase;
        return [
          {
            ...nativePendingInputMessage(id, input, phase, selection),
            hasAttachments: !!(input.files?.length || input.images?.length),
          },
        ];
      }),
    [inputDeliveries, preparing, selection, displayMessages, state?.inputSubmissions],
  );
  const rejectedInputs = useMemo(() => {
    const rejected = new Map<string, string | undefined>();
    if (!selection) return rejected;
    for (const row of state?.callerSubmissions ?? [])
      if (
        row.phase === 'rejected' &&
        ['run.start', 'input.follow_up'].includes(row.request.kind) &&
        row.scope.storeId === selection.storeId &&
        row.scope.sessionId === selection.session.id
      )
        rejected.set(row.request.commandId, undefined);
    for (const input of state?.inputSubmissions ?? [])
      if (
        input.phase === 'rejected' &&
        ['run.start', 'input.follow_up'].includes(input.intent.kind) &&
        input.intent.expectedStoreId === selection.storeId &&
        input.sessionId === selection.session.id
      )
        rejected.set(input.intent.commandId, input.error);
    return rejected;
  }, [selection, state?.callerSubmissions, state?.inputSubmissions]);
  const rejectedInputAnchors = useRef(new Map<string, string | null>());
  useLayoutEffect(() => {
    if (
      !selection ||
      preparing ||
      selection.viewLoading ||
      historyState.phase !== 'complete' ||
      history.current?.state !== historyState ||
      historyMetadataLoading ||
      selectionRead.current?.holdPresentation
    )
      return;
    for (const commandId of rejectedInputs.keys()) {
      const key = JSON.stringify([replyDisplayScope, commandId]);
      if (
        !rejectedInputAnchors.current.has(key) &&
        !displayMessages.some((message) =>
          savedNativeInput(
            message,
            commandId,
            { storeId: selection.storeId, sessionId: selection.session.id },
            selection,
          ),
        )
      )
        // No historical input exists to order this rejection. Fix its first
        // fully read position so later explicit inputs do not move it forward.
        rejectedInputAnchors.current.set(key, displayMessages.at(-1)?.id ?? null);
    }
    while (rejectedInputAnchors.current.size > 256)
      rejectedInputAnchors.current.delete(rejectedInputAnchors.current.keys().next().value!);
  }, [
    selection,
    preparing,
    historyState,
    historyMetadataLoading,
    displayMessages,
    rejectedInputs,
    replyDisplayScope,
  ]);
  const messageModels = useMemo(() => {
    const models = preparing ? [] : [...transcript.messages];
    models.push(...liveTools.map((entry) => entry.message));
    const pendingIds = new Set(pendingInputModels.map((input) => input.id));
    for (const input of pendingInputModels) {
      // Run observation can arrive before persisted user history. Keep the
      // original input ahead of its own status, tool output and reply throughout.
      const delivery = inputDeliveries.get(input.id)!;
      const afterMessageId = delivery.afterMessageId;
      const afterMessageIndex = afterMessageId
        ? models.findIndex((message) => message.id === afterMessageId)
        : -1;
      const previousCommandId = delivery.afterInputCommandId;
      const savedPredecessor = previousCommandId
        ? displayMessages.find((message) =>
            savedNativeInput(message, previousCommandId, delivery, selection),
          )
        : undefined;
      const afterInputIndex = previousCommandId
        ? models.findIndex(
            (message) => message.id === previousCommandId || message.id === savedPredecessor?.id,
          )
        : -1;
      const afterIndex = Math.max(afterMessageIndex, afterInputIndex);
      const index = input.turnId
        ? models.findIndex(
            (message, index) =>
              index > afterIndex && message.turnId === input.turnId && !pendingIds.has(message.id),
          )
        : -1;
      if (index < 0) models.push(input);
      else models.splice(index, 0, input);
    }
    if (firstVisible && !firstSaved) {
      const turnId = nativeInputTurnId(
        firstSubmission.commandId,
        {
          storeId: firstSubmission.creation.expectedStoreId,
          sessionId: firstSubmission.creation.sessionId,
        },
        selection,
      );
      const ownTurn = turnId ? models.findIndex((model) => model.turnId === turnId) : -1;
      // An explicit first-input retry keeps its created Session and earlier saved input.
      // Place the new attempt after that history, ahead of its own observed activity.
      const position =
        ownTurn >= 0 ? ownTurn : models.some((model) => model.role === 'user') ? models.length : 0;
      models.splice(position, 0, {
        id: firstSubmission.commandId,
        ...(turnId ? { turnId } : {}),
        role: 'user',
        text: firstSubmission.text,
        hasAttachments: !!(firstSubmission.files?.length || firstSubmission.images?.length),
        settled: firstSubmission.result?.phase === 'accepted',
        copyText: null,
        delivery:
          firstSubmission.result?.phase === 'accepted'
            ? undefined
            : firstSubmission.result?.phase === 'failed'
              ? 'failed'
              : firstSubmission.result?.phase === 'unknown'
                ? 'unknown'
                : 'sending',
      });
    }
    if (selection && !preparing) {
      for (const [commandId, reason] of rejectedInputs) {
        const persisted = displayMessages.find((message) =>
          savedNativeInput(
            message,
            commandId,
            { storeId: selection.storeId, sessionId: selection.session.id },
            selection,
          ),
        );
        const index = models.findIndex((model) => model.id === (persisted?.id ?? commandId));
        if (index < 0) {
          // Preparation may reject before Core saves any Message or Run. The verified
          // original rejection remains visible without inventing a historical input.
          const key = JSON.stringify([replyDisplayScope, commandId]);
          const anchor = rejectedInputAnchors.current.get(key);
          const anchorIndex = anchor ? models.findIndex((model) => model.id === anchor) : -1;
          let position = anchor === null ? 0 : models.length;
          if (anchorIndex >= 0) {
            position = anchorIndex + 1;
            const turnId = models[anchorIndex]?.turnId;
            while (turnId && models[position]?.turnId === turnId) position++;
          }
          models.splice(position, 0, nativeInputFailureMessage(commandId, reason));
          continue;
        }
        const turnId =
          models[index]?.turnId ??
          JSON.stringify(['native-input', selection.storeId, selection.session.id, commandId]);
        models[index] = { ...models[index]!, turnId };
        if (models.some((model) => model.turnId === turnId && model.systemKind === 'turn_failure'))
          continue;
        models.splice(index + 1, 0, {
          ...nativeInputFailureMessage(commandId, reason),
          turnId,
        });
      }
    }
    return groupNativeToolMessages(models);
  }, [
    preparing,
    transcript.messages,
    liveTools,
    pendingInputModels,
    inputDeliveries,
    rejectedInputs,
    replyDisplayScope,
    displayMessages,
    firstVisible,
    firstSaved,
    firstSubmission,
    selection,
  ]);
  const messagesById = useMemo(
    () => new Map(displayMessages.map((message) => [message.id, message])),
    [displayMessages],
  );
  const interactionCards =
    selection && state ? (
      <NativeApprovalGroup
        interactions={selection.interactions}
        storeId={selection.storeId}
        rootSessionId={
          selection.session.rootSessionId ??
          (!selection.session.parentSessionId ? selection.session.id : '')
        }
        owners={environment.approvalOwners}
        renderInteraction={(interaction, embedded) => {
          const draftKey = questionDraftKey(interaction);
          const saved = state?.answerSubmissions?.find(
            (row) =>
              row.scope.storeId === interaction.originStoreId &&
              row.scope.sessionId === interaction.presentationSessionId &&
              row.interaction.id === interaction.id &&
              row.interaction.revision === interaction.revision,
          );
          const currentSubmission = state?.interactionSubmissions.find(
            (row) => questionDraftKey(row.interaction) === draftKey,
          );
          return (
            <InteractionCard
              compactApproval={embedded}
              key={JSON.stringify([
                draftKey,
                interaction.kind === 'plan_review' &&
                  selection.runs.some(
                    (run) =>
                      run.id === interaction.runId &&
                      run.sessionId === interaction.sessionId &&
                      run.originStoreId === interaction.originStoreId &&
                      run.status === 'cancelled' &&
                      !run.isActive,
                  ),
              ])}
              interaction={interaction}
              renderApproval={(props) => (
                <NativeApproval
                  {...props}
                  embedded={embedded}
                  disabled={
                    props.disabled ||
                    !!selection.viewLoading ||
                    !!selection.permissionUnavailable ||
                    historyState.phase !== 'complete' ||
                    !!directory?.unavailable
                  }
                  onAnswer={
                    props.onAnswer
                      ? async (card, answer) => {
                          await report(() => Promise.resolve(props.onAnswer!(card, answer)));
                        }
                      : undefined
                  }
                />
              )}
              onReadAttachment={attachmentReader}
              submission={
                saved
                  ? { phase: saved.phase, commandId: saved.request.commandId }
                  : currentSubmission
                    ? {
                        phase: currentSubmission.phase,
                        commandId: currentSubmission.intent.commandId,
                        error: currentSubmission.error,
                      }
                    : undefined
              }
              initialQuestionDraft={questionDrafts.current.get(draftKey)?.draft}
              onQuestionDraftChange={(draft) =>
                questionDrafts.current.set(draftKey, {
                  storeId: interaction.originStoreId,
                  sourceSessionId: interaction.sessionId,
                  presentationSessionId: interaction.presentationSessionId,
                  cardId: interaction.id,
                  draft,
                })
              }
              initialPlanDraft={planDrafts.current.get(draftKey)?.draft}
              onPlanDraftChange={(draft) =>
                planDrafts.current.set(draftKey, {
                  storeId: interaction.originStoreId,
                  sourceSessionId: interaction.sessionId,
                  presentationSessionId: interaction.presentationSessionId,
                  cardId: interaction.id,
                  runId: interaction.runId,
                  draft,
                })
              }
              onAnswer={async (_card, answer) => {
                await bridge.request({
                  method: 'interaction.answer',
                  generation: generation.current,
                  interactionId: interaction.id,
                  revision: interaction.revision,
                  answer,
                });
                await refresh();
              }}
            />
          );
        }}
      />
    ) : undefined;
  const sessionTools = (
    <section id="native-session-tools" aria-label="会话与任务">
      <header>
        <h2>会话与任务</h2>
      </header>
      {selection && state && (
        <details
          data-interaction-history
          onToggle={(event) => setInteractionHistoryOpen(event.currentTarget.open)}
        >
          <summary>交互记录</summary>
          {interactionHistoryOpen && (
            <NativeInteractionHistory
              bridge={bridge}
              generation={state.generation}
              selection={selection}
              historyEpoch={state.historyEpoch ?? 0}
            />
          )}
        </details>
      )}
      <details>
        <summary>目录与已保存草稿</summary>
        <section aria-label="工作区与会话">
          <h2>已读取的工作区与会话</h2>
          <button
            type="button"
            onClick={() =>
              void write(async () => {
                await bridge.request({ method: 'workspace.pick', generation: generation.current });
                await readDirectory();
              })
            }
          >
            选择本地项目
          </button>
          <button type="button" onClick={() => void report(readDirectory)}>
            重新读取目录
          </button>
          <button
            type="button"
            onClick={() =>
              void report(async () => {
                const value = await bridge.request({
                  method: 'draft.list',
                  generation: generation.current,
                });
                if (value && 'drafts' in value) setSavedDrafts(value);
              })
            }
          >
            读取已保存草稿
          </button>
          {savedDrafts?.drafts.map((saved) => (
            <button
              type="button"
              key={saved.id}
              onClick={() =>
                void report(async () => {
                  const value = await bridge.request({
                    method: 'draft.original',
                    generation: generation.current,
                    draftId: saved.id,
                  });
                  if (value && 'content' in value && 'revision' in value) setOriginalDraft(value);
                })
              }
            >
              {diagnostics
                ? `草稿 ${saved.rootSessionId} · 修订 ${saved.revision}`
                : '读取已保存草稿'}
            </button>
          ))}
          {savedDrafts?.nextId && (
            <button
              type="button"
              onClick={() =>
                void report(async () => {
                  const value = await bridge.request({
                    method: 'draft.list',
                    generation: generation.current,
                    afterId: savedDrafts.nextId!,
                  });
                  if (value && 'drafts' in value) setSavedDrafts(value);
                })
              }
            >
              下一页草稿
            </button>
          )}
          {originalDraft && (
            <section aria-label="原关联草稿">
              <p>
                {originalDraft.association === 'current'
                  ? '原关联仍有效；此处仅阅读已保存文本。'
                  : '原关联不可用，文本已保留，没有绑定当前会话。'}
              </p>
              <p>
                {diagnostics
                  ? `原会话 ${originalDraft.rootSessionId} · 修订 ${originalDraft.revision}`
                  : '已保存的原关联草稿'}
              </p>
              <textarea aria-label="保留的原关联草稿" value={originalDraft.content} readOnly />
              <button type="button" onClick={() => setOriginalDraft(undefined)}>
                关闭草稿阅读
              </button>
            </section>
          )}
          {state?.creationSubmissions
            .filter((submission) => diagnostics || submission.phase !== 'created')
            .map((submission) => (
              <section key={submission.input.commandId} aria-label="会话创建意图">
                <p>
                  {diagnostics ? `原会话 ${submission.input.sessionId} · 创建` : '创建会话：'}
                  {submission.phase === 'pending'
                    ? '正在提交'
                    : submission.phase === 'unknown'
                      ? '结果待核实'
                      : submission.phase === 'created'
                        ? '已确认'
                        : '被拒绝'}
                </p>
                <NativeDiagnostic>
                  <p>
                    原创建命令 {submission.input.commandId} · 原工作区{' '}
                    {submission.input.workspaceId}
                  </p>
                </NativeDiagnostic>
                <p>{submission.code}</p>
                {(submission.phase === 'unknown' || submission.phase === 'pending') && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      void write(async () => {
                        await bridge.request({
                          method: 'lookupCreation',
                          generation: generation.current,
                          commandId: submission.input.commandId,
                        });
                        apply(
                          await bridge.request({ method: 'state', generation: generation.current }),
                        );
                        await readDirectory();
                      })
                    }
                  >
                    核实原创建命令
                  </button>
                )}
              </section>
            ))}
        </section>
      </details>
      {state && directory && (
        <NativeBackgroundPanel
          bridge={bridge}
          generation={state.generation}
          storeId={directory.storeId}
          unavailable={state.backgroundUnavailable ?? false}
          onChanged={refresh}
        />
      )}
      {selection && state && (
        <section aria-label="当前会话详情">
          {modelInputPort && (
            <ModelInputs
              key={`${state.generation}/${selection.storeId}/${selection.session.id}/${modelInputTarget?.revision ?? 0}`}
              client={modelInputPort}
              storeId={selection.storeId}
              sessionId={selection.session.id}
              window={window}
              initialExecutionId={modelInputTarget?.executionId}
            />
          )}
          <section aria-label={diagnostics ? 'Runtime logs' : '执行记录'}>
            <h2>{diagnostics ? 'Runtime logs · 已保存执行' : '执行记录'}</h2>
            <p>
              {diagnostics
                ? '此处是已保存执行的有限投影，不是全部 Runtime 事件。'
                : '查看已保存的执行状态与结果。'}
            </p>
            {selection.executions.map((execution) => (
              <details
                key={`${state.generation}/${selection.viewSelection}/${state.historyEpoch}/${selection.storeId}/${selection.session.id}/${execution.id}`}
                onToggle={(event) => {
                  const identity = `${state.generation}/${selection.viewSelection}/${state.historyEpoch}/${selection.storeId}/${selection.session.id}`,
                    open = event.currentTarget.open;
                  setExpandedExecutions((old) => {
                    const ids = new Set(old.identity === identity ? old.ids : []);
                    if (open) ids.add(execution.id);
                    else ids.delete(execution.id);
                    return { identity, ids };
                  });
                }}
              >
                <summary>
                  {execution.definitionId} · {execution.status}
                </summary>
                <NativeDiagnostic>
                  <p>
                    原执行 {execution.id} · kind {execution.kind}
                  </p>
                </NativeDiagnostic>
                {execution.kind === 'model' && selection.canReadModelInput && (
                  <button
                    type="button"
                    onClick={() =>
                      setModelInputTarget((previous) => ({
                        executionId: execution.id,
                        revision: (previous?.revision ?? 0) + 1,
                      }))
                    }
                  >
                    检查原 Model 输入{diagnostics ? ` · ${execution.id}` : ''}
                  </button>
                )}
                {execution.kind === 'job' &&
                  !selection.session.parentSessionId &&
                  !selection.interactions.some(
                    (card) => card.kind === 'question' && card.state === 'pending',
                  ) &&
                  ['planned', 'dispatching', 'running'].includes(execution.status) && (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        void report(async () => {
                          const commandId = crypto.randomUUID();
                          await bridge.request({
                            method: 'caller.prepare',
                            generation: generation.current,
                            sessionId: selection.session.id,
                            intent: {
                              kind: 'execution.cancel',
                              expectedStoreId: selection.storeId,
                              commandId,
                              executionId: execution.id,
                            },
                          });
                          await bridge.request({
                            method: 'caller.submit',
                            generation: generation.current,
                            commandId,
                          });
                          await refresh();
                        })
                      }
                    >
                      停止原 Job{diagnostics ? ` · ${execution.id}` : ''}
                    </button>
                  )}
                {execution.kind === 'job' &&
                  expandedExecutions.identity ===
                    `${state.generation}/${selection.viewSelection}/${state.historyEpoch}/${selection.storeId}/${selection.session.id}` &&
                  expandedExecutions.ids.has(execution.id) && (
                    <NativeJobOutputPanel
                      bridge={bridge}
                      generation={state.generation}
                      selection={selection}
                      historyEpoch={state.historyEpoch ?? 0}
                      executionId={execution.id}
                    />
                  )}
                <NativeExecutionResult
                  result={execution.result}
                  model={execution.kind === 'model'}
                />
              </details>
            ))}
          </section>
          {!hasPendingInteraction && interactionCards}
          {selection.interactionsAfterId !== null && (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                const original = selection,
                  nonce = viewIntent.current,
                  current = generation.current;
                void report(async () => {
                  let value: NativeResult;
                  try {
                    value = await bridge.request({
                      method: 'interactions.next',
                      generation: current,
                      viewGeneration: original.viewGeneration,
                      afterId: original.interactionsAfterId!,
                    });
                  } catch (error) {
                    if (
                      nonce === viewIntent.current &&
                      current === generation.current &&
                      selected.current === original.session.id
                    )
                      throw error;
                    return;
                  }
                  if (
                    nonce === viewIntent.current &&
                    current === generation.current &&
                    selected.current === original.session.id
                  )
                    apply(value);
                });
              }}
            >
              下一页待决请求（替换当前窗口）
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              void report(() =>
                bridge.request({
                  method: 'interactions.close',
                  generation: generation.current,
                  viewGeneration: selection.viewGeneration,
                }),
              )
            }
          >
            停止读取待决后页
          </button>
          {selection.permissionUnavailable && (
            <p role="status">权限事实暂不可核实。权限操作只读；已有选择仍按原身份保留。</p>
          )}
          {selection.permissionUnavailable && (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                void report(async () => {
                  apply(
                    await bridge.request({
                      method: 'permission.refresh',
                      generation: generation.current,
                    }),
                  );
                })
              }
            >
              重新核实权限事实
            </button>
          )}
          <PermissionPanel
            facts={selection.permissions}
            busy={
              pending ||
              state.permissionSubmissions.some((value) =>
                ['saved', 'submitting', 'unknown'].includes(value.phase),
              )
            }
            onSetMode={selection.permissions?.trust.trusted ? setPermissionMode : undefined}
            onSetTrust={
              selection.permissions
                ? async (trusted) => {
                    await bridge.request({
                      method: 'permission.trust',
                      generation: generation.current,
                      observationId: selection.permissions!.observationId,
                      trusted,
                    });
                    await refresh();
                  }
                : undefined
            }
            onRefresh={async () => {
              apply(
                await bridge.request({
                  method: 'permission.refresh',
                  generation: generation.current,
                }),
              );
            }}
          />
          <NativeRecoveryView
            bridge={bridge}
            generation={state.generation}
            selection={selection}
            submissions={state.recoverySubmissions}
            onRefresh={refresh}
          />
          <NativeContextView
            bridge={bridge}
            generation={state.generation}
            selection={selection}
            submissions={state.contextSubmissions}
            compressionSubmissions={state.compressionSubmissions}
            onInspectModel={(executionId) =>
              setModelInputTarget({ executionId, revision: Date.now() })
            }
            onRefresh={refresh}
          />
          <PermissionGrantsPanel
            facts={
              grantFacts?.page.sessionId === selection.session.id &&
              grantFacts.page.storeId === selection.storeId
                ? grantFacts
                : undefined
            }
            busy={(state.grantSubmissions ?? []).some((value) =>
              ['saved', 'submitting', 'unknown'].includes(value.phase),
            )}
            onRead={selection.canReadPermissionGrants ? () => readGrants() : undefined}
            onNext={
              grantFacts?.page.nextAfterSeq !== null && grantFacts
                ? () => readGrants(true)
                : undefined
            }
            onClear={
              selection.canReadPermissionGrants && grantFacts
                ? async (observationId) => {
                    const current = generation.current,
                      nonce = viewIntent.current;
                    try {
                      await bridge.request({
                        method: 'grants.clear',
                        generation: current,
                        observationId,
                      });
                    } finally {
                      if (current === generation.current && nonce === viewIntent.current)
                        setGrantFacts(undefined);
                    }
                    await refresh();
                  }
                : undefined
            }
          />
        </section>
      )}
      {bridge && state && <NativeCallerView bridge={bridge} state={state} onRefresh={refresh} />}
      {(state?.inputSubmissions ?? [])
        .filter(
          (submission) =>
            diagnostics ||
            ['submitting', 'unknown', 'accepted'].includes(submission.phase) ||
            !!submission.error ||
            !!submission.run?.isActive,
        )
        .map((submission) => (
          <div key={submission.intent.commandId}>
            <p>
              {diagnostics
                ? `原命令 ${submission.intent.commandId}：${submission.phase}`
                : `提交状态：${submission.phase}`}
            </p>
            {(diagnostics ||
              ['submitting', 'unknown', 'accepted'].includes(submission.phase) ||
              !!submission.run?.isActive) && (
              <button
                type="button"
                onClick={() =>
                  void report(async () => {
                    await bridge.request({
                      method: 'lookupInput',
                      generation: generation.current,
                      commandId: submission.intent.commandId,
                    });
                    await refresh();
                  })
                }
              >
                查询原命令
              </button>
            )}
            {submission.error && <p role="alert">{submission.error}</p>}
            {(diagnostics ||
              ['submitting', 'unknown', 'accepted'].includes(submission.phase) ||
              !!submission.run?.isActive) &&
              submission.intent.kind !== 'command.cancel' &&
              !(
                selection?.storeId === submission.intent.expectedStoreId &&
                selection.session.id === submission.sessionId &&
                selection.interactions.some(
                  (card) => card.kind === 'question' && card.state === 'pending',
                )
              ) && (
                <button
                  type="button"
                  onClick={() =>
                    void report(async () => {
                      await bridge.request({
                        method: 'cancelInput',
                        generation: generation.current,
                        commandId: submission.intent.commandId,
                      });
                      await refresh();
                    })
                  }
                >
                  停止原命令
                </button>
              )}
          </div>
        ))}
      {state?.answerUnavailable && <p role="status">原答复私有记录不可用；不发送新的答复。</p>}
      {(state?.answerSubmissions ?? [])
        .filter((submission) => diagnostics || submission.phase !== 'accepted')
        .map((submission) => (
          <div key={submission.request.commandId}>
            <p>
              {diagnostics ? (
                <>
                  持久原答复 {submission.request.commandId}：{submission.phase} · Store{' '}
                  {submission.scope.storeId} · Session {submission.scope.sessionId} · Interaction{' '}
                  {submission.interaction.id} · revision {submission.request.expectedRevision} ·{' '}
                  {submission.association}
                </>
              ) : (
                <>答复状态：{submission.phase}</>
              )}
            </p>
            <button
              type="button"
              onClick={() =>
                void report(async () => {
                  try {
                    await bridge.request({
                      method: 'lookupInteraction',
                      generation: generation.current,
                      commandId: submission.request.commandId,
                    });
                  } finally {
                    await refresh();
                  }
                })
              }
            >
              只查原答复{diagnostics ? ` · ${submission.request.commandId}` : ''}
            </button>
          </div>
        ))}
      {(state?.interactionSubmissions ?? [])
        .filter((submission) => diagnostics || !['accepted', 'applied'].includes(submission.phase))
        .filter(
          (submission) =>
            !state?.answerSubmissions?.some(
              (row) => row.request.commandId === submission.intent.commandId,
            ),
        )
        .map((submission) => (
          <div key={submission.intent.commandId}>
            <p>
              {diagnostics
                ? `答复原命令 ${submission.intent.commandId}：${submission.phase}`
                : `答复状态：${submission.phase}`}
            </p>
            {submission.phase === 'unknown' && (
              <button
                type="button"
                onClick={() =>
                  void report(async () => {
                    await bridge.request({
                      method: 'lookupInteraction',
                      generation: generation.current,
                      commandId: submission.intent.commandId,
                    });
                    await refresh();
                  })
                }
              >
                查询原答复
              </button>
            )}
          </div>
        ))}
      {(state?.permissionSubmissions ?? []).map((submission) => (
        <div key={submission.intent.commandId}>
          <NativeDiagnostic>
            <p>
              权限原会话 {submission.sessionId} · 根范围 {submission.rootSessionId} · 工作区{' '}
              {submission.workspaceId} · Store {submission.intent.expectedStoreId}
            </p>
          </NativeDiagnostic>
          <PermissionSubmissionStatus
            submission={{
              commandId: diagnostics ? submission.intent.commandId : '当前操作',
              phase: submission.phase,
              error: submission.error,
            }}
          />
          {submission.phase === 'unknown' && (
            <button
              type="button"
              onClick={() =>
                void report(async () => {
                  await bridge.request({
                    method: 'lookupPermission',
                    generation: generation.current,
                    commandId: submission.intent.commandId,
                  });
                  await refresh();
                })
              }
            >
              查询原权限选择
            </button>
          )}
        </div>
      ))}
      {(state?.grantSubmissions ?? []).map((submission) => (
        <section key={submission.intent.commandId} aria-label="原授权清除选择">
          <NativeDiagnostic>
            <p>
              原会话 {submission.sessionId} · 工作区 {submission.workspaceId} · 原存储{' '}
              {submission.intent.expectedStoreId} · 授权版本 {submission.intent.ifRevision}
            </p>
          </NativeDiagnostic>
          <PermissionSubmissionStatus
            submission={{
              commandId: diagnostics ? submission.intent.commandId : '当前操作',
              phase: submission.phase,
              error: submission.error,
            }}
          />
          {submission.phase === 'unknown' && (
            <button
              type="button"
              onClick={() =>
                void report(async () => {
                  await bridge.request({
                    method: 'lookupGrant',
                    generation: generation.current,
                    commandId: submission.intent.commandId,
                  });
                  await refresh();
                })
              }
            >
              查询原授权清除选择
            </button>
          )}
        </section>
      ))}
      <NativeFileRecoveryPanel
        bridge={bridge}
        generation={state?.generation ?? generation.current}
        selection={selection}
        submissions={state?.fileRecoverySubmissions ?? []}
        onRefresh={refresh}
        onSelect={select}
      />
      <NativeSessionPanel
        bridge={bridge}
        generation={state?.generation ?? generation.current}
        selection={selection}
        submissions={state?.sessionSubmissions ?? []}
        onRefresh={async () => {
          await readDirectory();
          await refresh();
        }}
        onSelect={select}
      />
    </section>
  );
  const workspaceModels = directory ? desktopDirectory(directory, selection) : [];
  const scheduledTaskProps = useNativeScheduledTasks({
    bridge,
    generation: state?.generation ?? 0,
    storeId: directory?.storeId,
    active: scheduledTasksView,
    revision: settingsRevision,
    workspaces: workspaceModels.filter((workspace) => workspace.state === 'loaded'),
    onOpen: async (sessionId) => {
      const original = pageIntent.current;
      await select(sessionId, true, true);
      if (pageIntent.current !== original) return;
      pageIntent.current++;
      setScheduledTasksView(false);
      setPreparing(false);
    },
  });
  const renderNativeAttachments: NonNullable<SessionPageProps['renderMessageAttachments']> = (
    model,
  ) => {
    if (firstVisible && !firstSaved && model.id === firstSubmission.commandId)
      return (
        <NativePendingAttachments files={firstSubmission.files} images={firstSubmission.images} />
      );
    const delivery = inputDeliveries.get(model.id);
    if (delivery && !messagesById.has(model.id))
      return <NativePendingAttachments files={delivery.files} images={delivery.images} />;
    const message = messagesById.get(model.id);
    if (!message || !selection || !state) return null;
    return (
      <NativeUserImages
        bridge={bridge}
        previews={imageDrafts.previews}
        generation={state.generation}
        viewSelection={selection.viewSelection ?? selection.viewGeneration}
        historyEpoch={state.historyEpoch ?? 0}
        message={message}
        readAvailable={
          !selection.viewLoading && historyState.phase === 'complete' && !directory?.unavailable
        }
      />
    );
  };
  const renderNativeMessage: NonNullable<SessionPageProps['renderMessageContent']> = (model) => {
    if (firstVisible && !firstSaved && model.id === firstSubmission.commandId)
      return (
        <>
          {model.text && <p className="user-text">{model.text}</p>}
          {(model.delivery === 'unknown' || model.delivery === 'failed') && (
            <p className="delivery-status" role="alert">
              {model.delivery === 'unknown' ? '发送结果尚未确认。' : '发送失败，原文已恢复供重试。'}
            </p>
          )}
        </>
      );
    if (inputDeliveries.has(model.id) && !messagesById.has(model.id))
      return (
        <>
          {model.text && <p className="user-text">{model.text}</p>}
          {(model.delivery === 'unknown' || model.delivery === 'failed') && (
            <p className="delivery-status" role="alert">
              {model.delivery === 'unknown' ? '发送结果尚未确认。' : '发送失败，原文已保留。'}
            </p>
          )}
        </>
      );
    const message = messagesById.get(model.id);
    if (!message || !selection || !state) return null;
    const openable =
      !selection.viewLoading && historyState.phase === 'complete' && !directory?.unavailable;
    if (message.agentMessage)
      return <NativeModelOutputMessage message={message} storeId={selection.storeId} />;
    if (message.agentResult) {
      const result = message.agentResult;
      return (
        <>
          {message.content && <MessageContent text={message.content} />}
          <DesktopButton
            type="button"
            variant="ghost"
            size="sm"
            disabled={!openable || !childReadAvailable}
            onClick={() => {
              if (!openable || !childReadAvailable || selected.current !== selection.session.id)
                return;
              setChildTabRequest({
                parent: childParent,
                requestId: ++childTabSequence.current,
                sessionId: result.childSessionId,
                executionId: result.executionId,
                title: result.name,
              });
            }}
          >
            {result.contentComplete ? '查看子 Agent' : '查看完整结果'}
          </DesktopButton>
        </>
      );
    }
    if (
      message.role === 'user' &&
      !message.content &&
      !message.outputBody &&
      message.contentFormat !== 'unsupported'
    )
      return null;
    return (
      <NativeModelOutputMessage
        key={JSON.stringify([
          state.generation,
          selection.storeId,
          selection.session.id,
          message.id,
        ])}
        message={message}
        storeId={selection.storeId}
        canReadRestoredOrigin
        openFile={(path) => {
          if (!openable || selected.current !== selection.session.id) return;
          void report(() =>
            bridge.request({
              method: 'messageFile.open',
              generation: state.generation,
              viewSelection: selection.viewSelection ?? selection.viewGeneration,
              historyEpoch: state.historyEpoch ?? 0,
              messageId: message.id,
              path,
              editor,
            }),
          );
        }}
        onContent={(text) => {
          const key = JSON.stringify([replyDisplayScope, message.id]);
          const before = verifiedReplyBodies.current.get(key),
            identity = nativeReplyKey(replyDisplayScope, message);
          if (text === undefined) verifiedReplyBodies.current.delete(key);
          else verifiedReplyBodies.current.set(key, { identity, text });
          if (before?.text !== text || (before && before.identity !== identity))
            renderVerifiedReply((value) => value + 1);
        }}
        onRead={
          selection.canReadModelOutput
            ? async ({ sessionId, executionId, signal }) => {
                const current = state.generation,
                  nonce = viewIntent.current;
                return readNativeModelOutput({
                  bridge,
                  generation: current,
                  expectedStoreId: selection.storeId,
                  sessionId,
                  viewSessionId: selection.session.id,
                  messageId: message.id,
                  executionId,
                  signal,
                  isCurrent: () =>
                    generation.current === current &&
                    viewIntent.current === nonce &&
                    selected.current === selection.session.id,
                });
              }
            : undefined
        }
      />
    );
  };
  const renderNativeTools: NonNullable<SessionPageProps['renderToolActivity']> = (
    group,
    controls,
  ) => {
    const aggregate = !!group[0]?.presentationGroupId || group.length > 1;
    const displayTools = toolMessages.entries;
    const displayTargets = fileTargets.entries;
    const agentProps = (model: (typeof group)[number]) => {
      const activity = nativeAgentActivityForTool(
        environment.agentActivities,
        messages.find((message) => message.id === model.id),
        displayTools.find((entry) => entry.messageId === model.id),
      );
      return {
        childAgent: activity?.childAgent,
        childDetail:
          activity && childReadAvailable
            ? {
                label: activity.childAgent.name,
                onOpen: () =>
                  setChildTabRequest({
                    parent: childParent,
                    requestId: ++childTabSequence.current,
                    sessionId: activity.sessionId,
                    executionId: activity.executionId,
                    title: activity.childAgent.name,
                  }),
              }
            : undefined,
      };
    };
    const agentTool = (model: (typeof group)[number]) => {
      const props = agentProps(model);
      return props.childAgent ? (
        <ToolActivity
          {...props}
          aggregate={false}
          messages={[model]}
          expanded={controls.expandedItems[model.presentationKey ?? model.id]}
          onToggle={(open) => controls.onToggleItem(model.presentationKey ?? model.id, open)}
          activityId={model.presentationKey ?? model.id}
          restoredExpanded={controls.restoredExpanded}
          renderChildren={() => null}
        />
      ) : undefined;
    };
    const unverified = new Set(
      group
        .filter(
          (model) =>
            !displayTools.some((entry) => entry.messageId === model.id) &&
            !displayTargets.some((entry) => entry.messageId === model.id) &&
            !liveTools.some((entry) => entry.message.id === model.id),
        )
        .map((model) => model.id),
    );
    const liveNotices = group.map((model) => {
      const live = liveTools.find((entry) => entry.message.id === model.id);
      const status =
        !live || executionUnconfirmed
          ? undefined
          : live.execution.cancelRequestedAt !== null
            ? '已请求停止，等待执行结果。'
            : diagnostics && (selection?.viewLoading || selection?.permissionUnavailable)
              ? '上次确认状态'
              : undefined;
      return status ? (
        <p key={model.id} role="status">
          {status}
        </p>
      ) : null;
    });
    // Each receipt owns its verification and reader independently. An unknown
    // sibling must not withdraw another tool's verified file actions or output.
    const originalTool = (
      model: (typeof group)[number],
      expanded: boolean | undefined,
      onToggle: (open: boolean) => void,
    ) => (
      <ToolActivity
        aggregate={false}
        unverified
        metadataPending={toolMessages.pendingMessageIds.has(model.id)}
        messages={[{ ...model, toolName: undefined, title: model.title ?? '工具结果', text: '' }]}
        expanded={expanded}
        onToggle={onToggle}
        activityId={
          !aggregate && group.length === 1
            ? controls.activityId
            : (model.presentationKey ?? model.id)
        }
        restoredExpanded={controls.restoredExpanded}
        renderChildren={() => renderNativeMessage(model)}
      />
    );
    if (!aggregate && group.length === 1 && unverified.has(group[0]!.id))
      return originalTool(group[0]!, controls.expanded, controls.onToggle);
    const models = group.map((model) => {
      if (unverified.has(model.id)) return { ...model, title: model.title ?? '工具结果', text: '' };
      const target = displayTargets.find((entry) => entry.messageId === model.id);
      return target?.path && target.operation
        ? {
            ...model,
            toolName: { read: 'read_file', write: 'write_file', edit: 'edit_file' }[
              target.operation
            ],
            target: target.path,
            arguments: { path: target.path },
            status: 'completed' as const,
            settled: true,
          }
        : model;
    });
    return (
      <>
        <ToolActivity
          {...controls}
          {...(!aggregate && group[0] ? agentProps(group[0]) : {})}
          aggregate={aggregate}
          unverified={unverified.size > 0}
          messages={models}
          renderItem={(model) =>
            unverified.has(model.id)
              ? originalTool(
                  group.find((original) => original.id === model.id)!,
                  controls.expandedItems[model.presentationKey ?? model.id],
                  (open) => controls.onToggleItem(model.presentationKey ?? model.id, open),
                )
              : agentTool(model)
          }
          renderChildren={() => null}
          openFileForMessage={(model) => {
            const target = displayTargets.find((entry) => entry.messageId === model.id);
            if (
              !selection ||
              !state ||
              selection.viewLoading ||
              historyState.phase !== 'complete' ||
              directory?.unavailable ||
              !target?.openable ||
              !target.path
            )
              return;
            return (path) => {
              if (path !== target.path) return;
              void report(() =>
                bridge.request({
                  method: 'fileChanges.open',
                  generation: state.generation,
                  changeId: target.changeId,
                  editor,
                }),
              );
            };
          }}
        />
        {state &&
          displayTargets
            .filter(
              (entry) => entry.snapshot && group.some((model) => model.id === entry.messageId),
            )
            .map((entry) => (
              <NativeOutputFile
                key={entry.changeId}
                bridge={bridge}
                generation={state.generation}
                entry={entry}
                editor={editor}
              />
            ))}
        {group.map((model) => {
          const message = messagesById.get(model.id);
          const images = displayTools.find((entry) => entry.messageId === model.id)?.images;
          return message && images?.length && selection && state ? (
            <NativeUserImages
              key={model.id}
              bridge={bridge}
              previews={imageDrafts.previews}
              generation={state.generation}
              viewSelection={selection.viewSelection ?? selection.viewGeneration}
              historyEpoch={state.historyEpoch ?? 0}
              message={message}
              images={images}
              readAvailable={
                !selection.viewLoading &&
                historyState.phase === 'complete' &&
                !directory?.unavailable
              }
            />
          ) : null;
        })}
        {liveNotices}
      </>
    );
  };
  const windowFrame = (content: ReactNode) =>
    nativeWindow ? (
      <NativeWindowFrame
        showHeader={startup === 'ready'}
        applicationEnabled={
          startup === 'ready' && !pending && !removingWorkspace && !readLifecycle.current.quitting
        }
        onAction={(action) => {
          if (startupPhase.current !== 'ready' || writing.current || readLifecycle.current.quitting)
            return;
          if (action === 'settings') setSettingsOpen(true);
          else {
            setSettingsOpen(false);
            if (action === 'new-conversation') prepareConversation();
            else if (action === 'add-workspace') void addWorkspace();
          }
        }}
      >
        {content}
      </NativeWindowFrame>
    ) : (
      content
    );
  if (startup !== 'ready')
    return windowFrame(
      <NativeStartup
        phase={startup}
        error={startupError}
        diagnosticSaveError={diagnosticSaveError}
        onSaveDiagnostic={
          diagnosticAvailable
            ? () => {
                setDiagnosticSaveError('');
                const attempt = startupAttempt;
                void bridge.saveStartupDiagnostic?.().catch(() => {
                  if (startupPhase.current === 'failed' && attempt === startupAttemptRef.current)
                    setDiagnosticSaveError('保存启动诊断失败，请选择新的文件名并重试。');
                });
              }
            : undefined
        }
        onRetry={
          bridge
            ? () => {
                if (startupPhase.current !== 'failed') return;
                startupDirectoryUnavailable.current = false;
                startupPhase.current = 'loading';
                startupAttemptRef.current++;
                setError('');
                setStartupError('');
                setDiagnosticAvailable(false);
                setDiagnosticSaveError('');
                setStartup('loading');
                setStartupAttempt((attempt) => attempt + 1);
              }
            : undefined
        }
      />,
    );
  return windowFrame(
    <SessionPage
      key={directory?.storeId ?? 'connecting'}
      covered={settingsOpen}
      writeClipboardText={window.kiteNative?.writeClipboardText}
      onHeaderMouseDown={(clickCount) => {
        if (clickCount === 2)
          void window.kiteNative?.toggleWindowMaximize?.().catch((cause) =>
            report(async () => {
              throw cause;
            }, false),
          );
      }}
      workspaces={workspaceModels}
      selected={
        !scheduledTasksView &&
        !preparing &&
        selection?.storeId === directory?.storeId &&
        (selected.current === undefined || selected.current === selection?.session.id)
          ? selection?.session.id
          : undefined
      }
      sessionLabel={preparing ? '新对话' : selection ? selection.session.title || '新对话' : 'Kite'}
      readingKey={
        firstVisible && !firstSaved
          ? JSON.stringify([
              firstSubmission.creation.expectedStoreId,
              firstSubmission.creation.sessionId,
            ])
          : preparing
            ? 'new-conversation'
            : JSON.stringify([selection?.storeId, selection?.session.id])
      }
      conversationCache={{
        interactive: !!selection && selected.current === selection.session.id,
        scope: conversationDomScope,
        revision: JSON.stringify([state?.historyEpoch ?? 0, domMembership.current.revision]),
        readActive:
          !!selection &&
          selected.current === selection.session.id &&
          !selection.viewLoading &&
          !directory?.unavailable &&
          historyState.phase === 'complete' &&
          !historyMetadataLoading,
      }}
      messages={messageModels}
      initialPresentationPending={
        !(firstVisible && !firstSaved) &&
        !pendingInputModels.length &&
        !!selection &&
        transcript.messages === freshTranscript.messages &&
        historyState.phase !== 'unavailable' &&
        !state?.callerUnavailable &&
        !state?.backgroundUnavailable &&
        !(state?.selection?.permissionUnavailable && !state.selection.viewLoading) &&
        !runMessages.error &&
        !toolMessages.error &&
        (historyState.phase === 'loading' ||
          !!selection.viewLoading ||
          runMessages.loading ||
          toolMessages.loading)
      }
      renderMessageContent={renderNativeMessage}
      renderMessageAttachments={renderNativeAttachments}
      renderToolActivity={renderNativeTools}
      turnActivity={
        preparing || !transcript.turnActivity
          ? undefined
          : {
              ...transcript.turnActivity,
              executionUnconfirmed,
              // Read admission is revoked during scans; the last observed Run still owns its label.
              unavailable:
                historyState.phase === 'unavailable' ||
                !!(state?.selection?.permissionUnavailable && !state.selection.viewLoading),
            }
      }
      notices={
        <>
          {diagnostics && fileTargets.error && (
            <p role="alert">
              {fileTargets.error}{' '}
              <DesktopButton onClick={fileTargets.retry}>重新读取文件路径</DesktopButton>
            </p>
          )}
          {diagnostics && runMessages.error && (
            <p role="alert">
              {runMessages.error}{' '}
              <DesktopButton onClick={runMessages.retry}>重新核对本轮状态</DesktopButton>
            </p>
          )}
          {diagnostics && cacheMetrics.error && (
            <p role="status">
              {cacheMetrics.error}{' '}
              <DesktopButton onClick={cacheMetrics.retry}>重新读取缓存指标</DesktopButton>
            </p>
          )}
          {diagnostics && toolMessages.error && (
            <p role="alert">
              {toolMessages.error}{' '}
              <DesktopButton onClick={toolMessages.retry}>重新核对工具状态</DesktopButton>
            </p>
          )}
          {state?.workspaceRemovalUnavailable && <p role="alert">暂时无法确认空间移除结果。</p>}
          {state?.workspaceRemovalSubmissions
            ?.filter((r) => r.phase === 'unknown' || r.phase === 'failed')
            .map((r) => (
              <p role="status" key={r.commandId}>
                空间“{r.label}”{r.phase === 'failed' ? '未移除' : '移除结果待确认'}。
                {r.phase === 'failed' &&
                  (r.error === 'permission_denied'
                    ? '当前用户无权移除此空间。'
                    : '本地服务拒绝了此次移除。')}
                {r.phase === 'unknown' && r.commandId && (
                  <DesktopButton
                    onClick={() =>
                      void report(() => lookupWorkspaceRemoval(r.commandId!), true, true)
                    }
                  >
                    查看结果
                  </DesktopButton>
                )}
              </p>
            ))}
        </>
      }
      loading={
        !preparing &&
        !(firstVisible && !firstSaved) &&
        (!!selection || selectionHandoff) &&
        historyState.phase === 'loading' &&
        !messages.length
      }
      renderBrowser={renderNativeBrowser}
      closeBrowser={closeNativeBrowserTab}
      childTabRequest={
        !preparing && !scheduledTasksView && childTabRequest?.parent === childParent
          ? childTabRequest
          : undefined
      }
      onChildSessionChange={(target) =>
        setActiveChildTab(target ? { ...target, parent: childParent } : undefined)
      }
      renderChildSession={({ sessionId, executionId, onTitleChange }) => (
        <NativeChildDetail
          child={environment.child}
          generation={state?.generation ?? generation.current}
          storeId={selection?.storeId ?? ''}
          sessionId={sessionId}
          executionId={executionId}
          executionUnconfirmed={executionUnconfirmed}
          readActive={
            childReadAvailable &&
            !!selection &&
            selected.current === selection.session.id &&
            !selection.viewLoading &&
            !directory?.unavailable
          }
          onRefresh={environment.refreshChild}
          onTitleChange={onTitleChange}
          readingCache={childReadings.current}
          writeClipboardText={window.kiteNative?.writeClipboardText}
        />
      )}
      fileChangesContent={
        !preparing && !scheduledTasksView && selection ? (
          <NativeFileChanges
            bridge={bridge}
            generation={state?.generation ?? generation.current}
            selection={selection}
            historyEpoch={state?.historyEpoch ?? 0}
            messages={messages}
            historyComplete={historyState.phase === 'complete'}
            editor={editor}
          />
        ) : undefined
      }
      environmentInformation={environment.card}
      requiredSubagentWait={
        !executionUnconfirmed &&
        !preparing &&
        historyState.phase === 'complete' &&
        !selection?.viewLoading &&
        !selection?.permissionUnavailable &&
        !!selection?.runs.some(
          (run) =>
            run.isActive &&
            run.status === 'waiting_execution' &&
            run.waitingForResults?.some((id) =>
              selection.executions.some(
                (execution) =>
                  execution.id === id &&
                  execution.childSessionId !== null &&
                  execution.originStoreId === selection.storeId &&
                  ['planned', 'dispatching', 'running'].includes(execution.status),
              ),
            ),
        )
      }
      connected={generation.current > 0}
      connectionLabel={
        diagnostics
          ? generation.current > 0
            ? directory?.unavailable
              ? '本地 Agent · 目录状态待核实'
              : '本地 Agent'
            : '本地 Agent'
          : ''
      }
      mutationBusy={pending || !!removingWorkspace}
      defaultExpanded
      actions={{
        newSession: () => prepareConversation(),
        newWorkspaceSession: prepareConversation,
        addWorkspace: () => void addWorkspace(),
        removeWorkspace: directory?.unavailable
          ? undefined
          : (id) => void report(() => removeWorkspace(id), true, true),
        settings: () => setSettingsOpen(true),
        scheduledTasks: () => {
          pageIntent.current++;
          setPreparedModels(undefined);
          setToolsOpen(false);
          setScheduledTasksView(true);
        },
        theme,
        connection: diagnostics
          ? { label: '重新读取目录', run: () => void report(readDirectory) }
          : undefined,
      }}
      onOpen={(sessionId) => {
        const sameTarget =
          selected.current === sessionId &&
          (!!selectionRead.current ||
            (selection?.storeId === directory?.storeId && selection?.session.id === sessionId));
        if (sameTarget && readingParent) return;
        pageIntent.current++;
        setScheduledTasksView(false);
        setPreparing(false);
        if (!sameTarget) void report(() => select(sessionId));
      }}
      newConversation={
        preparing && !scheduledTasksView
          ? {
              projects:
                directory?.workspaces.map((workspace) => ({
                  path: workspace.id,
                  label: workspace.name,
                })) ?? [],
              workspace: newWorkspace,
              branch: newBranch
                ? {
                    ...newBranch,
                    current: targetBranch ?? newBranch.current,
                    label: targetBranch ?? newBranch.label,
                  }
                : undefined,
              busy: contextBusy || pending,
              onProject: (id) => void report(() => chooseWorkspace(id), true, true),
              onAddProject: () => void addWorkspace(),
              onBranch: setTargetBranch,
              onRefreshBranch: () => void report(() => chooseWorkspace(newWorkspace), true, true),
            }
          : undefined
      }
      scheduledTasks={scheduledTasksView ? scheduledTaskProps : undefined}
      headerActions={
        <>
          {scheduledTasksView ? (
            (selection || preparing) && (
              <DesktopButton
                variant="ghost"
                onClick={() => {
                  pageIntent.current++;
                  if (preparing && firstRef.current) {
                    firstOpenPage.current = pageIntent.current;
                    const creation = firstRef.current.result?.creation;
                    if (
                      creation?.phase === 'created' &&
                      creation.input.expectedStoreId === directory?.storeId
                    )
                      void report(() => select(creation.input.sessionId, false));
                  }
                  setScheduledTasksView(false);
                }}
              >
                {preparing ? '返回新对话' : '返回会话'}
              </DesktopButton>
            )
          ) : (
            <NativeDiagnostic>
              <DesktopButton
                variant="ghost"
                aria-expanded={toolsOpen}
                onClick={() => setToolsOpen(!toolsOpen)}
              >
                会话工具
              </DesktopButton>
            </NativeDiagnostic>
          )}
          <NativeDiagnostic>
            <DesktopButton variant="ghost" onClick={() => setSettingsOpen(true)}>
              设置
            </DesktopButton>
          </NativeDiagnostic>
        </>
      }
      statusNotice={
        diagnostics &&
        !preparing &&
        selection && (
          <>
            {inputQueue.error && (
              <div className="queue-operation-notice" role="status">
                {inputQueue.error}
                <DesktopButton variant="ghost" onClick={inputQueue.retry}>
                  重新读取队列
                </DesktopButton>
              </div>
            )}
            {inputQueue.submissions.map((submission) => (
              <div className="queue-operation-notice" key={submission.commandId} role="status">
                {submission.phase === 'applied'
                  ? '消息已从队列移除，原文尚未放入输入框。'
                  : '队列操作结果尚未确认。'}
                <DesktopButton
                  variant="ghost"
                  disabled={inputQueue.busy}
                  onClick={() => void inputQueue.lookup(submission.commandId)}
                >
                  {submission.operation === 'edit' ? '核对并取回原文' : '核对原队列操作'}
                </DesktopButton>
              </div>
            ))}
            {((diagnostics && historyState.phase !== 'loading') ||
              selection.session.historyPurgedAt !== undefined ||
              historyState.phase === 'unavailable') && (
              <p role="status">
                {selection.session.historyPurgedAt !== undefined
                  ? '此会话的历史正文已由离线维护清理；原操作回执和执行边界仍保留。'
                  : historyState.phase === 'complete'
                    ? '历史已完整读取至固定高水位；当前执行事实仍须核实。'
                    : '历史尚未完整校准；已有正文仍可阅读，当前执行事实不可用。'}
              </p>
            )}
            {historyState.phase === 'unavailable' && (
              <button type="button" onClick={() => void report(refresh)}>
                重新加载会话
              </button>
            )}
            {selection.runs
              .filter(() => diagnostics)
              .map((run) => (
                <p key={run.id}>轮次：{run.status}</p>
              ))}
            {executionUnconfirmed && (
              <p role="status" aria-label="会话执行状态待核实">
                {executionOwner === 'unheld'
                  ? '原执行者已释放，执行状态待核实。'
                  : '无法核实原执行者，执行状态待核实。'}
                历史记录已保留，尚未确认的执行结果不会自动重试。
              </p>
            )}
            {diagnostics && (
              <p role="status" aria-label="当前会话后台状态">
                后台状态：{unfinishedJobs} 项未结束，{unknownJobs} 项未知
                {executionUnconfirmed ? ' · 执行状态待核实' : ''}
                {state?.selection?.viewLoading ||
                state?.selection?.permissionUnavailable ||
                state?.backgroundUnavailable
                  ? ' · 上次确认状态'
                  : ''}
              </p>
            )}
          </>
        )
      }
      interaction={!preparing && hasPendingInteraction ? interactionCards : undefined}
      interactionHidesPrompt={!!hasPendingRootInteraction}
      composer={
        preparing && state && directory
          ? {
              draft: newDraft,
              scopeKey: newImageScope,
              onFileReferences: imageDrafts.fileReferences,
              imageLimit: inputImageCount,
              files: imageDrafts.files(newImageScope),
              onFilesSelected: (files) => imageDrafts.addFiles(newImageScope, files),
              onRemoveFile: (id) => imageDrafts.removeIds([id]),
              images: imageDrafts.get(newImageScope),
              onImageFiles: (files) => {
                return imageDrafts.add(newImageScope, files);
              },
              onRemoveImage: (id) => imageDrafts.removeIds([id]),
              onChange: changeNewDraft,
              onSend: sendFirst,
              active: false,
              stopping: false,
              disabled: pending,
              sending,
              sendDisabled:
                !newWorkspace ||
                newBranch?.workspaceId !== newWorkspace ||
                newBranch.storeId !== directory.storeId ||
                contextBusy ||
                !newModelReady.ready ||
                firstSubmission?.result?.phase === 'unknown',
              inputLabel: '新对话草稿',
              sendLabel: '发送首条消息',
              permission: preparedPermission,
              fullPermissionScope: JSON.stringify([directory.storeId, 'new-conversation']),
              onPermissionChange: (mode) => setNewPermission(mode),
              permissionDisabled: pending,
              options: (
                <>
                  <NativeModelPicker
                    key={JSON.stringify([directory.storeId, newModelRevision])}
                    snapshots={modelSnapshots.current}
                    bridge={bridge}
                    generation={state.generation}
                    preparing={{ storeId: directory.storeId }}
                    revision={String(settingsRevision)}
                    value={newChoice}
                    onChange={setNewChoice}
                    onReady={(ready, choice) =>
                      setNewModelReady((previous) =>
                        JSON.stringify(previous) === JSON.stringify({ ready, choice })
                          ? previous
                          : { ready, choice },
                      )
                    }
                  />
                  <NativeDiagnostic>
                    <label>
                      <input
                        type="checkbox"
                        aria-label="先审核计划"
                        checked={newPlanMode}
                        onChange={(event) => setNewPlanMode(event.target.checked)}
                        disabled={pending}
                      />
                      先审核计划
                    </label>
                  </NativeDiagnostic>
                </>
              ),
            }
          : canCompose && selection && state
            ? {
                draft,
                queue: inputQueue.queue,
                queueFocusKey,
                scopeKey: imageScope(selection.storeId, selection.session.id),
                onFileReferences: imageDrafts.fileReferences,
                imageLimit: inputImageCount,
                files: imageDrafts.files(imageScope(selection.storeId, selection.session.id)),
                onFilesSelected: (files) =>
                  imageDrafts.addFiles(imageScope(selection.storeId, selection.session.id), files),
                onRemoveFile: (id) => imageDrafts.removeIds([id]),
                images: imageDrafts.get(imageScope(selection.storeId, selection.session.id)),
                onImageFiles: (files) => {
                  return imageDrafts.add(
                    imageScope(selection.storeId, selection.session.id),
                    files,
                  );
                },
                onRemoveImage: (id) => imageDrafts.removeIds([id]),
                onChange: changeDraft,
                onSend: sendInput,
                onCancel: () => void write(stopCurrentRun),
                active: !!activeInputRun && !executionUnconfirmed,
                cacheMetrics: cacheMetrics.metrics,
                contextUsage: contextUsage.metrics,
                stopping: activeInputRun?.status === 'cancelling',
                cancelDisabled:
                  pending ||
                  !!selection.permissionUnavailable ||
                  !!state.callerUnavailable ||
                  historyState.phase !== 'complete' ||
                  !!state.callerSubmissions?.some(
                    (value) =>
                      value.request.kind === 'command.cancel' &&
                      value.scope.storeId === selection.storeId &&
                      value.scope.sessionId === selection.session.id &&
                      ['saved', 'submitting', 'unknown'].includes(value.phase),
                  ),
                disabled: pending || inputQueue.busy || selected.current !== selection.session.id,
                sessionLoading,
                sending,
                // A routine history scan gates actions without removing the observed label.
                permission: composerPermission,
                fullPermissionScope: JSON.stringify([
                  state.generation,
                  selection.storeId,
                  selection.session.id,
                  selection.viewSelection,
                  state.historyEpoch ?? 0,
                ]),
                permissionDisabled:
                  pending ||
                  historyState.phase !== 'complete' ||
                  !!selection.permissionUnavailable ||
                  !selection.permissions ||
                  state.permissionSubmissions.some((value) =>
                    ['saved', 'submitting', 'unknown'].includes(value.phase),
                  ),
                permissionPending: state.permissionSubmissions.some(
                  (value) =>
                    value.sessionId === selection.session.id &&
                    ['saved', 'submitting', 'unknown'].includes(value.phase),
                ),
                onPermissionChange: (mode) => void write(() => setPermissionMode(mode, false)),
                sendDisabled:
                  historyState.phase !== 'complete' ||
                  selection.permissionUnavailable ||
                  (firstSubmission?.creation.sessionId === selection.session.id &&
                    firstSubmission.result?.phase === 'unknown') ||
                  (needsNextModel && !nextModelReady),
                inputLabel: '当前会话私有草稿',
                sendLabel: activeInputRun
                  ? planMode
                    ? '排队新的计划任务'
                    : executionUnconfirmed
                      ? '排队后续输入'
                      : ['context.compress', 'context.compression.reset'].includes(
                            selection.activeCommand?.kind ?? '',
                          )
                        ? '排队压缩后的输入'
                        : '引导当前轮次'
                  : planMode
                    ? '发送计划任务'
                    : '发送明确的新轮次',
                options: (
                  <>
                    <NativeModelPicker
                      snapshots={modelSnapshots.current}
                      prepared={preparedModels}
                      bridge={bridge}
                      generation={state.generation}
                      selection={selection}
                      disabled={selected.current !== selection.session.id}
                      revision={String(settingsRevision)}
                      value={modelChoices.current.get(choiceKey) ?? {}}
                      onChange={(choice) => {
                        modelChoices.current.set(choiceKey, choice);
                        choiceChanged((value) => value + 1);
                      }}
                      onReady={(ready, choice) =>
                        setResolvedChoice((previous) => {
                          const value = { identity: choiceIdentity, choice, ready };
                          return JSON.stringify(previous) === JSON.stringify(value)
                            ? previous
                            : value;
                        })
                      }
                    />
                    <NativeDiagnostic>
                      <label>
                        <input
                          type="checkbox"
                          aria-label="先审核计划"
                          checked={planMode}
                          disabled={pending}
                          onChange={(event) => {
                            setPlanMode(event.target.checked);
                            planModes.current.set(
                              JSON.stringify([
                                selection.storeId,
                                selection.session.workspaceId,
                                selection.session.id,
                              ]),
                              event.target.checked,
                            );
                          }}
                        />
                        先审核计划
                      </label>
                    </NativeDiagnostic>
                    <NativeDiagnostic>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          void write(async () => {
                            const original = {
                              generation: generation.current,
                              epoch: readLifecycle.current.epoch,
                              view: viewIntent.current,
                              sessionId: selection.session.id,
                              storeId: selection.storeId,
                              workspaceId: selection.session.workspaceId,
                              revision: draftRevision.current,
                            };
                            let revision = original.revision;
                            const consumed = consumedDraft.current;
                            if (
                              consumed?.generation === original.generation &&
                              consumed.view === original.view &&
                              consumed.storeId === original.storeId &&
                              consumed.workspaceId === original.workspaceId &&
                              consumed.sessionId === original.sessionId &&
                              consumed.proof.revision === String(revision)
                            ) {
                              const ownsRead = () =>
                                isCurrentRead(original.generation, original.epoch, original.view) &&
                                selected.current === original.sessionId &&
                                draftOwner.current ===
                                  imageScope(original.storeId, original.sessionId) &&
                                draftRevision.current === original.revision;
                              let saved: NativeResult;
                              try {
                                saved = await bridge.request({
                                  method: 'draft.read',
                                  generation: original.generation,
                                  sessionId: original.sessionId,
                                });
                              } catch (cause) {
                                if (!ownsRead()) return;
                                throw cause;
                              }
                              if (!ownsRead()) return;
                              if (
                                saved &&
                                'content' in saved &&
                                'revision' in saved &&
                                saved.id === consumed.proof.id &&
                                saved.storeId === original.storeId &&
                                saved.workspaceId === original.workspaceId &&
                                saved.rootSessionId === original.sessionId &&
                                saved.content === '' &&
                                saved.revision === revision + 1 &&
                                saved.consumedFrom?.commandId === consumed.commandId &&
                                saved.consumedFrom.revision === revision
                              )
                                draftRevision.current = revision = saved.revision;
                              if (consumedDraft.current === consumed)
                                consumedDraft.current = undefined;
                            }
                            const saved = await bridge.request({
                              method: 'draft.write',
                              generation: original.generation,
                              sessionId: original.sessionId,
                              revision,
                              content: draft,
                            });
                            if (
                              saved &&
                              'content' in saved &&
                              'revision' in saved &&
                              generation.current === original.generation &&
                              viewIntent.current === original.view &&
                              selected.current === original.sessionId
                            )
                              draftRevision.current = saved.revision;
                          }, false)
                        }
                      >
                        保留草稿
                      </button>
                    </NativeDiagnostic>
                  </>
                ),
              }
            : undefined
      }
      readOnlyReason={selection?.session.parentSessionId ? '子会话只读' : undefined}
      detailPanel={
        diagnostics && toolsOpen
          ? {
              label: '会话与任务',
              content: (
                <>
                  {sessionTools}
                  {selection && state && (
                    <NativeExtensions
                      key={JSON.stringify([
                        state.generation,
                        selection.viewSelection,
                        state.historyEpoch,
                        selection.storeId,
                        selection.session.id,
                        selection.session.contextSelectionId,
                      ])}
                      bridge={bridge}
                      scope={{
                        generation: state.generation,
                        viewSelection: selection.viewSelection ?? selection.viewGeneration,
                        historyEpoch: state.historyEpoch ?? 0,
                        storeId: selection.storeId,
                        sessionId: selection.session.id,
                        workspaceId: selection.session.workspaceId,
                        contextSelectionId: selection.session.contextSelectionId,
                      }}
                      submissions={state.callerSubmissions}
                      canRead={selection.canReadExtensions === true}
                      canInvoke={selection.canInvokeExtensions === true}
                    />
                  )}
                </>
              ),
              onClose: () => setToolsOpen(false),
            }
          : undefined
      }
      overlays={
        <>
          <AlertDialog
            open={!!error && !settingsOpen && (diagnostics || businessError)}
            onOpenChange={(open) => {
              if (!open) setError('');
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>操作未完成</AlertDialogTitle>
                <AlertDialogDescription>{error}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogAction onClick={() => setError('')}>确定</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Dialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            modal={!(nativeWindow && document.documentElement.dataset.platform === 'windows')}
          >
            <DialogContent
              portalled={false}
              className="desktop-settings-dialog translate-x-0 translate-y-0"
              showCloseButton={false}
              showOverlay={false}
              onEscapeKeyDown={(event) => {
                if (settingsEditorControl.current) {
                  event.preventDefault();
                  settingsEditorControl.current.close();
                }
              }}
              onInteractOutside={(event) => {
                if (
                  nativeWindow &&
                  event.target instanceof Element &&
                  event.target.closest('.native-window-titlebar')
                )
                  event.preventDefault();
              }}
            >
              <DialogHeader className="desktop-settings-header">
                <DialogTitle>设置</DialogTitle>
                <DialogDescription className="sr-only">
                  配置模型、提供商与扩展能力
                </DialogDescription>
                <DesktopButton
                  type="button"
                  variant="ghost"
                  className="settings-back"
                  onClick={() => setSettingsOpen(false)}
                >
                  返回应用
                </DesktopButton>
              </DialogHeader>
              <div className="settings settings-layout desktop-settings">
                <aside className="settings-sidebar">
                  <nav aria-label="设置分类">
                    <button
                      type="button"
                      aria-pressed={settingsPage === 'general'}
                      onClick={() => setSettingsPage('general')}
                    >
                      常规
                    </button>
                    <button
                      type="button"
                      aria-pressed={settingsPage === 'providers'}
                      onClick={() => setSettingsPage('providers')}
                    >
                      提供商
                    </button>
                    <button
                      type="button"
                      aria-pressed={settingsPage === 'models'}
                      onClick={() => setSettingsPage('models')}
                    >
                      模型
                    </button>
                    <button
                      type="button"
                      aria-pressed={settingsPage === 'mcp'}
                      onClick={() => setSettingsPage('mcp')}
                    >
                      MCP
                    </button>
                    <button
                      type="button"
                      aria-pressed={settingsPage === 'skills'}
                      onClick={() => setSettingsPage('skills')}
                    >
                      Skills
                    </button>
                  </nav>{' '}
                </aside>
                <div className="settings-content">
                  {error && (
                    <p className="notice error" role="alert">
                      {error}
                    </p>
                  )}

                  {settingsPage === 'general' ? (
                    <NativeGeneralSettings
                      bridge={bridge}
                      generation={generation.current}
                      storeId={directory?.storeId}
                      selection={!preparing ? selection : undefined}
                      revision={settingsRevision}
                      editor={editor}
                      onEditorChange={setEditor}
                    />
                  ) : settingsPage === 'skills' ? (
                    <NativeSkillsSettings
                      panelHost={settingsEditorHost}
                      editorControl={settingsEditorControl}
                      bridge={bridge}
                      generation={generation.current}
                      storeId={directory?.storeId}
                    />
                  ) : settingsPage === 'mcp' ? (
                    <NativeMcpSettings
                      panelHost={settingsEditorHost}
                      editorControl={settingsEditorControl}
                      bridge={bridge}
                      generation={generation.current}
                      storeId={directory?.storeId}
                      submissions={state?.userMcpSubmissions ?? []}
                    />
                  ) : settingsPage === 'providers' ? (
                    <NativeProviderSettings
                      panelHost={settingsEditorHost}
                      editorControl={settingsEditorControl}
                      bridge={bridge}
                      generation={generation.current}
                      selection={selection}
                      submissions={state?.providerSettingsSubmissions ?? []}
                      onSaved={() => setSettingsRevision((value) => value + 1)}
                    />
                  ) : (
                    <NativeModelSettings
                      bridge={bridge}
                      generation={generation.current}
                      selection={selection}
                      submissions={state?.modelSettingsSubmissions ?? []}
                      onSaved={() => setSettingsRevision((value) => value + 1)}
                    />
                  )}
                </div>
                <div className="settings-editor-panel" ref={setSettingsEditorHost} />
              </div>
            </DialogContent>
          </Dialog>
        </>
      }
    />,
  );
}
