import type { Message } from '@kite-ai/client';
import {
  InteractionCard,
  ModelInputs,
  ModelOutputMessage,
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
  SessionPage,
  type SessionPageProps,
  ToolActivity,
} from '@kite-ai/ui/desktop';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopEditor } from './file-changes-bridge';
import { NativeBackgroundPanel } from './native-background-panel';
import type {
  NativeBranchFacts,
  NativeConversationResult,
  NativeCreation,
  NativeDirectory,
  NativeDraft,
  NativeGrantFacts,
  NativeRequest,
  NativeResult,
  NativeState,
} from './native-bridge';
import { NativeCallerView } from './native-caller';
import { NativeContextView } from './native-context';
import { useNativeEnvironment } from './native-environment';
import { NativeFileChanges } from './native-file-changes';
import { NativeFileRecoveryPanel } from './native-file-recovery';
import { useNativeFileTargets } from './native-file-targets';
import { NativeGeneralSettings } from './native-general-settings';
import { type HistoryState, NativeHistory } from './native-history';
import { nativeTextIntent } from './native-input';
import { readNativeInteractionAttachment } from './native-interaction-attachment';
import { NativeJobOutputPanel } from './native-job-output-panel';
import { NativeMcpSettings } from './native-mcp-settings';
import { createNativeModelInputPort } from './native-model-input';
import { readNativeModelOutput } from './native-model-output';
import { type NativeModelChoice, NativeModelPicker } from './native-model-picker';
import { NativeModelSettings } from './native-model-settings';
import { desktopDirectory, desktopMessages } from './native-presentation';
import { NativeProviderSettings } from './native-provider-settings';
import { NativeRecoveryView } from './native-recovery';
import { NativeSessionPanel } from './native-sessions';
import { NativeSkillsSettings } from './native-skills-settings';
import { useNativeTheme } from './native-theme';
import { liveToolMessages, useNativeToolMessages } from './native-tool-messages';
import { desktopTranscript, nativeReplyKey, useNativeRuns } from './native-transcript';

/** The renderer owns only public presentation; all I/O is the named preload bridge. */
export function NativeDesktop() {
  const bridge = window.kiteNative;
  const theme = useNativeTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [scheduledTasksView, setScheduledTasksView] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [newDraft, setNewDraft] = useState('');
  const [newWorkspace, setNewWorkspace] = useState('');
  const [newBranch, setNewBranch] = useState<NativeBranchFacts>();
  const [targetBranch, setTargetBranch] = useState<string>();
  const [contextBusy, setContextBusy] = useState(false);
  const [newPermission, setNewPermission] = useState<'ask' | 'accept_edits' | 'auto' | 'full'>();
  const [newPlanMode, setNewPlanMode] = useState(false);
  const [newChoice, setNewChoice] = useState<NativeModelChoice>({});
  const [newModelReady, setNewModelReady] = useState<{
    ready: boolean;
    choice?: NativeModelChoice;
  }>({ ready: false });
  const [firstSubmission, setFirstSubmission] = useState<{
    creation: NativeCreation['input'];
    commandId: string;
    text: string;
    choice: NativeModelChoice;
    plan: boolean;
    permissionMode: 'ask' | 'accept_edits' | 'auto' | 'full';
    result?: NativeConversationResult;
  }>();
  const firstRef = useRef(firstSubmission);
  firstRef.current = firstSubmission;
  const contextIntent = useRef(0);
  const draftCache = useRef(new Map<string, string>());
  const [state, setState] = useState<NativeState>();
  const [directory, setDirectory] = useState<NativeDirectory>();
  const [messages, setMessages] = useState<Message[]>([]);
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
  const [planMode, setPlanMode] = useState(false);
  const [settingsPage, setSettingsPage] = useState<
    'general' | 'models' | 'providers' | 'mcp' | 'skills'
  >('general');
  const [editor, setEditor] = useState<DesktopEditor>('vscode');
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [, choiceChanged] = useState(0);
  const modelChoices = useRef(new Map<string, NativeModelChoice>());
  const [resolvedChoice, setResolvedChoice] = useState<{
    identity: string;
    choice?: NativeModelChoice;
    ready: boolean;
  }>();
  const planModes = useRef(new Map<string, boolean>());
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [removingWorkspace, setRemovingWorkspace] = useState<string>();
  const [expandedExecutions, setExpandedExecutions] = useState<{
    identity: string;
    ids: Set<string>;
  }>({ identity: '', ids: new Set() });
  const generation = useRef(0),
    historyEpoch = useRef<number | undefined>(undefined),
    viewIntent = useRef(0),
    pageIntent = useRef(0),
    draftRevision = useRef(0),
    writing = useRef(false);
  const selected = useRef<string | undefined>(undefined);
  const verifiedReplyBodies = useRef(new Map<string, { identity: string; text: string }>());
  const [, renderVerifiedReply] = useState(0);
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
  function apply(value: NativeResult) {
    if (value && 'generation' in value && value.generation === generation.current) {
      if (value.directory) setDirectory(value.directory);
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
      setState(value);
    }
  }
  async function report(action: () => Promise<unknown>, clearError = true) {
    try {
      if (clearError) setError('');
      return await action();
    } catch (cause) {
      const code =
        (cause as { code?: string; message?: string }).code ??
        (cause as { message?: string }).message;
      setError(code && /^[a-z][a-z0-9_]{0,80}$/.test(code) ? code : '结果待核实；请查询原命令。');
      return undefined;
    }
  }
  async function refresh() {
    if (!bridge || !generation.current) return;
    const nonce = viewIntent.current,
      current = generation.current;
    const value = await bridge.request({ method: 'state', generation: current });
    if (nonce !== viewIntent.current || current !== generation.current) return;
    apply(value);
    if (
      value &&
      'generation' in value &&
      value.selection &&
      selected.current === value.selection.session.id
    )
      history.current?.select(current, value.selection, value.historyEpoch);
  }
  async function readDirectory() {
    if (!bridge) return;
    const current = generation.current;
    let value: NativeResult;
    try {
      value = await bridge.request({ method: 'directory', generation: current });
    } catch (cause) {
      // Main's observer reset replaces this GET; the next directory state owns the display.
      const code = (cause as { code?: string; message?: string }).code ?? (cause as Error).message;
      if (code === 'directory_observation_changed') return;
      throw cause;
    }
    if (current === generation.current && value && 'workspaces' in value) setDirectory(value);
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
  async function select(sessionId: string, keepCurrentDraft = true) {
    if (!bridge) return;
    if (keepCurrentDraft) rememberDraft();
    setPreparing(false);
    setScheduledTasksView(false);
    const nonce = ++viewIntent.current,
      current = generation.current;
    selected.current = sessionId;
    history.current?.preview(sessionId);
    setModelInputTarget(undefined);
    setGrantFacts(undefined);
    setDraft('');
    const value = await bridge.request({ method: 'select', generation: current, sessionId });
    if (nonce !== viewIntent.current || current !== generation.current) return;
    apply(value);
    if (value && 'generation' in value && value.selection)
      history.current?.select(current, value.selection, value.historyEpoch);
    if (value && 'generation' in value && !value.selection?.session.parentSessionId) {
      const saved = await bridge.request({ method: 'draft.read', generation: current, sessionId });
      if (nonce !== viewIntent.current || current !== generation.current) return;
      if (saved && 'content' in saved) {
        setDraft(
          draftCache.current.get(JSON.stringify([saved.storeId, sessionId])) ?? saved.content,
        );
        draftRevision.current = saved.revision;
      }
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: One bridge lifetime; generation and message facts are read through refs.
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const unwatch = bridge.watch((event) => {
      if (alive && event.generation === generation.current) void report(refresh, false);
    });
    void report(async () => {
      const value = await bridge.request({ method: 'attach' });
      if (!alive || !value || !('generation' in value)) return;
      generation.current = value.generation;
      apply(value);
      if (!value.selection) setPreparing(true);
      await readDirectory();
    });
    return () => {
      alive = false;
      unwatch();
      history.current?.close();
      if (generation.current)
        void bridge.request({ method: 'detach', generation: generation.current }).catch(() => {});
    };
  }, []);
  const selection = state?.selection
    ? {
        ...state.selection,
        permissionUnavailable:
          state.selection.permissionUnavailable || historyState.phase !== 'complete',
        viewLoading: state.selection.viewLoading || historyState.phase === 'loading',
        permissions: historyState.phase === 'complete' ? state.selection.permissions : undefined,
      }
    : undefined;
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
  }, [attachmentGeneration, attachmentSessionId, attachmentView, attachmentEpoch]);
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
  }, [inputStore, inputSession, inputEnabled, inputGeneration, inputView]);
  const environment = useNativeEnvironment({
    bridge,
    generation: state?.generation ?? generation.current,
    selection: !preparing && !scheduledTasksView ? selection : undefined,
    revision: state?.environmentRevision ?? 0,
    unavailable: !!(
      selection?.viewLoading ||
      selection?.permissionUnavailable ||
      state?.backgroundUnavailable
    ),
    controlUnavailable: !!state?.callerUnavailable,
    submissions: state?.callerSubmissions,
    onChanged: async () => {
      await report(refresh, false);
    },
  });
  const childDetail = environment.child,
    childFacts = childDetail?.facts,
    childMessages = childFacts ? desktopMessages(childFacts.messages) : [];
  const fileTargets = useNativeFileTargets({
    bridge,
    generation: state?.generation ?? generation.current,
    selection: !preparing && !scheduledTasksView && !childDetail ? selection : undefined,
    historyEpoch: state?.historyEpoch ?? 0,
    messages,
    includeRead: true,
  });
  const toolMessages = useNativeToolMessages({
    bridge,
    generation: state?.generation ?? generation.current,
    selection: !preparing && !scheduledTasksView && !childDetail ? selection : undefined,
    historyEpoch: state?.historyEpoch ?? 0,
    messages,
    observationRevision: state?.environmentRevision ?? 0,
  });
  const liveTools = liveToolMessages(
    !preparing && !scheduledTasksView && !childDetail ? selection : undefined,
    messages,
  );
  const runMessages = useNativeRuns({
    bridge,
    generation: state?.generation ?? generation.current,
    selection: !preparing && !scheduledTasksView && !childDetail ? selection : undefined,
    historyEpoch: state?.historyEpoch ?? 0,
    messages,
    observationRevision: state?.environmentRevision ?? 0,
  });
  const replyScope = JSON.stringify([
    state?.generation ?? generation.current,
    selection?.storeId,
    selection?.viewSelection ?? selection?.viewGeneration,
    state?.historyEpoch ?? 0,
  ]);
  if (!bridge) return <p>原生桥不可用。此页面不连接替代服务器。</p>;
  async function write(action: () => Promise<unknown>, requiresHistory = true) {
    if (
      writing.current ||
      (requiresHistory && state?.selection && historyState.phase !== 'complete')
    )
      return;
    writing.current = true;
    setPending(true);
    try {
      await report(action);
    } finally {
      writing.current = false;
      setPending(false);
      await report(refresh, false);
    }
  }
  function rememberDraft() {
    if (state?.selection && selected.current === state.selection.session.id)
      draftCache.current.set(
        JSON.stringify([state.selection.storeId, state.selection.session.id]),
        draft,
      );
  }
  async function chooseWorkspace(workspaceId: string) {
    if (!bridge || !directory?.workspaces.some((workspace) => workspace.id === workspaceId)) return;
    const nonce = ++contextIntent.current,
      current = generation.current,
      storeId = directory.storeId;
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
    } finally {
      if (nonce === contextIntent.current) setContextBusy(false);
    }
  }
  function prepareConversation(workspaceId?: string) {
    rememberDraft();
    pageIntent.current++;
    setScheduledTasksView(false);
    setToolsOpen(false);
    setPreparing(true);
    if (newPermission === undefined && selection?.permissions)
      setNewPermission(selection.permissions.mode.mode);
    if (firstRef.current?.result?.phase !== 'unknown' && !pending) setFirstSubmission(undefined);
    if (workspaceId) void report(() => chooseWorkspace(workspaceId));
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
    if (
      selection?.session.workspaceId === value.workspaceId ||
      newWorkspace === value.workspaceId
    ) {
      pageIntent.current++;
      viewIntent.current++;
      contextIntent.current++;
      selected.current = undefined;
      history.current?.close();
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
    await write(async () => {
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
    }, false);
  }
  function firstIntent(
    commandId: string,
    text: string,
  ): Extract<NativeRequest, { method: 'conversation.send' }>['intent'] {
    return {
      kind: 'run.start',
      expectedStoreId: directory!.storeId,
      commandId,
      content: text,
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
    await readDirectory();
    if (value.creation?.phase === 'created') {
      if (value.phase === 'accepted') setNewPlanMode(false);
      const sessionId = value.creation.input.sessionId;
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
      if (value.phase !== 'accepted')
        draftCache.current.set(
          JSON.stringify([value.creation.input.expectedStoreId, sessionId]),
          original.text,
        );
      else
        draftCache.current.set(
          JSON.stringify([value.creation.input.expectedStoreId, sessionId]),
          '',
        );
      if (page === pageIntent.current) {
        await select(sessionId, false);
        if (value.code === 'workspace_trust_required') setToolsOpen(true);
      }
    } else if (value.phase !== 'accepted') setNewDraft((draft) => draft || original.text);
    if (value.code && value.code !== 'conversation_continue_explicit') setError(value.code);
  }
  function sendFirst() {
    if (
      writing.current ||
      contextBusy ||
      !bridge ||
      !directory ||
      !newWorkspace ||
      !newModelReady.ready ||
      !newDraft.trim() ||
      firstSubmission?.result?.phase === 'unknown'
    )
      return;
    const current = generation.current,
      page = pageIntent.current;
    const original = {
      creation: {
        expectedStoreId: directory.storeId,
        workspaceId: newWorkspace,
        commandId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        title: '新对话',
      },
      commandId: crypto.randomUUID(),
      text: newDraft,
      choice: newModelReady.choice ?? newChoice,
      plan: newPlanMode,
      permissionMode: preparedPermission,
    };
    firstRef.current = original;
    setFirstSubmission(original);
    setNewDraft('');
    void write(async () => {
      try {
        const value = await bridge.request({
          method: 'conversation.send',
          generation: current,
          creation: original.creation,
          intent: firstIntent(original.commandId, original.text),
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
          setNewDraft((draft) => draft || original.text);
        }
        throw cause;
      }
    }, false);
  }
  function sendInput() {
    if (!bridge || !selection) return;
    void write(async () => {
      const current = state?.generation ?? 0,
        nonce = viewIntent.current,
        sessionId = selection.session.id,
        commandId = crypto.randomUUID(),
        submittedText = draft,
        submittedRevision = draftRevision.current;
      const intent = nativeTextIntent(
        selection,
        commandId,
        draft,
        planMode,
        resolvedChoice?.identity === choiceIdentity ? resolvedChoice.choice : undefined,
      );
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
            draftCache.current.set(
              JSON.stringify([original.creation.expectedStoreId, sessionId]),
              original.text,
            );
            if (nonce === viewIntent.current && current === generation.current)
              setDraft((draft) => draft || original.text);
          }
          throw cause;
        }
        return;
      }
      const value = await bridge.request({
        method: 'submit',
        generation: current,
        sessionId,
        intent,
      });
      if (
        nonce === viewIntent.current &&
        current === generation.current &&
        draftRevision.current === submittedRevision &&
        value &&
        'phase' in value &&
        !['unknown', 'failed', 'rejected'].includes(value.phase)
      ) {
        setDraft((current) => (current === submittedText ? '' : current));
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
  const canCompose = !!selection && !selection.session.parentSessionId && !hasPendingInteraction;
  const firstVisible =
    firstSubmission &&
    directory?.storeId === firstSubmission.creation.expectedStoreId &&
    (preparing ||
      (selection?.storeId === firstSubmission.creation.expectedStoreId &&
        selection.session.id === firstSubmission.creation.sessionId));
  const firstSaved =
    firstVisible &&
    messages.some(
      (message) =>
        message.role === 'user' &&
        message.sessionId === firstSubmission.creation.sessionId &&
        selection?.storeId === firstSubmission.creation.expectedStoreId &&
        (message.originCommandId === firstSubmission.commandId ||
          (message.sourceIds?.includes(firstSubmission.commandId) &&
            selection.runs.some(
              (run) =>
                run.id === message.runId &&
                run.originStoreId === selection.storeId &&
                run.sessionId === message.sessionId &&
                run.originCommandId === firstSubmission.commandId,
            ))),
    );
  const transcript = selection
    ? desktopTranscript({
        messages,
        runs: runMessages.runs,
        tools: toolMessages.entries,
        storeId: selection.storeId,
        sessionId: selection.session.id,
        fullReply: (message) => {
          const body = verifiedReplyBodies.current.get(JSON.stringify([replyScope, message.id]));
          return body?.identity === nativeReplyKey(replyScope, message) ? body.text : undefined;
        },
      })
    : { messages: desktopMessages(messages) };
  const messageModels = preparing ? [] : transcript.messages;
  for (const entry of liveTools) {
    const run = runMessages.runs.find(
      (run) =>
        run.id === entry.execution.runId &&
        run.isActive &&
        run.originStoreId === selection?.storeId &&
        run.sessionId === selection?.session.id,
    );
    const approvals =
      selection?.interactions.filter(
        (card) =>
          card.kind === 'approval' &&
          card.state === 'pending' &&
          card.originStoreId === selection.storeId &&
          card.sessionId === entry.execution.sessionId &&
          card.runId === entry.execution.runId &&
          card.executionId === entry.execution.id &&
          card.definitionId === entry.execution.definitionId &&
          card.definitionVersion === entry.execution.definitionVersion,
      ) ?? [];
    messageModels.push({
      ...entry.message,
      ...(run && selection
        ? {
            turnId: JSON.stringify(['native-run', selection.storeId, selection.session.id, run.id]),
          }
        : {}),
      ...(approvals.length === 1
        ? {
            approval: {
              state: 'awaiting_user' as const,
              source: 'user' as const,
              interactionId: approvals[0]!.id,
            },
          }
        : {}),
    });
  }
  if (firstVisible && !firstSaved)
    messageModels.unshift({
      id: firstSubmission.commandId,
      role: 'user',
      text: firstSubmission.text,
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
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const interactionCards =
    selection && state ? (
      <>
        {selection.interactions.map((interaction) => {
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
              key={draftKey}
              interaction={interaction}
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
        })}
      </>
    ) : undefined;
  const sessionTools = (
    <section id="native-session-tools" aria-label="会话与任务">
      <header>
        <h2>会话与任务</h2>
      </header>
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
                  if (value && 'content' in value) setOriginalDraft(value);
                })
              }
            >
              草稿 {saved.rootSessionId} · 修订 {saved.revision}
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
                原会话 {originalDraft.rootSessionId} · 修订 {originalDraft.revision}
              </p>
              <textarea aria-label="保留的原关联草稿" value={originalDraft.content} readOnly />
              <button type="button" onClick={() => setOriginalDraft(undefined)}>
                关闭草稿阅读
              </button>
            </section>
          )}
          {state?.creationSubmissions.map((submission) => (
            <section key={submission.input.commandId} aria-label="会话创建意图">
              <p>
                原会话 {submission.input.sessionId} · 创建
                {submission.phase === 'pending'
                  ? '正在提交'
                  : submission.phase === 'unknown'
                    ? '结果待核实'
                    : submission.phase === 'created'
                      ? '已确认'
                      : '被拒绝'}
              </p>
              <p>
                原创建命令 {submission.input.commandId} · 原工作区 {submission.input.workspaceId}
              </p>
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
          <section aria-label="Runtime logs">
            <h2>Runtime logs · 已保存执行</h2>
            <p>此处是已保存执行的有限投影，不是全部 Runtime 事件。</p>
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
                <p>
                  原执行 {execution.id} · kind {execution.kind}
                </p>
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
                    检查原 Model 输入 · {execution.id}
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
                      停止原 Job · {execution.id}
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
                <pre>{JSON.stringify(execution.result, null, 2)}</pre>
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
            onSetMode={
              selection.permissions
                ? async (mode, makeDefault) => {
                    const receipt = await bridge.request({
                      method: 'permission.mode',
                      generation: generation.current,
                      observationId: selection.permissions!.observationId,
                      mode,
                      makeDefault,
                    });
                    if (receipt && 'state' in receipt && receipt.state === 'applied')
                      setFirstSubmission((previous) =>
                        previous?.creation.sessionId === selection.session.id
                          ? { ...previous, permissionMode: mode }
                          : previous,
                      );
                    await refresh();
                  }
                : undefined
            }
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
      {(state?.inputSubmissions ?? []).map((submission) => (
        <div key={submission.intent.commandId}>
          <p>
            原命令 {submission.intent.commandId}：{submission.phase}
          </p>
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
          {submission.intent.kind !== 'command.cancel' &&
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
      {(state?.answerSubmissions ?? []).map((submission) => (
        <div key={submission.request.commandId}>
          <p>
            持久原答复 {submission.request.commandId}：{submission.phase} · Store{' '}
            {submission.scope.storeId} · Session {submission.scope.sessionId} · Interaction{' '}
            {submission.interaction.id} · revision {submission.request.expectedRevision} ·{' '}
            {submission.association}
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
            只查原答复 · {submission.request.commandId}
          </button>
        </div>
      ))}
      {(state?.interactionSubmissions ?? [])
        .filter(
          (submission) =>
            !state?.answerSubmissions?.some(
              (row) => row.request.commandId === submission.intent.commandId,
            ),
        )
        .map((submission) => (
          <div key={submission.intent.commandId}>
            <p>
              答复原命令 {submission.intent.commandId}：{submission.phase}
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
          <p>
            权限原会话 {submission.sessionId} · 根范围 {submission.rootSessionId} · 工作区{' '}
            {submission.workspaceId} · Store {submission.intent.expectedStoreId}
          </p>
          <PermissionSubmissionStatus
            submission={{
              commandId: submission.intent.commandId,
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
          <p>
            原会话 {submission.sessionId} · 工作区 {submission.workspaceId} · 原存储{' '}
            {submission.intent.expectedStoreId} · 授权版本 {submission.intent.ifRevision}
          </p>
          <PermissionSubmissionStatus
            submission={{
              commandId: submission.intent.commandId,
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
  const renderNativeMessage: NonNullable<SessionPageProps['renderMessageContent']> = (model) => {
    if (childDetail) {
      const message = childFacts?.messages.find((entry) => entry.id === model.id),
        snapshot = childFacts?.modelOutputs.find((entry) => entry.messageId === model.id)?.snapshot;
      return message ? (
        <ModelOutputMessage
          message={message}
          storeId={selection!.storeId}
          renderText={
            message.contentFormat === 'unsupported'
              ? undefined
              : (text) => <MessageContent text={text} />
          }
          onRead={
            snapshot
              ? async ({ signal }) => {
                  signal.throwIfAborted();
                  return snapshot;
                }
              : undefined
          }
        />
      ) : null;
    }
    if (firstVisible && !firstSaved && model.id === firstSubmission.commandId)
      return (
        <>
          <p>{model.text}</p>
          <p
            className="delivery-status"
            role={!model.delivery || model.delivery === 'sending' ? 'status' : 'alert'}
          >
            {!model.delivery
              ? '已提交，请打开本次会话查看实际消息。'
              : model.delivery === 'sending'
                ? '正在发送'
                : model.delivery === 'unknown'
                  ? '发送结果未知，请查询原提交。'
                  : '发送失败，原文已恢复供重试。'}
          </p>
        </>
      );
    const message = messagesById.get(model.id);
    if (!message || !selection || !state) return null;
    const openable =
      !selection.viewLoading && historyState.phase === 'complete' && !directory?.unavailable;
    return (
      <ModelOutputMessage
        key={`${state.generation}/${selection.viewSelection}/${state.historyEpoch}/${message.id}`}
        message={message}
        storeId={selection.storeId}
        renderText={
          message.contentFormat === 'unsupported'
            ? undefined
            : (text) => (
                <MessageContent
                  text={text}
                  openFile={
                    openable
                      ? (path) =>
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
                          )
                      : undefined
                  }
                />
              )
        }
        onContent={(text) => {
          const key = JSON.stringify([replyScope, message.id]);
          const before = verifiedReplyBodies.current.get(key),
            identity = nativeReplyKey(replyScope, message);
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
    if (
      childDetail ||
      group.some(
        (model) =>
          !toolMessages.entries.some((entry) => entry.messageId === model.id) &&
          !fileTargets.entries.some((entry) => entry.messageId === model.id) &&
          !liveTools.some((entry) => entry.message.id === model.id),
      )
    )
      return group.map((model) => (
        <article key={model.id} className="message tool">
          {renderNativeMessage(model)}
        </article>
      ));
    const models = group.map((model) => {
      const target = fileTargets.entries.find((entry) => entry.messageId === model.id);
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
          messages={models}
          renderChildren={() => null}
          openFileForMessage={(model) => {
            const target = fileTargets.entries.find((entry) => entry.messageId === model.id);
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
        {group.map((model) => {
          const live = liveTools.find((entry) => entry.message.id === model.id);
          return live ? (
            <p key={model.id} role="status">
              {selection?.viewLoading || selection?.permissionUnavailable
                ? '上次确认状态'
                : live.execution.cancelRequestedAt !== null
                  ? '已请求停止，等待执行结果。'
                  : undefined}
            </p>
          ) : null;
        })}
      </>
    );
  };
  return (
    <SessionPage
      key={directory?.storeId ?? 'connecting'}
      workspaces={workspaceModels}
      selected={
        !scheduledTasksView && !preparing && selection?.storeId === directory?.storeId
          ? selection?.session.id
          : undefined
      }
      sessionLabel={
        childDetail
          ? (childFacts?.session.title ?? childDetail.sessionId)
          : preparing
            ? '新对话'
            : (selection?.session.title ?? 'kite')
      }
      readingKey={
        preparing
          ? 'new-conversation'
          : JSON.stringify([selection?.storeId, childDetail?.sessionId ?? selection?.session.id])
      }
      messages={childDetail ? childMessages : messageModels}
      renderMessageContent={renderNativeMessage}
      renderToolActivity={renderNativeTools}
      turnActivity={
        childDetail || preparing || !transcript.turnActivity
          ? undefined
          : {
              ...transcript.turnActivity,
              unavailable: !!(selection?.viewLoading || selection?.permissionUnavailable),
            }
      }
      notices={
        <>
          {fileTargets.error && (
            <p role="alert">
              {fileTargets.error}{' '}
              <DesktopButton onClick={fileTargets.retry}>重新读取文件路径</DesktopButton>
            </p>
          )}
          {runMessages.error && (
            <p role="alert">
              {runMessages.error}{' '}
              <DesktopButton onClick={runMessages.retry}>重新核对本轮状态</DesktopButton>
            </p>
          )}
          {toolMessages.error && (
            <p role="alert">
              {toolMessages.error}{' '}
              <DesktopButton onClick={toolMessages.retry}>重新核对工具状态</DesktopButton>
            </p>
          )}
          {removingWorkspace &&
            state?.workspaceRemovalSubmissions?.some(
              (r) => r.phase === 'submitting' && r.label === removingWorkspace,
            ) && <p role="status">正在移除空间“{removingWorkspace}”…</p>}
          {state?.workspaceRemovalUnavailable && (
            <p role="alert">空间移除记录不可用，无法确认原操作。</p>
          )}
          {state?.workspaceRemovalSubmissions
            ?.filter(
              (r) => r.phase === 'unknown' || r.phase === 'submitting' || r.phase === 'failed',
            )
            .map((r) => (
              <p role="status" key={r.commandId}>
                空间“{r.label}”
                {r.phase === 'submitting'
                  ? '正在移除'
                  : r.phase === 'failed'
                    ? '未移除'
                    : '移除结果待确认'}
                。
                {r.phase === 'failed' &&
                  (r.error === 'permission_denied'
                    ? '当前用户无权移除此空间。'
                    : '本地服务拒绝了此次移除。')}
                {r.phase === 'unknown' && r.commandId && (
                  <DesktopButton
                    onClick={() => void report(() => lookupWorkspaceRemoval(r.commandId!))}
                  >
                    查询原移除
                  </DesktopButton>
                )}
              </p>
            ))}
        </>
      }
      loading={
        childDetail
          ? childDetail.loading && !childFacts
          : !preparing &&
            !!selection &&
            historyState.phase === 'loading' &&
            (!messages.length || selected.current !== selection.session.id)
      }
      fileChangesContent={
        !childDetail && !preparing && !scheduledTasksView && selection ? (
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
      environmentInformation={!childDetail ? environment.card : undefined}
      requiredSubagentWait={
        !childDetail &&
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
        generation.current > 0
          ? directory?.unavailable
            ? '本地 Agent · 目录状态待核实'
            : '本地 Agent'
          : '正在连接'
      }
      mutationBusy={pending || !!removingWorkspace}
      defaultExpanded
      actions={{
        newSession: () => prepareConversation(),
        newWorkspaceSession: prepareConversation,
        addWorkspace: () => void addWorkspace(),
        removeWorkspace: directory?.unavailable
          ? undefined
          : (id) => void report(() => removeWorkspace(id)),
        settings: () => setSettingsOpen(true),
        scheduledTasks: () => {
          pageIntent.current++;
          setToolsOpen(false);
          setScheduledTasksView(true);
        },
        theme,
        connection: { label: '重新读取目录', run: () => void report(readDirectory) },
      }}
      onOpen={(sessionId) => {
        const returning =
          (scheduledTasksView || preparing) &&
          selection?.storeId === directory?.storeId &&
          selection?.session.id === sessionId &&
          selected.current === sessionId;
        pageIntent.current++;
        setScheduledTasksView(false);
        setPreparing(false);
        if (!returning) void report(() => select(sessionId));
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
              onProject: (id) => void report(() => chooseWorkspace(id)),
              onAddProject: () => void addWorkspace(),
              onBranch: setTargetBranch,
              onRefreshBranch: () => void report(() => chooseWorkspace(newWorkspace)),
            }
          : undefined
      }
      scheduledTasks={
        scheduledTasksView
          ? {
              tasks: [],
              workspaces: workspaceModels.filter((workspace) => workspace.state === 'loaded'),
            }
          : undefined
      }
      headerActions={
        <>
          {childDetail ? (
            <>
              <DesktopButton variant="ghost" onClick={environment.closeChild}>
                返回主会话
              </DesktopButton>
              <DesktopButton
                variant="ghost"
                onClick={environment.refreshChild}
                disabled={childDetail.loading}
              >
                刷新子日志
              </DesktopButton>
            </>
          ) : scheduledTasksView ? (
            (selection || preparing) && (
              <DesktopButton
                variant="ghost"
                onClick={() => {
                  pageIntent.current++;
                  setScheduledTasksView(false);
                }}
              >
                {preparing ? '返回新对话' : '返回会话'}
              </DesktopButton>
            )
          ) : (
            <DesktopButton
              variant="ghost"
              aria-expanded={toolsOpen}
              onClick={() => setToolsOpen(!toolsOpen)}
            >
              会话工具
            </DesktopButton>
          )}
          <DesktopButton variant="ghost" onClick={() => setSettingsOpen(true)}>
            设置
          </DesktopButton>
        </>
      }
      beforeConversation={
        childDetail ? (
          <>
            {childDetail.loading && <p role="status">正在读取完整子会话日志…</p>}
            {childDetail.error && (
              <p role="alert">
                子日志读取失败：{childDetail.error}。
                {childFacts ? '保留上次完整内容。' : '尚未取得完整内容。'}
              </p>
            )}
            {childFacts && (
              <p>
                已完整读取子日志至固定序号 {childFacts.upperSeq}，原子轮次{' '}
                {childFacts.item.childRun?.id ?? '尚未确认'}。
              </p>
            )}
          </>
        ) : firstSubmission?.result?.phase === 'unknown' && firstVisible ? (
          <DesktopButton
            onClick={() =>
              void write(async () => {
                const original = firstSubmission,
                  current = generation.current,
                  page = pageIntent.current;
                const value = await bridge.request({
                  method: 'conversation.lookup',
                  generation: current,
                  commandId: original.commandId,
                });
                if (value && 'kind' in value && value.kind === 'conversation' && 'stage' in value)
                  await acceptFirstResult(value, original, current, page);
              }, false)
            }
            disabled={pending}
          >
            查询原首次提交
          </DesktopButton>
        ) : preparing &&
          firstSubmission?.result?.creation?.phase === 'created' &&
          firstSubmission.creation.expectedStoreId === directory?.storeId ? (
          <DesktopButton
            onClick={() => {
              pageIntent.current++;
              void report(() => select(firstSubmission.creation.sessionId));
            }}
            disabled={pending}
          >
            打开本次会话
          </DesktopButton>
        ) : undefined
      }
      statusNotice={
        !childDetail &&
        !preparing &&
        selection && (
          <>
            <p role="status">
              {selection.session.historyPurgedAt !== undefined
                ? '此会话的历史正文已由离线维护清理；原操作回执和执行边界仍保留。'
                : historyState.phase === 'complete'
                  ? '历史已完整读取至固定高水位；当前执行事实仍须核实。'
                  : historyState.phase === 'loading'
                    ? '正在完整校准历史；已有正文仍可阅读。'
                    : '历史尚未完整校准；已有正文仍可阅读，当前执行事实不可用。'}
            </p>
            {historyState.phase === 'unavailable' && (
              <button type="button" onClick={() => void report(refresh)}>
                重新加载会话
              </button>
            )}
            {selection.runs.map((run) => (
              <p key={run.id}>轮次：{run.status}</p>
            ))}
            <p role="status" aria-label="当前会话后台状态">
              后台状态：{unfinishedJobs} 项未结束，{unknownJobs} 项未知
              {selection.viewLoading ||
              selection.permissionUnavailable ||
              state?.backgroundUnavailable
                ? ' · 上次确认状态'
                : ''}
            </p>
          </>
        )
      }
      interaction={
        !childDetail && !preparing && hasPendingInteraction ? interactionCards : undefined
      }
      composer={
        childDetail
          ? undefined
          : preparing && state && directory
            ? {
                draft: newDraft,
                onChange: setNewDraft,
                onSend: sendFirst,
                active: false,
                stopping: false,
                disabled: pending,
                sending: pending,
                sendDisabled:
                  !newWorkspace ||
                  contextBusy ||
                  !newModelReady.ready ||
                  firstSubmission?.result?.phase === 'unknown',
                inputLabel: '新对话草稿',
                sendLabel: '发送首条消息',
                permission: preparedPermission === 'ask' ? 'accept_edits' : preparedPermission,
                fullPermissionScope: JSON.stringify([directory.storeId, 'new-conversation']),
                onPermissionChange: (mode) =>
                  setNewPermission(mode === 'accept_edits' ? 'ask' : mode),
                permissionDisabled: pending,
                options: (
                  <>
                    <NativeModelPicker
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
                  </>
                ),
              }
            : canCompose && selection && state
              ? {
                  draft,
                  onChange: setDraft,
                  onSend: sendInput,
                  active: !!activeInputRun,
                  stopping: false,
                  disabled: pending,
                  sending: pending,
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
                        bridge={bridge}
                        generation={state.generation}
                        selection={selection}
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
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          void write(async () => {
                            const original = {
                              generation: generation.current,
                              view: viewIntent.current,
                              sessionId: selection.session.id,
                            };
                            const saved = await bridge.request({
                              method: 'draft.write',
                              generation: original.generation,
                              sessionId: original.sessionId,
                              revision: draftRevision.current,
                              content: draft,
                            });
                            if (
                              saved &&
                              'content' in saved &&
                              generation.current === original.generation &&
                              viewIntent.current === original.view &&
                              selected.current === original.sessionId
                            )
                              draftRevision.current = saved.revision;
                          })
                        }
                      >
                        保留草稿
                      </button>
                    </>
                  ),
                }
              : undefined
      }
      readOnlyReason={
        childDetail
          ? '子 Agent 会话仅供查看。'
          : selection?.session.parentSessionId
            ? '子会话只读'
            : undefined
      }
      detailPanel={
        !childDetail && toolsOpen
          ? { label: '会话与任务', content: sessionTools, onClose: () => setToolsOpen(false) }
          : undefined
      }
      overlays={
        <>
          <AlertDialog
            open={!!error && !settingsOpen}
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
          <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
            <DialogContent
              portalled={false}
              className="desktop-settings-dialog translate-x-0 translate-y-0"
              showCloseButton={false}
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
                      bridge={bridge}
                      generation={generation.current}
                      selection={selection}
                      historyEpoch={state?.historyEpoch ?? 0}
                    />
                  ) : settingsPage === 'mcp' ? (
                    <NativeMcpSettings
                      bridge={bridge}
                      generation={generation.current}
                      selection={selection}
                      submissions={state?.mcpSubmissions ?? []}
                    />
                  ) : settingsPage === 'providers' ? (
                    <NativeProviderSettings
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
              </div>
            </DialogContent>
          </Dialog>
        </>
      }
    />
  );
}
