import {
  type Interaction,
  type Message,
  type ModelOutputSnapshot,
  requiresInteractionAttachment,
  type SessionView,
} from '@kite-ai/client';
import { Box, Static, useApp, useInput, usePaste, useStdout } from 'ink';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { TuiApprovalPanel } from './approval-panel';
import { interactionKey } from './cards';
import {
  hasPendingRootCancellation,
  type TuiChromeFacts,
  TuiFooter,
  TuiHeader,
  TuiOverlayFrame,
  TuiRecordedPhaseTime,
} from './chrome';
import { additionalTuiCommands, fixedTuiCommands } from './commands';
import { ComposerBuffer, composerDisplay } from './composer';
import { isCtrlCBatch, TuiComposer } from './composer-input';
import { activity, currentActivityVerified, type TuiController, terminalText } from './controller';
import { TuiExecutionPanel } from './execution-panel';
import {
  frozenBuiltin,
  InkExecution,
  InkExecutionGroupView,
  InkTaskProgress,
  InkThought,
  inkShellCarrier,
  inkShellParent,
  projectInkChild,
  projectInkExecutionGroups,
} from './execution-projection';
import { projectInkExplorationPhases } from './exploration-phases';
import type { FileToken } from './file-candidates';
import { TuiFileRecoveryPanel } from './file-recovery-panel';
import { TuiHelpPanel } from './help-panel';
import CompactionProgress from './ink/CompactionProgress';
import { type MarkdownParseCache, updateMarkdownParseCache } from './ink/MarkdownBlock';
import { wrapDisplayLines } from './ink/soft-wrap';
import UserMessageBlock from './ink/UserMessageBlock';
import { useInkWindowSize } from './ink/window-size';
import { partitionLiveMarkdown } from './live-markdown';
import { TuiManagementRequestsPanel } from './management-requests-panel';
import { TerminalMarkdown } from './markdown';
import { TuiMcpPanel } from './mcp-panel';
import { isMcpProviderQuestion } from './mcp-provider-question';
import { isMcpSourceQuestion, sourceDecisions } from './mcp-source-question';
import { TuiModelPanel } from './model-panel';
import {
  advanceInkModelStream,
  type InkModelStreamState,
  inkModelStreamVisibility,
  observedModelRetry,
  settleInkModelStream,
} from './model-stream-presentation';
import { TuiOnboarding } from './onboarding-panel';
import { TuiPermissionPanel } from './permission-panel';
import { TuiPlanReviewPanel } from './plan-review-panel';
import { TuiPreferencePanel } from './preference-panel';
import { TuiText as Text, TuiPresentationProvider, useTuiPresentation } from './presentation';
import {
  type QuestionDraft,
  questionAnswer,
  questionDraft,
  questionForm,
  questionValue,
} from './question';
import {
  QuestionMaterial,
  QuestionPanel,
  questionInputWidth,
  TuiAnswerInput,
} from './question-panel';
import { TuiRecoveryPanel } from './recovery-panel';
import { TuiResult } from './result';
import { TuiSessionChooser } from './session-chooser';
import { manualWorkflow } from './skills';
import { TuiSkillsPanel } from './skills-panel';
import { TuiStatusPanel } from './status-panel';
import {
  projectTuiMessages,
  TuiThoughtPhase,
  TuiToolCalls,
  TuiToolResult,
  type TuiTranscriptMessage,
} from './transcript';

export * from './controller';
export { TerminalMarkdown } from './markdown';
export * from './mcp-auth';
export * from './mcp-connection';
export * from './mcp-reconnection';
export * from './mcp-source';
export * from './mcp-source-mutation';
export type {
  TuiOnboardingConnection,
  TuiOnboardingPort,
  TuiOnboardingResult,
  TuiOnboardingSnapshot,
} from './onboarding';
export { TuiOnboarding } from './onboarding-panel';
export { translateTuiLabel } from './presentation';

/** Ink presentation on public Server ports. Host owns admission and Service lifetime. */
export function TuiSession({
  controller,
  testDiagnostics = false,
  onQuit,
  onReadinessChange,
}: {
  controller: TuiController;
  testDiagnostics?: boolean;
  onQuit?: () => void;
  onReadinessChange?: (ready: boolean) => void;
}) {
  const state = useSyncExternalStore(controller.subscribe, () => controller.state);
  const [admittedWorkspace, setAdmittedWorkspace] = useState<string>();
  const workspaceId = state.snapshot?.view.session.workspaceId;
  const gated = controller.port.onboarding && workspaceId && admittedWorkspace !== workspaceId;
  useEffect(() => {
    onReadinessChange?.(!gated && !state.snapshot?.environment?.observer);
  }, [gated, onReadinessChange, state.snapshot?.environment?.observer]);
  return (
    <TuiPresentationProvider
      value={{
        preferences: state.preferences,
        testDiagnostics,
        activityVerified: currentActivityVerified(state.snapshot),
      }}
    >
      {gated ? (
        <TuiOnboarding
          key={workspaceId}
          port={controller.port.onboarding!}
          workspaceId={workspaceId}
          path={state.snapshot!.environment?.workspacePath ?? workspaceId}
          onReady={() => {
            setAdmittedWorkspace(workspaceId);
            if (controller.state.sessionId) void controller.select(controller.state.sessionId);
          }}
          onExit={onQuit ?? (() => void controller.routeCommand('/exit'))}
        />
      ) : state.snapshot?.environment?.observer === 'workspace_missing' ? (
        <Box flexDirection="column">
          <Text color="yellow">
            Workspace is unavailable · read-only recovery. History and original requests remain
            readable; new execution and management writes are disabled.
          </Text>
          <TuiSessionView controller={controller} onQuit={onQuit} />
        </Box>
      ) : (
        <TuiSessionView controller={controller} onQuit={onQuit} />
      )}
    </TuiPresentationProvider>
  );
}
type Execution = SessionView['executions'][number];
type HistoryItem = { key: string; version: string; node: ReactNode; mutable?: boolean };
const executionLive = (execution: Execution) =>
  ['planned', 'dispatching', 'running'].includes(execution.status);
/** Inline results and the current verified prefix share the original Model identity. */
function displayModelOutputs(
  snapshot: import('./controller').TuiSnapshot | undefined,
  loaded: ReadonlyMap<string, ModelOutputSnapshot['output']>,
): ReadonlyMap<string, ModelOutputSnapshot['output']> {
  const outputs = new Map(loaded);
  if (!snapshot) return outputs;
  for (const message of snapshot.messages) {
    if (message.role !== 'assistant' || outputs.has(message.id)) continue;
    const sourceSession = message.originMessage?.sessionId ?? message.sessionId;
    const sourceRun = message.originMessage ? message.originMessage.runId : message.runId;
    const sourceStore = message.originMessage?.storeId ?? snapshot.storeId;
    const models = snapshot.view.executions.filter(
      (execution) =>
        execution.kind === 'model' &&
        execution.originStoreId === sourceStore &&
        execution.sessionId === sourceSession &&
        execution.runId === sourceRun &&
        (message.sourceIds ?? []).includes(execution.id),
    );
    if (models.length !== 1) continue;
    const execution = models[0]!;
    const live = snapshot.liveModelOutput;
    if (
      live &&
      !message.originMessage &&
      live.storeId === snapshot.storeId &&
      live.sessionId === sourceSession &&
      live.runId === sourceRun &&
      live.executionId === execution.id &&
      !live.output.complete
    ) {
      outputs.set(message.id, live.output);
      continue;
    }
    const result = execution.result;
    if (
      message.outputBody ||
      message.status !== 'complete' ||
      execution.status !== 'succeeded' ||
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      result.content !== message.content ||
      typeof result.reasoning !== 'string' ||
      !Array.isArray(result.toolCalls) ||
      result.toolCalls.some(
        (call) =>
          !call ||
          typeof call !== 'object' ||
          Array.isArray(call) ||
          typeof call.id !== 'string' ||
          typeof call.name !== 'string' ||
          typeof call.arguments !== 'string',
      )
    )
      continue;
    outputs.set(message.id, {
      content: message.content,
      reasoning: result.reasoning,
      toolCalls: result.toolCalls as ModelOutputSnapshot['output']['toolCalls'],
      complete: true,
    });
  }
  return outputs;
}
function longQuestionMaterial(
  form: ReturnType<typeof questionForm>,
  step: number | undefined,
  columns: number,
  rows: number,
) {
  const field = form?.fields[step ?? 0];
  if (!field) return false;
  const source = [
    form?.description,
    field.description,
    ...field.choices.map((choice) => choice.description),
  ]
    .filter(Boolean)
    .join('\n');
  return wrapDisplayLines(source, Math.max(20, columns - 8)).length > Math.max(6, rows - 14);
}
const executionDisplayKey = (execution: Execution) =>
  JSON.stringify([execution.originStoreId, execution.sessionId, execution.id]);

function chromeFacts(
  state: Pick<TuiController['state'], 'snapshot' | 'models' | 'permissions'>,
): TuiChromeFacts {
  const selected = state.models?.models.find((model) => model.id === state.models?.defaultModelId);
  const environment = state.snapshot?.environment;
  const nextModelName = selected?.model ?? selected?.id ?? environment?.modelName;
  const nextEffort = selected ? (selected.reasoningEffort ?? undefined) : environment?.effort;
  const current = environment?.runtimeModel;
  return {
    ...environment,
    sessionTitle: state.snapshot?.view.session.title,
    nextModelName,
    nextEffort,
    modelName: current?.active ? current.modelName : nextModelName,
    effort: current?.active ? current.effort : nextEffort,
    ...(state.permissions ? { permissionMode: state.permissions.mode.mode } : {}),
  };
}

/** Ink owns the emitted bytes; these are only the current immutable render items. */
function TuiHistory({
  controller,
  card,
  form,
  step,
  collapsed,
}: {
  controller: TuiController;
  card?: Interaction;
  form?: ReturnType<typeof questionForm>;
  step?: number;
  collapsed: ReadonlySet<string>;
}) {
  const state = useSyncExternalStore(controller.subscribe, () => controller.state);
  const { stdout, write } = useStdout();
  const { waitUntilRenderFlush } = useApp();
  const { columns, rows } = useInkWindowSize();
  const { t, testDiagnostics } = useTuiPresentation();
  const { snapshot, models, permissions } = state;
  const facts = useMemo(
    () => chromeFacts({ snapshot, models, permissions }),
    [snapshot, models, permissions],
  );
  const scope = JSON.stringify([
    state.snapshot?.storeId,
    state.snapshot?.view.session.workspaceId,
    state.sessionId,
    state.preferences.resolvedLanguage,
    state.preferences.theme,
    state.preferences.colorPreset,
    facts.modelName,
    facts.effort,
    testDiagnostics,
    columns,
    controller.displayGeneration,
    [...collapsed],
  ]);
  const messages = controller.visibleMessages;
  const loadedOutputs = useMemo(
    () => displayModelOutputs(snapshot, state.loadedOutputBodies),
    [snapshot, state.loadedOutputBodies],
  );
  const executions = controller.visibleExecutions;
  const localMessages = state.localMessages ?? [];
  const streams = useRef(new Map<string, InkModelStreamState>());
  const markdownStreams = useRef(new Map<string, MarkdownParseCache>());
  const [streamRender, setStreamRender] = useState(0);
  const items: HistoryItem[] = useMemo(() => {
    void streamRender;
    const results = executions.filter((execution) => {
      if (execution.kind === 'model')
        return (
          execution.status === 'failed' &&
          !messages.some(
            (message) =>
              message.sessionId === execution.sessionId &&
              message.runId === execution.runId &&
              (message.outputBody?.executionId === execution.id ||
                message.sourceIds?.includes(execution.id)),
          )
        );
      if (
        !testDiagnostics &&
        snapshot &&
        (frozenBuiltin(execution, snapshot, 'builtin.shell', 'shell.launch') ||
          frozenBuiltin(execution, snapshot, 'builtin.shell', 'shell.execute'))
      ) {
        const children = executions.filter(
          (child) =>
            child.kind === 'job' &&
            inkShellCarrier(execution, snapshot)?.id === child.id &&
            child.originStoreId === execution.originStoreId &&
            child.sessionId === execution.sessionId,
        );
        if (children.length === 1) return false;
      }
      return true;
    });
    const transcript = projectTuiMessages(messages, loadedOutputs);
    const exploration =
      !testDiagnostics && snapshot
        ? projectInkExplorationPhases({ ...snapshot, messages }, loadedOutputs)
        : undefined;
    const streamViews = new Map<
      string,
      ReturnType<typeof inkModelStreamVisibility> & {
        mode: InkModelStreamState['mode'];
        finalReasoning?: string;
      }
    >();
    const currentStreams = new Set<string>();
    const markdownIdentity = (message: Message) =>
      JSON.stringify([snapshot?.storeId, message.sessionId, message.runId, message.id]);
    const visibleMarkdown = new Set(messages.map(markdownIdentity));
    for (const key of markdownStreams.current.keys())
      if (!visibleMarkdown.has(key)) markdownStreams.current.delete(key);
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      const identity = JSON.stringify([
        snapshot?.storeId,
        message.sessionId,
        message.runId,
        message.outputBody?.executionId ?? message.sourceIds,
      ]);
      currentStreams.add(identity);
      const body = loadedOutputs.get(message.id);
      const stream = advanceInkModelStream(streams.current.get(identity), {
        identity,
        content: state.fullOutputs.get(message.id) ?? body?.content ?? message.content,
        reasoning: body?.reasoning ?? '',
        // Producer completion settles the preview stream. Full-body reading
        // keeps its independent EOF, bytes and original-reference checks.
        complete:
          body?.complete ??
          (message.status === 'complete' && (message.outputBody?.complete ?? true)),
        firstOutput: message.firstOutput,
        toolCallCount: body?.complete
          ? body.toolCalls.length
          : message.status === 'complete'
            ? (message.outputBody?.toolCallCount ?? message.toolCalls?.length ?? 0)
            : undefined,
        explorationOwner: exploration?.bufferedAnswerMessageIds.has(message.id),
      });
      streams.current.set(identity, stream);
      streamViews.set(message.id, {
        ...inkModelStreamVisibility(stream),
        mode: stream.mode,
        ...(stream.finalReasoningPreview ? { finalReasoning: stream.reasoning } : {}),
      });
    }
    for (const identity of streams.current.keys())
      if (!currentStreams.has(identity)) streams.current.delete(identity);
    const phaseKey = (message: Message) =>
      JSON.stringify([
        message.originMessage?.storeId ?? snapshot?.storeId,
        message.originMessage?.sessionId ?? message.sessionId,
        message.originMessage ? message.originMessage.runId : message.runId,
      ]);
    const lastMessage = new Map(transcript.map((item, index) => [phaseKey(item.message), index]));
    const groups =
      !testDiagnostics && snapshot
        ? projectInkExecutionGroups(snapshot, loadedOutputs, false).filter(
            (group) =>
              group.kind !== 'readonly_tools' &&
              group.executionIds.every((id) => results.some((execution) => execution.id === id)),
          )
        : [];
    const grouped = new Map(
      groups.flatMap((group) => group.executionIds.map((id) => [id, group] as const)),
    );
    const renderedGroups = new Set<string>();
    const placed = new Set<string>();
    const phaseByExecution = new Map(
      exploration?.phases.flatMap((phase) =>
        phase.executionIds.map((id) => [id, phase] as const),
      ) ?? [],
    );
    const localItems = (afterMessageId: string | null): HistoryItem[] =>
      localMessages
        .filter(
          (local) =>
            local.sessionId === state.sessionId &&
            (messages.some((message) => message.id === local.afterMessageId)
              ? local.afterMessageId
              : null) === afterMessageId,
        )
        .map((local) => ({
          key: `local:${local.id}`,
          version: JSON.stringify(local),
          node:
            local.role === 'user' ? (
              <UserMessageBlock content={terminalText(local.content)} columns={columns} />
            ) : (
              <Text dimColor>{terminalText(local.content)}</Text>
            ),
        }));
    const callOwner = (execution: Execution) => {
      if (execution.runId !== null || !snapshot) return execution;
      const parent = inkShellParent(execution, snapshot);
      return parent && inkShellCarrier(parent, snapshot)?.id === execution.id ? parent : execution;
    };
    const belongs = (message: Message, execution: Execution) => {
      // An ordinary Shell Job owns no Run row. Its verified foreground parent
      // locates it in the original Run, never after later unrelated messages.
      const source = callOwner(execution);
      return (
        source.sessionId === (message.originMessage?.sessionId ?? message.sessionId) &&
        source.runId === (message.originMessage ? message.originMessage.runId : message.runId) &&
        source.originStoreId === (message.originMessage?.storeId ?? snapshot?.storeId)
      );
    };
    const executionItem = (execution: Execution): HistoryItem => ({
      key: `execution:${execution.id}`,
      version: JSON.stringify([
        execution,
        collapsed.has(executionDisplayKey(execution)),
        snapshot?.executionTimings?.[execution.id],
        snapshot?.childViews?.find((child) => child.executionId === execution.id),
        snapshot?.toolLabels?.find((label) => label.executionId === execution.id),
        snapshot?.jobTails?.find((tail) => tail.executionId === execution.id),
      ]),
      mutable: executionLive(execution),
      node: (
        <TuiExecution
          execution={execution}
          snapshot={snapshot}
          loadedOutputs={loadedOutputs}
          collapsed={collapsed.has(executionDisplayKey(execution))}
          elapsedMs={phaseElapsed(snapshot?.executionTimings?.[execution.id])}
        />
      ),
    });
    const executionItems = (list: readonly Execution[]): HistoryItem[] =>
      list.flatMap((execution) => {
        const phase = phaseByExecution.get(execution.id);
        if (phase) {
          if (renderedGroups.has(phase.key)) return [];
          renderedGroups.add(phase.key);
          const standalone =
            !phase.block.active &&
            !phase.block.hasThinking &&
            phase.block.tools.length === 1 &&
            !['error', 'exhausted', 'rejected', 'cancelled', 'timeout'].includes(
              phase.block.tools[0]!.status,
            )
              ? executionItem(execution)
              : undefined;
          return [
            {
              key: `phase:${phase.key}`,
              version: standalone
                ? JSON.stringify([phase.block, standalone.version])
                : JSON.stringify(phase.block),
              mutable: phase.block.active,
              node: (
                <Box flexDirection="column">
                  <InkExecutionGroupView
                    group={{ ...phase, kind: 'readonly_tools' }}
                    columns={columns}
                  />
                  {standalone?.node}
                </Box>
              ),
            },
          ];
        }
        const group = grouped.get(execution.id);
        if (!group) return [executionItem(execution)];
        if (renderedGroups.has(group.key)) return [];
        renderedGroups.add(group.key);
        return [
          {
            key: `group:${group.key}`,
            version: JSON.stringify(group),
            mutable: group.executionIds.some((id) =>
              results.some((item) => item.id === id && executionLive(item)),
            ),
            node: <InkExecutionGroupView group={group} columns={columns} />,
          },
        ];
      });
    return [
      {
        key: 'header',
        version: JSON.stringify([facts.modelName, facts.effort, facts.workspacePath]),
        node: <TuiHeader {...facts} />,
      },
      ...localItems(null),
      ...transcript.flatMap((item, index): HistoryItem[] => {
        const message = item.message;
        const timing =
          message.outputBody && snapshot?.executionTimings?.[message.outputBody.executionId];
        const model = snapshot?.view.executions.find(
          (entry) =>
            entry.kind === 'model' &&
            belongs(message, entry) &&
            (entry.id === message.outputBody?.executionId ||
              (message.sourceIds ?? []).includes(entry.id)),
        );
        const related = results.filter((execution) => {
          const owner = callOwner(execution);
          return (
            !placed.has(execution.id) &&
            belongs(message, execution) &&
            (item.sourceIds.includes(execution.id) ||
              item.sourceIds.includes(owner.id) ||
              (message.outputBody !== undefined &&
                execution.parentExecutionId === message.outputBody.executionId) ||
              (owner.kind === 'tool' &&
                owner.toolCallId !== undefined &&
                item.kind === 'message' &&
                item.toolCalls.some((call) => call.id === owner.toolCallId)))
          );
        });
        if (item.kind === 'message') {
          const order = new Map(item.toolCalls.map((call, position) => [call.id, position]));
          related.sort(
            (first, second) =>
              (order.get(callOwner(first).toolCallId ?? '') ?? Infinity) -
              (order.get(callOwner(second).toolCallId ?? '') ?? Infinity),
          );
        }
        for (const candidate of results) {
          if (
            !placed.has(candidate.id) &&
            belongs(message, candidate) &&
            candidate.parentExecutionId &&
            related.some((parent) => parent.id === candidate.parentExecutionId) &&
            !related.includes(candidate)
          )
            related.push(candidate);
        }
        // Only message source/parent/call facts locate an execution inside a phase.
        // Otherwise it remains explicitly grouped after the Run's messages.
        const lastInRun = lastMessage.get(phaseKey(message)) === index;
        const remainder = lastInRun
          ? results.filter(
              (execution) =>
                !placed.has(execution.id) &&
                !related.includes(execution) &&
                belongs(message, execution),
            )
          : [];
        for (const execution of [...related, ...remainder]) placed.add(execution.id);
        const ownedResult =
          item.kind === 'tool-result' &&
          results.some(
            (execution) =>
              belongs(message, execution) &&
              (item.sourceIds.includes(execution.id) ||
                item.sourceIds.includes(callOwner(execution).id) ||
                callOwner(execution).toolCallId === item.call.id),
          );
        const body = loadedOutputs.get(message.id);
        const stream = streamViews.get(message.id);
        const hideContent =
          !testDiagnostics &&
          (!!exploration?.suppressedNarrationMessageIds.has(message.id) ||
            (stream?.mode !== 'answer' && !!stream?.buffered));
        const suppressThought =
          !testDiagnostics &&
          (stream?.mode === 'answer' || !!exploration?.thoughtConsumedMessageIds.has(message.id));
        const hiddenSettledMessage =
          hideContent &&
          suppressThought &&
          message.status === 'complete' &&
          model?.status === 'succeeded' &&
          !model.modelRetry &&
          (!message.outputBody || body?.complete === true);
        const renderMessage = (hideBody: boolean, hideHeading = false) =>
          item.kind === 'message' ? (
            <TuiMessage
              message={message}
              hideHeading={hideHeading}
              controller={controller}
              fullOutput={state.fullOutputs.get(message.id) ?? body?.content}
              reasoning={item.reasoning}
              transcript={item}
              snapshot={snapshot}
              loadedOutputs={loadedOutputs}
              hasReadGroup={groups.some(
                (group) => group.messageId === message.id && group.kind === 'readonly_tools',
              )}
              modelStatus={currentActivityVerified(snapshot) ? model?.status : undefined}
              modelRetry={observedModelRetry(model, snapshot?.view.executions ?? [])}
              modelError={
                model?.status === 'failed' &&
                model.result &&
                typeof model.result === 'object' &&
                !Array.isArray(model.result) &&
                typeof model.result.code === 'string'
                  ? model.result.code
                  : undefined
              }
              elapsedMs={phaseElapsed(timing || undefined)}
              hideContent={hideBody}
              suppressThought={suppressThought}
              finalReasoning={stream?.finalReasoning}
            />
          ) : (
            <TuiToolResult item={item} />
          );
        return [
          ...(!testDiagnostics && (ownedResult || hiddenSettledMessage)
            ? []
            : [
                {
                  key: `message:${message.id}`,
                  mutable:
                    message.status === 'incomplete' ||
                    stream?.buffered ||
                    (!!model && executionLive(model)) ||
                    related.some(executionLive),
                  // Completed previews seal in source order. An explicit full
                  // read changes this version and rebuilds the static prefix.
                  version: JSON.stringify([
                    item,
                    state.fullOutputs.get(message.id),
                    body,
                    related,
                    timing,
                    model?.status,
                    model?.modelRetry,
                    model?.result,
                    hideContent,
                    suppressThought,
                    stream?.mode,
                    stream?.finalReasoning,
                  ]),
                  node:
                    item.kind === 'tool-result' ? (
                      <TuiToolResult item={item} />
                    ) : (
                      renderMessage(hideContent)
                    ),
                },
              ].flatMap((entry): HistoryItem[] => {
                const identity = markdownIdentity(message);
                const prior = markdownStreams.current.get(identity);
                const content = terminalText(
                  state.fullOutputs.get(message.id) ?? body?.content ?? message.content,
                );
                const eligible =
                  item.kind === 'message' &&
                  message.role === 'assistant' &&
                  !hideContent &&
                  stream?.mode === 'answer' &&
                  !item.toolCalls.length &&
                  (message.outputBody?.toolCallCount ?? 0) === 0 &&
                  (prior !== undefined || message.status === 'incomplete');
                if (!eligible) {
                  markdownStreams.current.delete(identity);
                  return [entry];
                }
                const parsed = updateMarkdownParseCache(prior, content);
                const parts = partitionLiveMarkdown(parsed);
                if (!prior && !parts.stable.length) return [entry];
                // Without an exact live producer, this is a recorded preview version,
                // not a growing Model stream. Publish its bytes without claiming EOF.
                const recordedPreview = !model && !message.outputBody;
                const stableParts =
                  recordedPreview && parts.tail ? [...parts.stable, parts.tail] : parts.stable;
                const liveTail = recordedPreview ? undefined : parts.tail;
                markdownStreams.current.set(identity, parsed);
                const bodyNode = (part: NonNullable<typeof parts.tail>) => (
                  <Box paddingLeft={testDiagnostics ? 0 : 2}>
                    <TerminalMarkdown
                      content=""
                      parsedSlice={part.slice}
                      maxWidth={Math.max(1, columns - (testDiagnostics ? 0 : 2))}
                    />
                  </Box>
                );
                return [
                  ...(testDiagnostics
                    ? [
                        {
                          key: `message:${message.id}:heading`,
                          version: JSON.stringify([message.role, message.id]),
                          node: (
                            <Text bold>
                              {message.role} [{terminalText(message.id)}]
                            </Text>
                          ),
                        },
                      ]
                    : []),
                  ...stableParts.map((part) => ({
                    key: `message:${message.id}:body:${part.key}`,
                    version: part.version,
                    node: bodyNode(part),
                  })),
                  {
                    key: `message:${message.id}:tail:${liveTail?.key ?? 'state'}`,
                    version: JSON.stringify([entry.version, liveTail?.version]),
                    mutable: entry.mutable,
                    node: (
                      <Box flexDirection="column">
                        {liveTail && bodyNode(liveTail)}
                        {testDiagnostics && <Text dimColor>{message.status}</Text>}
                        {renderMessage(true, true)}
                      </Box>
                    ),
                  },
                ];
              })),
          ...executionItems(related),
          ...(remainder.length
            ? [
                {
                  key: `run-results:${message.id}`,
                  version: remainder.map((entry) => entry.id).join(','),
                  node: testDiagnostics ? (
                    <Text dimColor>{t('Recorded executions for this task')}</Text>
                  ) : null,
                  mutable: remainder.some(executionLive),
                },
                ...executionItems(remainder),
              ]
            : []),
          ...localItems(message.id),
        ];
      }),
      ...executionItems(results.filter((execution) => !placed.has(execution.id))),
      ...(state.mcpPromptSelections ?? []).map((selection) => ({
        key: `prompt:${selection.id}`,
        version: selection.command,
        node: (
          <UserMessageBlock content={terminalText(`/${selection.command}`)} columns={columns} />
        ),
      })),
      ...((testDiagnostics || longQuestionMaterial(form, step, columns, rows)) && card
        ? [
            {
              key: `card:${interactionKey(card)}`,
              mutable: true,
              version: JSON.stringify([
                card,
                form,
                step,
                state.attachments.get(interactionKey(card)),
              ]),
              node: (
                <Box flexDirection="column">
                  <Text bold>
                    {testDiagnostics ? (
                      <>
                        {card.kind} [{terminalText(card.id)}
                        {t('] original Session')} {terminalText(card.sessionId)} {t('· revision')}{' '}
                        {card.revision}
                      </>
                    ) : (
                      t(
                        card.kind === 'approval'
                          ? 'Approval'
                          : card.kind === 'plan_review'
                            ? 'Plan review'
                            : 'Question',
                      )
                    )}
                  </Text>
                  {Object.entries(card.request as Record<string, unknown>)
                    .filter(
                      ([key, value]) =>
                        ['title', 'question', 'description'].includes(key) &&
                        typeof value === 'string',
                    )
                    .map(([key, value]) => (
                      <Text key={key}>{terminalText(String(value))}</Text>
                    ))}
                  {form && step !== undefined ? (
                    <QuestionMaterial form={form} step={step} />
                  ) : testDiagnostics ? (
                    <Text>
                      {terminalText(
                        JSON.stringify(
                          Object.fromEntries(
                            Object.entries(card.request as Record<string, unknown>).filter(
                              ([key, value]) =>
                                !(
                                  ['title', 'question', 'description'].includes(key) &&
                                  typeof value === 'string'
                                ),
                            ),
                          ),
                          null,
                          2,
                        ),
                      )}
                    </Text>
                  ) : (
                    <TuiResult value={card.request} />
                  )}
                </Box>
              ),
            },
          ]
        : []),
    ];
  }, [
    messages,
    executions,
    state.fullOutputs,
    loadedOutputs,
    state.attachments,
    state.mcpPromptSelections,
    localMessages,
    state.sessionId,
    card,
    form,
    step,
    controller,
    t,
    collapsed,
    facts,
    testDiagnostics,
    snapshot,
    columns,
    rows,
    streamRender,
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: New timeline items mutate the stream refs and must schedule their final reasoning flush.
  useEffect(() => {
    const pending = [...streams.current.values()].filter((stream) => stream.finalReasoningPreview);
    if (!pending.length) return;
    let current = true;
    void waitUntilRenderFlush()
      .then(() => {
        if (!current) return;
        let settled = false;
        for (const stream of pending) {
          if (streams.current.get(stream.identity) !== stream) continue;
          streams.current.set(stream.identity, settleInkModelStream(stream));
          settled = true;
        }
        if (settled) setStreamRender((version) => version + 1);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [items, waitUntilRenderFlush]);
  // Preserve the original Ink ownership split: immutable prefix goes to native
  // scrollback once; the first mutable item and following rows remain live.
  const mutableIndex = items.findIndex((item) => item.mutable);
  const materialStatic =
    !!card && (testDiagnostics || longQuestionMaterial(form, step, columns, rows));
  const sealed = materialStatic || mutableIndex < 0 ? items : items.slice(0, mutableIndex);
  const live = materialStatic || mutableIndex < 0 ? [] : items.slice(mutableIndex);
  const attachment = card && state.attachments.get(interactionKey(card));
  const attachmentItem: HistoryItem | undefined =
    card && attachment !== undefined
      ? {
          key: `attachment:${interactionKey(card)}`,
          version: attachment,
          node: (
            <Box flexDirection="column">
              <Text bold>{t('Approval material')}</Text>
              <Text>{terminalText(attachment)}</Text>
            </Box>
          ),
        }
      : undefined;
  const [committed, setCommitted] = useState({ scope, items: sealed, epoch: 0 });
  const replace = committed.scope !== scope;
  let history = committed;
  const changedPrefix = committed.items
    .filter((item) => !item.key.startsWith('attachment:'))
    .some((previous, index) => {
      const next = items[index];
      return (
        !next ||
        previous.key !== next.key ||
        ((!previous.mutable || previous.key.startsWith('card:')) &&
          previous.version !== next.version)
      );
    });
  if (replace || changedPrefix) {
    // Verified late bodies and source-order changes cannot keep an old Static
    // node. Ordinary mutable status updates stay live and never replay history.
    history = {
      scope,
      items: [...sealed, ...(attachmentItem ? [attachmentItem] : [])],
      epoch: committed.epoch + 1,
    };
    setCommitted(history);
  } else {
    const committedKeys = new Set(committed.items.map((item) => item.key));
    // Ink owns one Static node. Attachments join that append-only output stream
    // so opening and closing their card cannot detach the transcript's writer.
    const additions = [...sealed, ...(attachmentItem ? [attachmentItem] : [])].filter(
      (item) => !committedKeys.has(item.key),
    );
    if (additions.length) {
      history = { ...committed, items: [...committed.items, ...additions] };
      setCommitted(history);
    }
  }
  useInsertionEffect(() => {
    if (history.epoch && stdout.isTTY) write('\u001b[2J\u001b[3J\u001b[H');
  }, [history.epoch, stdout, write]);
  return (
    <Box
      flexDirection="column"
      flexShrink={1}
      minHeight={0}
      marginBottom={items.length > 1 ? 1 : 0}
    >
      <Box height={0} overflow="hidden">
        <Static key={history.epoch} items={history.items}>
          {(item) => (
            <Box key={item.key} flexDirection="column">
              {item.node}
            </Box>
          )}
        </Static>
      </Box>
      {live.some(
        (item) =>
          !history.items.some((saved) => saved.key === item.key && saved.version === item.version),
      ) && (
        <Box
          flexDirection="column"
          flexShrink={1}
          minHeight={0}
          maxHeight={Math.max(1, rows - 8)}
          overflowY="hidden"
        >
          {live
            .filter(
              (item) =>
                !history.items.some(
                  (saved) => saved.key === item.key && saved.version === item.version,
                ),
            )
            .map((item) => (
              <Box key={item.key} flexDirection="column">
                {item.node}
              </Box>
            ))}
        </Box>
      )}
      {snapshot?.planProgress && <InkTaskProgress plan={snapshot.planProgress} />}
      {snapshot?.compactionPhase && <CompactionProgress phase={snapshot.compactionPhase} />}
    </Box>
  );
}
function TuiMessage({
  message,
  controller,
  fullOutput,
  reasoning,
  transcript,
  snapshot,
  loadedOutputs,
  modelStatus,
  modelRetry,
  modelError,
  elapsedMs,
  hasReadGroup,
  hideContent = false,
  suppressThought = false,
  finalReasoning,
  hideHeading = false,
}: {
  message: Message;
  hideHeading?: boolean;
  controller: TuiController;
  fullOutput?: string;
  reasoning?: string;
  transcript: TuiTranscriptMessage;
  snapshot?: import('./controller').TuiSnapshot;
  loadedOutputs?: ReadonlyMap<string, ModelOutputSnapshot['output']>;
  modelStatus?: Execution['status'];
  modelRetry?: Execution['modelRetry'];
  modelError?: string;
  elapsedMs?: number;
  hasReadGroup?: boolean;
  hideContent?: boolean;
  suppressThought?: boolean;
  finalReasoning?: string;
}) {
  const { t, testDiagnostics } = useTuiPresentation();
  const { stdout } = useStdout();
  const paddingLeft = !testDiagnostics && message.role === 'assistant' ? 2 : 0;
  const maxWidth = Math.max(1, (stdout.columns || 80) - paddingLeft);
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={paddingLeft}>
      {!hideHeading &&
        (testDiagnostics ? (
          <Text bold>
            {message.role} {'['}
            {terminalText(message.id)}
            {']'} {message.status}
          </Text>
        ) : (
          message.role !== 'assistant' &&
          message.role !== 'user' && (
            <Text bold>{t(message.role === 'tool' ? 'Tool result' : 'System')}</Text>
          )
        ))}
      {modelRetry && (
        <Text color="yellow">
          {t('Retrying')} {modelRetry.attempt}/{modelRetry.maxAttempts}
        </Text>
      )}
      {modelError && <Text color="red">{terminalText(modelError)}</Text>}
      {!testDiagnostics &&
        !modelError &&
        message.status === 'incomplete' &&
        !['planned', 'dispatching', 'running'].includes(modelStatus ?? '') && (
          <Text color="yellow">{t('Incomplete response')}</Text>
        )}
      {message.role === 'assistant' &&
        !suppressThought &&
        (reasoning ||
          transcript.toolCalls.length > 0 ||
          (message.outputBody && message.outputBody.reasoningBytes !== '0')) && (
          <Box flexDirection="column">
            {testDiagnostics ? (
              <TuiThoughtPhase
                reasoning={reasoning}
                toolCount={transcript.toolCalls.length}
                active={modelStatus === 'running' || modelStatus === 'dispatching'}
                settled={
                  !!modelStatus &&
                  ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(modelStatus)
                }
                expanded={false}
                timing={elapsedMs === undefined ? undefined : { elapsedMs }}
              />
            ) : (
              snapshot &&
              !hasReadGroup && (
                <InkThought
                  message={message}
                  snapshot={snapshot}
                  loadedOutputs={loadedOutputs}
                  columns={stdout.columns || 80}
                  finalReasoning={finalReasoning}
                />
              )
            )}
          </Box>
        )}
      {!hideContent &&
        (!testDiagnostics && message.role === 'user' ? (
          <UserMessageBlock
            content={terminalText(fullOutput ?? message.content)}
            columns={stdout.columns || 80}
          />
        ) : (
          <Box
            marginTop={
              !testDiagnostics &&
              !suppressThought &&
              message.role === 'assistant' &&
              (reasoning || (message.outputBody && message.outputBody.reasoningBytes !== '0'))
                ? 1
                : 0
            }
          >
            <TerminalMarkdown
              content={fullOutput ?? message.content}
              maxWidth={maxWidth}
              streaming={
                message.status === 'incomplete' &&
                ['planned', 'dispatching', 'running'].includes(modelStatus ?? '')
              }
            />
          </Box>
        ))}
      {testDiagnostics && <TuiToolCalls item={transcript} />}

      {message.outputBody && message.outputBody.toolCallCount > transcript.toolCalls.length && (
        <Text dimColor>{t('Tool calls not fully loaded; Ctrl+O reads verified full body')}</Text>
      )}
      {message.outputBody && fullOutput === undefined && (
        <Text>
          {t('Recorded Model output preview only;')}{' '}
          {message.outputBody.readAvailability === 'unsupported' ||
          message.contentFormat === 'unsupported'
            ? t('full read unsupported')
            : controller.port.readModelOutput
              ? t('Ctrl+O reads verified full body')
              : t('full reader unavailable')}{' '}
          {testDiagnostics && (
            <>
              {'('}
              {message.outputBody.contentBytes} {t('bytes,')}{' '}
              {message.outputBody.complete ? t('complete') : t('incomplete prefix')}
              {').'}
            </>
          )}
        </Text>
      )}
    </Box>
  );
}
function phaseElapsed(
  timing?: NonNullable<import('./controller').TuiSnapshot['executionTimings']>[string],
): number | undefined {
  return timing?.availability === 'recorded_dispatch' &&
    timing.startedAt !== undefined &&
    timing.finishedAt !== undefined &&
    timing.finishedAt >= timing.startedAt
    ? timing.finishedAt - timing.startedAt
    : undefined;
}
function TuiExecution({
  execution,
  snapshot,
  loadedOutputs,
  collapsed,
  elapsedMs,
}: {
  execution: Execution;
  snapshot?: import('./controller').TuiSnapshot;
  loadedOutputs?: ReadonlyMap<string, ModelOutputSnapshot['output']>;
  collapsed: boolean;
  elapsedMs?: number;
}) {
  const { t, testDiagnostics } = useTuiPresentation();
  const { stdout } = useStdout();
  if (execution.kind === 'model' && snapshot) {
    const retry = observedModelRetry(execution, snapshot.view.executions);
    const result = execution.result;
    return (
      <Box flexDirection="column" marginBottom={1}>
        {retry && (
          <Text color="yellow">
            {t('Retrying')} {retry.attempt}/{retry.maxAttempts}
          </Text>
        )}
        <Text color="red">
          {terminalText(
            result &&
              typeof result === 'object' &&
              !Array.isArray(result) &&
              typeof result.code === 'string'
              ? result.code
              : t('Model failed'),
          )}
        </Text>
      </Box>
    );
  }
  if (!testDiagnostics && snapshot)
    return (
      <InkExecution
        execution={execution}
        snapshot={snapshot}
        loadedOutputs={loadedOutputs}
        expanded={collapsed ? false : undefined}
        columns={stdout.columns || 80}
      />
    );
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        {!testDiagnostics &&
          (execution.status === 'succeeded'
            ? '✓ '
            : execution.status === 'failed'
              ? '✗ '
              : execution.status === 'outcome_unknown'
                ? '! '
                : '⋄ ')}
        {terminalText(execution.definitionId)}{' '}
        {testDiagnostics && (
          <>
            {'['}
            {terminalText(execution.id)}
            {']'}{' '}
          </>
        )}
        {testDiagnostics ? execution.status : t(execution.status)}
        {elapsedMs !== undefined && ` · ${t('Recorded phase')}: ${(elapsedMs / 1000).toFixed(1)}s`}
      </Text>
      {collapsed ? (
        <Text dimColor>{t('Result collapsed')}</Text>
      ) : (
        <Box paddingLeft={testDiagnostics ? 0 : 2}>
          <TuiResult value={execution.result} />
        </Box>
      )}
      {execution.cancelRequestedAt !== null &&
        ['planned', 'dispatching', 'running'].includes(execution.status) && (
          <Text color="yellow">{t(' · cancel requested; cleanup not confirmed')}</Text>
        )}
    </Box>
  );
}

function TuiSessionView({
  controller,
  onQuit,
}: {
  controller: TuiController;
  onQuit?: () => void;
}) {
  const { stdout } = useStdout();
  const { rows } = useInkWindowSize();
  const fileQuery = useCallback(
    (token?: FileToken) => {
      void controller.readFileCandidates(token);
    },
    [controller],
  );
  const { t, testDiagnostics } = useTuiPresentation();
  const display = (part: ComposerBuffer['parts'][number]) => composerDisplay(part, t);
  const state = useSyncExternalStore(controller.subscribe, () => controller.state);
  const resultScope = JSON.stringify([controller.port.storeId, state.sessionId]);
  const resultExecutions = controller.visibleExecutions.filter((item) => item.kind !== 'model');
  const resultKeys = new Set(
    state.snapshot?.view.executions
      .filter((item) => item.kind !== 'model')
      .map(executionDisplayKey),
  );
  const tail = resultExecutions.at(-1);
  const [savedDisplay, setResultDisplay] = useState({
    scope: resultScope,
    collapsed: new Set<string>(),
  });
  let resultDisplay = savedDisplay;
  if (savedDisplay.scope !== resultScope) {
    resultDisplay = { scope: resultScope, collapsed: new Set() };
    setResultDisplay(resultDisplay);
  } else if ([...savedDisplay.collapsed].some((key) => !resultKeys.has(key))) {
    resultDisplay = {
      ...savedDisplay,
      collapsed: new Set([...savedDisplay.collapsed].filter((key) => resultKeys.has(key))),
    };
    setResultDisplay(resultDisplay);
  }
  const resultDisplayRef = useRef(resultDisplay);
  resultDisplayRef.current = resultDisplay;
  const jobs =
    state.snapshot?.view.executions.filter(
      (execution) =>
        execution.kind === 'job' &&
        execution.sessionId === state.sessionId &&
        execution.originStoreId === state.snapshot?.storeId,
    ) ?? [];
  const unfinishedJobs = jobs.filter((job) =>
    ['planned', 'dispatching', 'running'].includes(job.status),
  ).length;
  const unknownJobs = jobs.filter((job) => job.status === 'outcome_unknown').length;
  const composers = useRef(new Map<string, ComposerBuffer>());
  const composerScope = JSON.stringify([
    state.snapshot?.storeId,
    state.snapshot?.view.session.workspaceId,
    state.sessionId,
  ]);
  let composer = composers.current.get(composerScope);
  if (!composer) {
    composer = new ComposerBuffer();
    composers.current.set(composerScope, composer);
  }
  const skillCommands =
    state.skills?.read === 'verified' && state.skills.facts
      ? state.skills.facts.entries.flatMap((entry) =>
          entry.workflow?.name && manualWorkflow(state.skills!.facts!, entry.workflow.name)
            ? [`/${entry.workflow.name}`]
            : [],
        )
      : [];
  composer.commands = [
    ...fixedTuiCommands,
    ...(state.draft.trim().length > 1 ? additionalTuiCommands : []),
    ...skillCommands,
    ...[...(state.mcpPromptCommands?.keys() ?? [])].map((name) => `/${name}`),
  ];
  composer.commandDescriptions = Object.fromEntries([
    ...(state.skills?.read === 'verified'
      ? (state.skills.facts?.entries.flatMap((entry) =>
          entry.workflow?.name && skillCommands.includes(`/${entry.workflow.name}`)
            ? [[`/${entry.workflow.name}`, terminalText(entry.description ?? '')]]
            : [],
        ) ?? [])
      : []),
    ...[...(state.mcpPromptCommands?.values() ?? [])].map((entry) => [
      `/${entry.command}`,
      terminalText(
        typeof entry.descriptor.description === 'string' ? entry.descriptor.description : '',
      ),
    ]),
  ]);
  useEffect(() => {
    if (!state.sessionId) return;
    if (controller.port.skills) void controller.refreshSkillCommands();
    if (controller.port.mcp?.readDirectory) void controller.refreshMcpPromptCommands();
  }, [controller, state.sessionId]);
  const [chooser, setChooser] = useState(false);
  const [cardChooser, setCardChooser] = useState(false);
  const [cardIndex, setCardIndex] = useState(0);
  const [cardOptions, setCardOptions] = useState<readonly Interaction[]>([]);
  const [selectedCard, setSelectedCard] = useState<string>();
  const cardDrafts = useRef(new Map<string, ComposerBuffer>());
  const sourceChoiceRef = useRef(new Map<string, number>());
  const approvalChoiceRef = useRef(new Map<string, number>());
  const [sourceChoices, renderSourceChoices] = useState(sourceChoiceRef.current);
  const [approvalChoices, renderApprovalChoices] = useState(approvalChoiceRef.current);
  // Native keys can arrive before React paints the next selection. Enter must
  // use the answer selected by those keys, never a stale approval default.
  const setSourceChoices = useCallback(
    (update: Map<string, number> | ((value: Map<string, number>) => Map<string, number>)) => {
      sourceChoiceRef.current =
        typeof update === 'function' ? update(sourceChoiceRef.current) : update;
      renderSourceChoices(sourceChoiceRef.current);
    },
    [],
  );
  const setApprovalChoices = useCallback(
    (update: Map<string, number> | ((value: Map<string, number>) => Map<string, number>)) => {
      approvalChoiceRef.current =
        typeof update === 'function' ? update(approvalChoiceRef.current) : update;
      renderApprovalChoices(approvalChoiceRef.current);
    },
    [],
  );
  const questionDrafts = useRef(new Map<string, QuestionDraft>());
  const [, renderQuestion] = useState(0);
  const [panelIndex, setPanelIndex] = useState(0);
  const lastCancelKey = useRef<number | undefined>(undefined);
  // A programmatic Session switch must not inherit a previous exit gesture.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on selected Session identity.
  useEffect(() => {
    lastCancelKey.current = undefined;
  }, [state.sessionId]);
  useEffect(() => {
    if (state.chooserRequested) {
      void controller.list();
      setChooser(true);
      controller.closePanel();
    }
  }, [state.chooserRequested, controller]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed selection closes the local chooser.
  useEffect(() => {
    setChooser(false);
  }, [state.sessionId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: selection change resets the finite panel cursor.
  useEffect(() => {
    setPanelIndex(0);
  }, [state.panel, state.sessionId]);
  const cards = state.snapshot?.interactions.filter((i) => i.state === 'pending') ?? [];
  const selectedTarget = selectedCard
    ? JSON.stringify(JSON.parse(selectedCard).slice(0, 4))
    : undefined;
  const card =
    cards.find((i) => interactionKey(i) === selectedCard) ??
    cards.find(
      (i) => JSON.stringify(JSON.parse(interactionKey(i)).slice(0, 4)) === selectedTarget,
    ) ??
    cards[0];
  // An explicitly opened management page owns focus until its own close/back
  // gesture. Pending cards remain unchanged and become actionable on the main
  // screen; they cannot silently hide a still-mounted navigation stack.
  const blockingPanel = state.panel;
  const fullReadAttempts = useRef(new Set<string>());
  const attachmentReadAttempts = useRef(new Set<string>());
  useEffect(() => {
    if (testDiagnostics) return;
    const current = new Set<string>();
    for (const message of state.snapshot?.messages ?? []) {
      if (
        !message.outputBody?.complete ||
        message.status !== 'complete' ||
        message.outputBody.readAvailability === 'unsupported' ||
        message.contentFormat === 'unsupported'
      )
        continue;
      const key = JSON.stringify([state.sessionId, message.id, message.seq, message.outputBody]);
      current.add(key);
      if (
        !controller.port.readModelOutput ||
        state.loadedOutputBodies.has(message.id) ||
        fullReadAttempts.current.has(key)
      )
        continue;
      fullReadAttempts.current.add(key);
      void controller.loadOutput(message);
    }
    for (const key of fullReadAttempts.current)
      if (!current.has(key)) fullReadAttempts.current.delete(key);
  }, [controller, state.snapshot, state.sessionId, state.loadedOutputBodies, testDiagnostics]);
  useEffect(() => {
    if (testDiagnostics) return;
    const keys = new Set(
      (state.snapshot?.interactions ?? [])
        .filter((item) => item.state === 'pending')
        .map(interactionKey),
    );
    for (const key of attachmentReadAttempts.current)
      if (!keys.has(key)) attachmentReadAttempts.current.delete(key);
    if (!card || !requiresInteractionAttachment(card) || !controller.port.readAttachment) return;
    const key = interactionKey(card);
    if (state.attachments.has(key) || attachmentReadAttempts.current.has(key)) return;
    attachmentReadAttempts.current.add(key);
    void controller.loadAttachment(card);
  }, [controller, card, state.snapshot, state.attachments, testDiagnostics]);
  const approvalKey = card ? interactionKey(card) : '';
  const answerBuffer = cardDrafts.current.get(approvalKey) ?? new ComposerBuffer();
  if (card && !cardDrafts.current.has(approvalKey))
    cardDrafts.current.set(approvalKey, answerBuffer);
  const answer = answerBuffer.text;
  const sourceQuestion = card && isMcpSourceQuestion(card);
  const providerQuestion =
    !!card &&
    !!state.sessionId &&
    isMcpProviderQuestion(card, controller.port.storeId, state.sessionId);
  const reconnectingCard = card?.definitionId === 'builtin.mcp/mcp.reconnect';
  const connectionDefinition = reconnectingCard
    ? 'builtin.mcp/mcp.reconnect'
    : 'builtin.mcp/mcp.connect';
  const connectionOutcome = reconnectingCard ? state.mcpReconnection : state.mcpConnection;
  const connectionFact = connectionOutcome?.fact;
  const observedConnectionExecutions =
    state.snapshot?.view.executions.filter(
      (execution) =>
        execution.id === card?.executionId &&
        execution.rootWorkCommandId === connectionOutcome?.intent.request.commandId &&
        execution.parentExecutionId === null &&
        execution.runId === null,
    ) ?? [];
  const connectionExecution =
    connectionFact?.execution ??
    (observedConnectionExecutions.length === 1 ? observedConnectionExecutions[0] : undefined);
  const connectionCommand = connectionOutcome?.command;
  const connectionReceipt = connectionCommand?.receipt;
  const connectionReceiptExecution =
    connectionReceipt && typeof connectionReceipt === 'object' && !Array.isArray(connectionReceipt)
      ? connectionReceipt.executionId
      : undefined;
  const originalConnection =
    testDiagnostics &&
    card &&
    connectionOutcome &&
    connectionExecution &&
    ['approval', 'question'].includes(card.kind) &&
    card.state === 'pending' &&
    card.originStoreId === controller.port.storeId &&
    card.sessionId === state.sessionId &&
    card.presentationSessionId === state.sessionId &&
    card.executionId === connectionExecution.id &&
    card.definitionId === connectionDefinition &&
    card.definitionVersion === '1' &&
    connectionOutcome.intent.sessionId === state.sessionId &&
    connectionOutcome.intent.workspaceId === state.snapshot?.view.session.workspaceId &&
    connectionOutcome.intent.request.expectedStoreId === controller.port.storeId &&
    (connectionFact
      ? connectionFact.storeId === controller.port.storeId &&
        connectionFact.sessionId === state.sessionId
      : connectionCommand?.id === connectionOutcome.intent.request.commandId &&
        connectionCommand.originStoreId === controller.port.storeId &&
        connectionCommand.sessionId === state.sessionId &&
        connectionCommand.kind === 'extension.invoke' &&
        (connectionReceiptExecution === connectionExecution.id ||
          (connectionCommand.status === 'accepted' && connectionReceiptExecution === undefined))) &&
    connectionExecution.originStoreId === controller.port.storeId &&
    connectionExecution.sessionId === state.sessionId &&
    connectionExecution.definitionId === card.definitionId &&
    connectionExecution.definitionVersion === '1' &&
    connectionExecution.kind === 'job' &&
    (connectionFact
      ? connectionFact.execution.originCommandId === connectionOutcome.intent.request.commandId
      : observedConnectionExecutions.length === 1)
      ? connectionOutcome.intent.request.commandId
      : undefined;
  const sourceOutcome = state.mcpSourceOutcome;
  const sourceFact = sourceOutcome?.fact;
  const observedSourceExecutions =
    state.snapshot?.view.executions.filter(
      (execution) =>
        execution.id === card?.executionId &&
        execution.rootWorkCommandId === sourceOutcome?.intent.request.commandId &&
        execution.parentExecutionId === null &&
        execution.runId === null,
    ) ?? [];
  const sourceExecution =
    sourceFact?.execution ??
    (observedSourceExecutions.length === 1 ? observedSourceExecutions[0] : undefined);
  const sourceCommand = sourceFact?.command ?? sourceOutcome?.command;
  const sourceReceipt = sourceOutcome?.command?.receipt;
  const sourceReceiptExecution =
    sourceReceipt && typeof sourceReceipt === 'object' && !Array.isArray(sourceReceipt)
      ? sourceReceipt.executionId
      : undefined;
  const originalSourceDecision =
    testDiagnostics &&
    card &&
    sourceOutcome &&
    sourceExecution &&
    sourceCommand &&
    ['approval', 'question'].includes(card.kind) &&
    card.state === 'pending' &&
    card.originStoreId === controller.port.storeId &&
    card.sessionId === state.sessionId &&
    card.presentationSessionId === state.sessionId &&
    card.executionId === sourceExecution.id &&
    card.definitionId === 'builtin.mcp.sources/mcp.source.approve' &&
    card.definitionVersion === '1' &&
    sourceOutcome.intent.sessionId === state.sessionId &&
    sourceOutcome.intent.workspaceId === state.snapshot?.view.session.workspaceId &&
    sourceOutcome.intent.request.expectedStoreId === controller.port.storeId &&
    (!sourceFact ||
      (sourceFact.storeId === controller.port.storeId &&
        sourceFact.sessionId === state.sessionId)) &&
    sourceExecution.originStoreId === controller.port.storeId &&
    sourceExecution.sessionId === state.sessionId &&
    sourceExecution.definitionId === card.definitionId &&
    sourceExecution.definitionVersion === '1' &&
    sourceExecution.kind === 'job' &&
    sourceCommand.kind === 'extension.invoke' &&
    sourceCommand.originStoreId === controller.port.storeId &&
    sourceCommand.sessionId === state.sessionId &&
    (sourceFact?.command
      ? sourceFact.command.executionId === sourceExecution.id
      : sourceReceiptExecution === sourceExecution.id ||
        (sourceCommand.status === 'accepted' && sourceReceiptExecution === undefined)) &&
    sourceCommand.id === sourceOutcome.intent.request.commandId &&
    (sourceFact?.execution
      ? sourceFact.execution.originCommandId === sourceCommand.id
      : observedSourceExecutions.length === 1) &&
    (!sourceFact || sourceFact.serverId === sourceOutcome.intent.request.input.serverId)
      ? sourceCommand.id
      : undefined;
  const form =
    card?.kind === 'question' && !sourceQuestion ? questionForm(card.request) : undefined;
  const questionSubmission = card?.kind === 'question' ? controller.answerPhase(card) : undefined;
  let question = questionDrafts.current.get(approvalKey);
  if (form && !question) {
    question = questionDraft(form);
    if (providerQuestion) question.fields[0]!.selected = 0;
    questionDrafts.current.set(approvalKey, question);
  }
  const questionActive = !!form && !!question && !blockingPanel && !chooser && !cardChooser;
  const jsonQuestion = card?.kind === 'question' && !sourceQuestion && !form;
  const plainAnswerActive =
    !!card &&
    card.kind !== 'plan_review' &&
    !sourceQuestion &&
    !form &&
    !blockingPanel &&
    !chooser &&
    !cardChooser;
  const selectedSource = sourceChoices.get(approvalKey);
  const offersSameCommand =
    card?.kind === 'approval' &&
    card.request !== null &&
    typeof card.request === 'object' &&
    !Array.isArray(card.request) &&
    Array.isArray(card.request.grants) &&
    card.request.grants.includes('same_command');
  const approvalAnswers = offersSameCommand
    ? ['approve', 'approve same_command', 'deny']
    : ['approve', 'deny'];
  const selectedApproval =
    approvalChoices.get(approvalKey) ??
    (card?.kind === 'approval' && !offersSameCommand ? 0 : undefined);
  const setAnswer = (value: string | ((previous: string) => string)) => {
    answerBuffer.sync(typeof value === 'function' ? value(answerBuffer.text) : value);
    renderQuestion((n) => n + 1);
  };
  // New revision cannot inherit the old answer or grant selection; other cards retain their drafts.
  useEffect(() => {
    const current = state.snapshot?.interactions;
    if (!current) return;
    const obsolete = (key: string) => {
      const [store, source, presentation, id, revision] = JSON.parse(key);
      const fresh = current.find(
        (item) =>
          item.originStoreId === store &&
          item.sessionId === source &&
          item.presentationSessionId === presentation &&
          item.id === id,
      );
      return fresh
        ? fresh.revision !== revision || fresh.state !== 'pending'
        : presentation === state.snapshot?.view.session.id;
    };
    for (const key of questionDrafts.current.keys()) {
      if (obsolete(key)) questionDrafts.current.delete(key);
    }
    for (const key of cardDrafts.current.keys()) {
      if (obsolete(key)) cardDrafts.current.delete(key);
    }
    setApprovalChoices((previous) => new Map([...previous].filter(([key]) => !obsolete(key))));
    setSourceChoices((previous) => new Map([...previous].filter(([key]) => !obsolete(key))));
  }, [state.snapshot, setApprovalChoices, setSourceChoices]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Leaving the presentation Session clears its explicit Source decision.
  useEffect(() => {
    setSourceChoices(new Map());
  }, [state.sessionId, setSourceChoices]);
  useEffect(() => {
    void controller.list();
  }, [controller]);
  usePaste(
    (text) => {
      if (plainAnswerActive) {
        answerBuffer.insert(text, true);
        renderQuestion((n) => n + 1);
        return;
      }
      const submission = card && controller.answerPhase(card);
      if (!questionActive || !form || !question || (submission && submission !== 'rejected'))
        return;
      const field = form.fields[question.step]!,
        draft = question.fields[question.step]!;
      if (field.text && (!field.choices.length || draft.selected === field.choices.length)) {
        draft.buffer.insert(text, true);
        draft.skipped = false;
        renderQuestion((n) => n + 1);
      }
    },
    // Keep literal paste on this channel even when a card chooser ignores it.
    // With no listener Ink otherwise forwards paste as native keyboard input.
    { isActive: !blockingPanel },
  );
  useInput(
    (input, key) => {
      if (key.tab && key.shift) {
        lastCancelKey.current = undefined;
        controller.togglePlanning();
        return;
      }
      const majorCancel =
        !chooser &&
        !cardChooser &&
        !blockingPanel &&
        !sourceQuestion &&
        ((key.ctrl && input === 'c') || isCtrlCBatch(input));
      if (majorCancel) {
        const now = Date.now();
        // Coalesced native cancellation bytes are one request, never an exit gesture.
        if (
          !isCtrlCBatch(input) &&
          lastCancelKey.current !== undefined &&
          now - lastCancelKey.current < 1000
        ) {
          lastCancelKey.current = undefined;
          if (onQuit) onQuit();
          else void controller.routeCommand('/exit');
          return;
        }
        lastCancelKey.current = isCtrlCBatch(input) ? undefined : now;
      } else lastCancelKey.current = undefined;
      if (chooser) return;
      const cancelKey = (key.ctrl && input === 'c') || (!blockingPanel && isCtrlCBatch(input));
      if (state.panel === 'recovery') return;
      if (state.panel === 'management_requests') return;
      if (state.panel === 'executions') return;
      if (blockingPanel === 'mcp') return;
      if (state.panel === 'skills' || state.panel === 'theme' || state.panel === 'language') return;
      if (state.panel === 'status') {
        if (key.escape || cancelKey) controller.closePanel();
        else if (input.toLowerCase() === 'r') void controller.openStatus();
        return;
      }
      if (state.panel === 'help') return;
      if (cancelKey) {
        if (sourceQuestion) {
          setSourceChoices((previous) => {
            const next = new Map(previous);
            next.delete(approvalKey);
            return next;
          });
          setAnswer('');
          controller.closePanel();
          return;
        }
        if (state.panel === 'rewind') {
          controller.closePanel();
          return;
        }
        if (!card && !chooser && !cardChooser && composer.fileToken) {
          composer.dismissed = true;
          void controller.readFileCandidates();
          return;
        }
        void controller.cancel();
        return;
      }
      if (state.panel === 'permissions' || state.panel === 'models' || state.panel === 'effort')
        return;
      if (state.panel === 'rewind') return;
      if (blockingPanel) {
        const items = state.snapshot?.view.executions.filter((e) => e.resultRevision !== null);
        if (key.escape) controller.closePanel();
        else if (key.upArrow) setPanelIndex((i) => Math.max(0, i - 1));
        else if (key.downArrow)
          setPanelIndex((i) => Math.min(Math.max(0, (items?.length ?? 0) - 1), i + 1));
        else if (state.panel === 'context' && !key.ctrl && !key.meta && input.toLowerCase() === 'k')
          controller.openManagementRequests();
        else if (state.panel === 'context' && input === 'i') {
          const item = state.snapshot?.view.executions.filter((e) => e.resultRevision !== null)[
            panelIndex
          ];
          if (item) void controller.includeExecution(item.id);
        }
        return;
      }
      if (cardChooser) {
        if (key.escape) setCardChooser(false);
        else if (key.upArrow) setCardIndex((n) => Math.max(0, n - 1));
        else if (key.downArrow)
          setCardIndex((n) => Math.min(Math.max(0, cardOptions.length - 1), n + 1));
        else if (key.return && cardOptions[cardIndex]) {
          const key = interactionKey(cardOptions[cardIndex]!);
          if (cards.some((item) => interactionKey(item) === key)) setSelectedCard(key);
          setCardChooser(false);
        }
        return;
      }
      if (key.ctrl && input === 'b') {
        setCardIndex(
          Math.max(
            0,
            cards.findIndex((item) => interactionKey(item) === approvalKey),
          ),
        );
        setCardOptions(cards);
        setCardChooser(true);
        return;
      }
      if (key.ctrl && input === 'r') {
        void controller.list();
        setChooser(true);
        return;
      }
      if (key.ctrl && input === 'l') {
        const sessionId = state.sessionId;
        if (sessionId)
          void (async () => {
            await controller.lookup();
            if (controller.state.sessionId === sessionId) await controller.select(sessionId);
          })();
        return;
      }
      if (key.ctrl && input === 'o') {
        const message = state.snapshot?.messages.find(
          (m) =>
            m.outputBody &&
            m.outputBody.readAvailability !== 'unsupported' &&
            m.contentFormat !== 'unsupported' &&
            !state.fullOutputs.has(m.id),
        );
        if (message) void controller.loadOutput(message);
        return;
      }
      if (key.ctrl && input === 'a' && card) {
        void controller.loadAttachment(card);
        return;
      }
      if (!card && key.escape) {
        // The editor owns candidate Escape. Its optional callback handles an
        // ordinary Escape once, independent of Ink listener registration order.
        return;
      }
      if (!card && key.ctrl && input === 'e') {
        controller.openExecutions(tail?.id);
        return;
      }
      if (card) {
        if (card.kind === 'plan_review') return;
        if (form && question) {
          const submission = controller.answerPhase(card);
          if (submission && submission !== 'rejected') return;
          if (key.meta && input === 'a' && form.alternative) {
            if (!state.stale && !state.loading)
              void controller.answer(card, JSON.stringify(form.alternative.value));
            return;
          }
          const field = form.fields[question.step]!,
            draft = question.fields[question.step]!;
          const editing =
            field.text && (!field.choices.length || draft.selected === field.choices.length);
          if (key.meta && input.toLowerCase() === 's' && !field.required) {
            draft.skipped = !draft.skipped;
            renderQuestion((n) => n + 1);
            return;
          }
          if (key.ctrl || (key.meta && !key.return)) return;
          if (key.escape) {
            if (question.step > 0) question.step--;
            else void controller.cancelInteraction(card);
          } else if (key.tab && field.text && field.choices.length) {
            draft.selected = editing ? 0 : field.choices.length;
            draft.skipped = false;
          } else if (key.tab && !field.required) {
            draft.skipped = !draft.skipped;
          } else if (!editing && field.choices.length && (key.upArrow || key.downArrow)) {
            const count = field.choices.length + (field.text ? 1 : 0);
            draft.selected =
              draft.selected === undefined
                ? key.downArrow
                  ? 0
                  : count - 1
                : (draft.selected + (key.downArrow ? 1 : count - 1)) % count;
            draft.skipped = false;
          } else if (key.return && !key.shift && !key.meta) {
            if (!questionValue(field, draft)) {
              draft.attempted = true;
              renderQuestion((n) => n + 1);
              return;
            }
            if (question.step < form.fields.length - 1) question.step++;
            else {
              const value = questionAnswer(form, question);
              if (value !== undefined && !state.stale && !state.loading)
                void controller.answer(card, value);
            }
          } else if (editing) {
            const width = questionInputWidth(stdout.columns, t('Answer'));
            if (key.leftArrow) draft.buffer.horizontal(-1);
            else if (key.rightArrow) draft.buffer.horizontal(1);
            else if (key.home) draft.buffer.boundary(false, width, display);
            else if (key.end) draft.buffer.boundary(true, width, display);
            else if (key.upArrow) draft.buffer.vertical(-1, width, display);
            else if (key.downArrow) draft.buffer.vertical(1, width, display);
            else if (key.backspace) draft.buffer.remove(true);
            else if (key.delete) draft.buffer.remove(false);
            else if (key.return) draft.buffer.insert('\n');
            else if (input) draft.buffer.insert(input);
            draft.skipped = false;
          }
          renderQuestion((n) => n + 1);
          return;
        }
        if (sourceQuestion && key.escape) {
          setSourceChoices((previous) => {
            const next = new Map(previous);
            next.delete(approvalKey);
            return next;
          });
          setAnswer('');
          return;
        }
        if (sourceQuestion && (key.upArrow || key.downArrow)) {
          setSourceChoices((previous) => {
            const next = new Map(previous),
              selected = previous.get(approvalKey);
            next.set(
              approvalKey,
              selected === undefined
                ? key.downArrow
                  ? 0
                  : 2
                : (selected + (key.downArrow ? 1 : 2)) % 3,
            );
            return next;
          });
          return;
        }
        if (card.kind === 'approval' && (key.upArrow || key.downArrow)) {
          setApprovalChoices((previous) => {
            const next = new Map(previous),
              index = previous.get(approvalKey) ?? (offersSameCommand ? undefined : 0);
            next.set(
              approvalKey,
              index === undefined
                ? key.downArrow
                  ? 0
                  : approvalAnswers.length - 1
                : (index + (key.downArrow ? 1 : approvalAnswers.length - 1)) %
                    approvalAnswers.length,
            );
            return next;
          });
          return;
        }

        if (key.escape && card.kind === 'approval') {
          void controller.cancel();
          return;
        }
        if (key.return && (!jsonQuestion || (!key.shift && !key.meta))) {
          const currentAnswer = answerBuffer.text;
          const source = sourceChoiceRef.current.get(approvalKey);
          const approval =
            approvalChoiceRef.current.get(approvalKey) ??
            (card.kind === 'approval' && !offersSameCommand ? 0 : undefined);
          if (card.kind === 'approval' && !currentAnswer.trim() && approval === undefined) return;
          if (currentAnswer.trim().startsWith('/')) {
            void controller.routeCommand(currentAnswer);
            setAnswer('');
          } else
            void controller.answer(
              card,
              (sourceQuestion && source !== undefined
                ? JSON.stringify({ decision: sourceDecisions[source] })
                : currentAnswer) ||
                (card.kind === 'approval' && approval !== undefined
                  ? approvalAnswers[approval]!
                  : ''),
            );
          return;
        }
        if (jsonQuestion) {
          if (key.ctrl || (key.meta && !key.return)) return;
          const width = questionInputWidth(stdout.columns, t('Answer'));
          if (key.leftArrow) answerBuffer.horizontal(-1);
          else if (key.rightArrow) answerBuffer.horizontal(1);
          else if (key.home) answerBuffer.boundary(false, width, display);
          else if (key.end) answerBuffer.boundary(true, width, display);
          else if (key.upArrow) answerBuffer.vertical(-1, width, display);
          else if (key.downArrow) answerBuffer.vertical(1, width, display);
          else if (key.backspace) answerBuffer.remove(true);
          else if (key.delete) answerBuffer.remove(false);
          else if (key.return) answerBuffer.insert('\n');
          else if (input) answerBuffer.insert(input);
          renderQuestion((n) => n + 1);
          return;
        }
        if (key.ctrl || key.meta) return;
        const width = questionInputWidth(stdout.columns, t('Command or private draft'));
        if (key.leftArrow) answerBuffer.horizontal(-1);
        else if (key.rightArrow) answerBuffer.horizontal(1);
        else if (key.home) answerBuffer.boundary(false, width, display);
        else if (key.end) answerBuffer.boundary(true, width, display);
        else if (key.backspace) answerBuffer.remove(true);
        else if (key.delete) answerBuffer.remove(false);
        else if (input) answerBuffer.insert(input);
        renderQuestion((n) => n + 1);
        return;
      }
    },
    { isActive: blockingPanel !== 'mcp' },
  );
  const history = (
    <TuiHistory
      controller={controller}
      card={card}
      form={form}
      step={question?.step}
      collapsed={resultDisplay.collapsed}
    />
  );
  const withHistory = (panel: ReactNode) => (
    <Box flexDirection="column">
      {history}
      {panel}
    </Box>
  );
  if (state.panel === 'executions')
    return withHistory(
      <TuiExecutionPanel controller={controller} initialExecutionId={state.executionSelectedId} />,
    );
  if (state.panel === 'rewind')
    return withHistory(<TuiFileRecoveryPanel controller={controller} />);
  if (blockingPanel === 'mcp')
    return withHistory(<TuiMcpPanel key={state.sessionId} controller={controller} />);
  if (state.panel === 'theme' || state.panel === 'language')
    return withHistory(<TuiPreferencePanel key={state.panel} controller={controller} />);
  if (state.panel === 'status') return withHistory(<TuiStatusPanel controller={controller} />);
  if (state.panel === 'recovery')
    return withHistory(<TuiRecoveryPanel key={state.sessionId} controller={controller} />);
  if (state.panel === 'management_requests')
    return withHistory(<TuiManagementRequestsPanel controller={controller} />);
  if (state.panel === 'skills')
    return withHistory(<TuiSkillsPanel key={state.sessionId} controller={controller} />);
  if (state.panel === 'help') return withHistory(<TuiHelpPanel controller={controller} />);
  const running = activity(state.snapshot);
  const focused = !!card || !!state.panel || chooser || cardChooser;
  const childOwnsActivity =
    !!state.snapshot &&
    state.snapshot.view.executions.some((execution) => {
      if (execution.kind !== 'job') return false;
      const block = projectInkChild(execution, state.snapshot!);
      return (
        block?.kind === 'subagent' && ['creating', 'running', 'suspended'].includes(block.status)
      );
    });
  const currentCancelling = state.snapshot?.view.runs.some(
    (run) =>
      run.isActive &&
      run.status === 'cancelling' &&
      run.originStoreId === controller.port.storeId &&
      run.sessionId === state.sessionId,
  );
  const activeLine =
    !focused && !state.stale
      ? hasPendingRootCancellation(state, controller.port.storeId) &&
        !currentCancelling &&
        running !== 'Cancelling'
        ? ('Cancelling · cancellation requested' as const)
        : currentCancelling || running === 'Cancelling'
          ? ('Cancelling' as const)
          : !childOwnsActivity && ['Working', 'Waiting for required result'].includes(running)
            ? (running as 'Working' | 'Waiting for required result')
            : undefined
      : undefined;
  const activeModel = (
    currentActivityVerified(state.snapshot) ? state.snapshot?.view.executions : undefined
  )
    ?.filter(
      (item) =>
        item.kind === 'model' &&
        item.runId === state.snapshot?.view.runs.find((run) => run.isActive)?.id &&
        ['running', 'dispatching'].includes(item.status),
    )
    .at(-1);
  const activeTiming = activeModel && state.snapshot?.executionTimings?.[activeModel.id];
  return (
    <Box
      flexDirection="column"
      maxHeight={focused ? undefined : Math.max(1, rows - 1)}
      overflowY={focused ? undefined : 'hidden'}
      justifyContent="flex-end"
    >
      {history}
      {testDiagnostics ? (
        <Text bold>
          {t('Session')} {terminalText(state.sessionId ?? t('not selected'))} {'·'}{' '}
          {t(activity(state.snapshot))}
          {state.loading ? t(' · Loading') : ''}
          {state.stale ? t(' · Stale') : ''}
        </Text>
      ) : (
        <>
          {(state.stale ||
            running === 'Unknown — verify original work' ||
            running === 'Unavailable') && (
            <Text color="yellow">
              {t(state.stale ? 'Observation unknown: new writes disabled' : running)}
            </Text>
          )}
          {state.loading && <Text dimColor>{t('Loading')}</Text>}
        </>
      )}
      {state.snapshot && !currentActivityVerified(state.snapshot) && (
        <Text color="yellow">
          {t(
            'This connection cannot verify activity; work may still be executing in another owner.',
          )}
        </Text>
      )}
      {state.snapshot &&
        !state.stale &&
        !state.snapshotStale &&
        state.snapshot.storeId === controller.port.storeId &&
        state.snapshot.view.session.id === state.sessionId &&
        !state.snapshot.view.runs.some((run) => run.isActive) &&
        state.snapshot.view.runs.at(-1)?.status === 'cancelled' &&
        state.snapshot.view.runs.at(-1)?.originStoreId === controller.port.storeId &&
        state.snapshot.view.runs.at(-1)?.sessionId === state.sessionId && (
          <Text dimColor>
            {t('Current task')} · {t('Cancelled')}
          </Text>
        )}
      {(unfinishedJobs > 0 || unknownJobs > 0) && (
        <Text>
          {t('Background Jobs:')} {unfinishedJobs} {t('unfinished')} · {unknownJobs} {t('unknown')}
        </Text>
      )}
      {(state.panel === 'models' || state.panel === 'effort') && (
        <TuiModelPanel key={state.sessionId} controller={controller} />
      )}
      {state.panel === 'permissions' && (
        <TuiPermissionPanel key={state.sessionId} controller={controller} />
      )}
      {chooser && <TuiSessionChooser controller={controller} close={() => setChooser(false)} />}
      {cardChooser && (
        <TuiOverlayFrame
          title={`${t('Pending cards ·')} ${cardOptions.length}`}
          hint={t('· Up/Down, Enter selects original card, Esc closes')}
        >
          {cardOptions.slice(Math.max(0, cardIndex - 2), cardIndex + 3).map((item) => (
            <Text key={interactionKey(item)}>
              {cardOptions[cardIndex] === item ? '› ' : '  '}
              {testDiagnostics ? (
                <>
                  {item.kind} [{terminalText(item.id)}
                  {t('] original Session')} {terminalText(item.sessionId)} · Store{' '}
                  {terminalText(item.originStoreId)} {t('· revision')} {item.revision}
                </>
              ) : (
                <>
                  {t(
                    item.kind === 'approval'
                      ? 'Approval'
                      : item.kind === 'plan_review'
                        ? 'Plan review'
                        : 'Question',
                  )}{' '}
                  ·{' '}
                  {terminalText(
                    String(
                      (item.request &&
                        typeof item.request === 'object' &&
                        !Array.isArray(item.request) &&
                        (item.request.title ?? item.request.description)) ||
                        '',
                    ),
                  )}
                </>
              )}
              {cards.some((current) => interactionKey(current) === interactionKey(item))
                ? ''
                : t(' · changed; reopen to select')}
            </Text>
          ))}
        </TuiOverlayFrame>
      )}
      {card && !cardChooser && !chooser && !blockingPanel && (
        <Box flexDirection="column">
          {form && question && (
            <QuestionPanel
              form={form}
              draft={question}
              submission={questionSubmission}
              providerAction={providerQuestion}
              compactMaterial={
                testDiagnostics ||
                longQuestionMaterial(form, question.step, stdout.columns || 80, stdout.rows || 24)
              }
            />
          )}
          {card.kind === 'approval' && (
            <TuiApprovalPanel
              card={card}
              choices={approvalAnswers}
              selected={selectedApproval}
              busy={
                state.loading ||
                state.stale ||
                ['submitting', 'unknown'].includes(state.intent?.phase ?? '')
              }
              error={state.error}
            />
          )}
          {card.kind === 'plan_review' && (
            <TuiPlanReviewPanel
              key={approvalKey}
              card={card}
              feedback={answerBuffer}
              onAnswer={(text) => void controller.answer(card, text)}
              busy={
                state.loading ||
                state.stale ||
                ['submitting', 'unknown'].includes(state.intent?.phase ?? '')
              }
              error={state.error}
            />
          )}
          {(sourceQuestion || jsonQuestion) && (
            <TuiOverlayFrame title={t('Question')}>
              {sourceQuestion && testDiagnostics && (
                <Text>
                  {t('Up/Down explicit source decision:')}{' '}
                  {selectedSource === undefined
                    ? t('none (Enter has no answer)')
                    : t(sourceDecisions[selectedSource]!)}
                </Text>
              )}
              {sourceQuestion && !testDiagnostics && (
                <Box flexDirection="column">
                  <Text>
                    {selectedSource === undefined ? '❯ ' : '  '}
                    {t('Decide later')}
                  </Text>
                  {sourceDecisions.map((decision, index) => (
                    <Text key={decision}>
                      {selectedSource === index ? '❯ ' : '  '}
                      {t(
                        decision === 'approved'
                          ? 'Approve and connect'
                          : decision === 'rejected'
                            ? 'Reject'
                            : 'Cancel',
                      )}
                    </Text>
                  ))}
                  {selectedSource === undefined && (
                    <Text dimColor>{t('none (Enter has no answer)')}</Text>
                  )}
                </Box>
              )}
              {jsonQuestion && (
                <>
                  <Text>{t('Question: original-schema JSON.')}</Text>
                  <TuiAnswerInput buffer={answerBuffer} />
                  <Text>
                    {t('Arrows/Home/End: edit JSON · Enter: submit · Shift+Enter: newline')}
                  </Text>
                </>
              )}
              {sourceQuestion && <Text>{terminalText(answer)}</Text>}
            </TuiOverlayFrame>
          )}
          {testDiagnostics &&
            card.originStoreId === controller.port.storeId &&
            card.sessionId === state.sessionId &&
            card.presentationSessionId === state.sessionId && (
              <Text>
                {card.kind} [{terminalText(card.id)}] {t('original Session')}{' '}
                {terminalText(card.sessionId)} · {card.state} · {t('revision')} {card.revision}
              </Text>
            )}
          {originalConnection && (
            <Text>
              {t(reconnectingCard ? 'Original forced reconnect:' : 'Original connection:')}{' '}
              {terminalText(originalConnection)}
            </Text>
          )}
          {originalSourceDecision && (
            <Text>
              {t('Original source decision:')} {terminalText(originalSourceDecision)}
            </Text>
          )}
          {requiresInteractionAttachment(card) && !state.attachments.has(approvalKey) && (
            <Text color="yellow">{t('Ctrl+A: read required attachment.')}</Text>
          )}
        </Box>
      )}
      {state.panel === 'context' && (
        <TuiOverlayFrame title={t('Context')}>
          <Text>
            {t('Current selected Context projection, not actual Model input Inspector; Esc close')}
          </Text>
          <Text>{t('K: choose an original Context/Session request')}</Text>
          {state.context ? (
            <>
              {testDiagnostics && (
                <Text>
                  {t('Selection')} {terminalText(state.context.selection.id)} {t('/ frozen upper')}{' '}
                  {state.context.highWaterSeq}
                </Text>
              )}
              {state.context.messages.map((message) => (
                <Box key={message.id} flexDirection="column">
                  <Text bold>
                    {testDiagnostics
                      ? `${message.seq} [${terminalText(message.id)}]`
                      : t(
                          message.role === 'user'
                            ? 'User'
                            : message.role === 'assistant'
                              ? 'Assistant'
                              : message.role === 'tool'
                                ? 'Tool result'
                                : 'System',
                        )}
                  </Text>
                  <TerminalMarkdown content={message.content} />
                </Box>
              ))}
              {state.context.resultSources.map((source) => (
                <Box key={source.id} flexDirection="column">
                  <Text bold>
                    {t('Source')}{' '}
                    {testDiagnostics
                      ? `${terminalText(source.id)} [${terminalText(source.executionId)}]`
                      : terminalText(
                          state.snapshot?.view.executions.find(
                            (item) => item.id === source.executionId,
                          )?.definitionId ?? t('Recorded result'),
                        )}
                  </Text>
                  <TuiResult value={source.result} />
                </Box>
              ))}
            </>
          ) : (
            <Text>{t('Context reading/unavailable')}</Text>
          )}
          {state.panel === 'context' && (
            <>
              <Text>
                {t(
                  'Choose exact historical result with arrows; i explicitly includes into displayed active original Run or idle selection.',
                )}
              </Text>
              {state.snapshot?.view.executions
                .filter((e) => e.resultRevision !== null)
                .map((e, i) => ({ e, i }))
                .slice(Math.max(0, panelIndex - 2), panelIndex + 3)
                .map(({ e, i }) => (
                  <Text key={e.id}>
                    {panelIndex === i ? '› ' : ''}
                    {testDiagnostics ? (
                      <>
                        {terminalText(e.id)} {t('revision')}{' '}
                        {terminalText(e.resultRevision ?? t('unavailable'))}
                      </>
                    ) : (
                      terminalText(e.definitionId)
                    )}{' '}
                    {'/'} {testDiagnostics ? e.status : t(e.status)}
                  </Text>
                ))}
              <Text>
                {t('Target Run')}{' '}
                {testDiagnostics
                  ? terminalText(state.snapshot?.view.runs.find((r) => r.isActive)?.id ?? 'idle')
                  : t(
                      state.snapshot?.view.runs.some((run) => run.isActive)
                        ? 'Current task'
                        : 'Next task',
                    )}
              </Text>
              <Text dimColor>{t('Context capacity estimate unavailable')}</Text>
            </>
          )}
        </TuiOverlayFrame>
      )}
      {state.notice && (testDiagnostics || !state.notice.startsWith('/plan [task]')) && (
        <Text>
          {t('Notice:')}{' '}
          {terminalText(
            state.noticeFragments
              ? state.noticeFragments
                  .map((part) => (part.label ? t(part.text) : part.text))
                  .join('')
              : state.notice.startsWith('Exported loaded conversation:')
                ? (testDiagnostics ? t('Exported loaded conversation:') : 'Session exported:') +
                  state.notice.slice('Exported loaded conversation:'.length)
                : state.notice,
          )}
        </Text>
      )}
      {state.management &&
        (testDiagnostics ||
          !['applied', 'completed'].includes(state.management.status) ||
          state.management.intent.sessionId !== state.sessionId) && (
          <Text>
            {testDiagnostics || state.management.intent.sessionId !== state.sessionId ? (
              <>
                {t('Original management')} {terminalText(state.management.intent.sessionId)} {'/'}{' '}
                {terminalText(state.management.intent.request.commandId)}{' '}
                {state.management.intent.kind}
              </>
            ) : (
              t('Session operation')
            )}
            {':'} {state.management.status}{' '}
            {state.management.status === 'delete_requested'
              ? t('(stop unconfirmed; files unchanged)')
              : state.management.status === 'accepted' || state.management.status === 'queued'
                ? t('(receipt queued, not completed)')
                : ''}
            {state.management.omittedExtensionState ? t(' · Fork omitted extension state') : ''}
          </Text>
        )}
      {state.intent &&
        (testDiagnostics ||
          ['unknown', 'submitting', 'rejected'].includes(state.intent.phase) ||
          state.intent.sessionId !== state.sessionId) && (
          <Text>
            {testDiagnostics || state.intent.sessionId !== state.sessionId ? (
              <>
                {t('Original')} {terminalText(state.intent.sessionId)} {'/'}{' '}
                {terminalText(state.intent.commandId)} {terminalText(state.intent.kind)}
              </>
            ) : (
              t('Submission')
            )}
            {':'}{' '}
            {testDiagnostics
              ? state.intent.phase
              : t(state.intent.phase === 'unknown' ? 'Outcome unknown' : state.intent.phase)}{' '}
            {testDiagnostics && t('(receipt is not dispatch success)')}
            {state.intent.phase === 'unknown' && (
              <>
                {' · '}
                {t('Ctrl+L: check the original request')}
              </>
            )}
          </Text>
        )}
      {state.error && (
        <Text color="red">
          {t('Error:')} {terminalText(state.error)}
        </Text>
      )}
      {testDiagnostics && (
        <Text>
          {t(
            'Ctrl+B pending cards · Ctrl+R sessions · Ctrl+L refresh · Ctrl+O full output · Ctrl+C cancels exact original Command',
          )}
        </Text>
      )}
      {testDiagnostics && tail && !card && !state.panel && !chooser && !cardChooser && (
        <Text dimColor>
          {t(
            resultDisplay.collapsed.has(executionDisplayKey(tail))
              ? 'Empty Enter expands the current tail result'
              : 'Empty Enter collapses the current tail result',
          )}
        </Text>
      )}
      {testDiagnostics &&
        !focused &&
        !state.stale &&
        activeTiming?.availability === 'recorded_dispatch' &&
        activeTiming.startedAt !== undefined &&
        activeTiming.finishedAt === undefined && (
          <TuiRecordedPhaseTime startedAt={activeTiming.startedAt} label="Thinking" />
        )}
      {state.snapshot?.pendingInputsUnavailable && (
        <Text color="yellow">{t('Pending input queue unavailable')}</Text>
      )}
      {state.snapshot?.pendingInputs && state.snapshot.pendingInputs.length > 0 && (
        <Box flexDirection="column">
          {(testDiagnostics || state.stale) && (
            <Text dimColor>
              {t(state.stale ? 'Last confirmed pending inputs' : 'Pending inputs')} ·{' '}
              {state.snapshot.pendingInputs.length}
            </Text>
          )}
          {state.snapshot.pendingInputs.map((input, index) => (
            <Box key={input.id} flexDirection="column">
              <Text dimColor>
                ↵{' '}
                {testDiagnostics
                  ? `${index + 1} · ${t(input.kind === 'input.steer' ? 'Guidance pending' : 'Follow-up waiting')} [${terminalText(input.id)}]`
                  : terminalText(input.request.content)}
              </Text>
              {testDiagnostics && <Text>{terminalText(input.request.content)}</Text>}
            </Box>
          ))}
        </Box>
      )}
      <TuiFooter
        {...chromeFacts(state)}
        activity={activeLine}
        planning={state.planning}
        inputActive={!focused}
      >
        {card?.kind === 'approval' &&
          !state.panel &&
          !chooser &&
          !cardChooser &&
          (testDiagnostics ? (
            <Text>{terminalText(answer)}</Text>
          ) : (
            <TuiAnswerInput buffer={answerBuffer} label="Command or private draft" />
          ))}
        {testDiagnostics &&
          !focused &&
          (state.planning || state.snapshot?.view.runs.some((r) => r.isActive)) && (
            <Text dimColor>
              {state.planning ? t('Planning next Run') : t('Add guidance to the current task')}
            </Text>
          )}
        <TuiComposer
          planning={state.planning}
          buffer={composer}
          files={state.fileCandidates}
          fileScope={`${composerScope}:${state.loading}:${state.snapshotStale}`}
          onFileQuery={fileQuery}
          value={state.draft}
          active={!card && !state.panel && !chooser && !cardChooser}
          label={
            state.planning
              ? state.snapshot?.view.runs.some((r) => r.isActive)
                ? t('Queue Planning after original Run')
                : t('Planning next Run')
              : state.snapshot?.view.runs.some((r) => r.isActive)
                ? ['context.compress', 'context.compression.reset'].includes(
                    state.snapshot.activeCommand?.kind ?? '',
                  )
                  ? t('Queue follow-up after original maintenance Run')
                  : t('Steer original active Run')
                : t('New Run')
          }
          onChange={(text) => controller.setDraft(text)}
          onSubmit={() => void controller.send()}
          onEscape={() => void controller.cancel()}
          onEmptyEnter={() => {
            const current = controller.visibleExecutions
              .filter((item) => item.kind !== 'model')
              .at(-1);
            if (
              !tail ||
              !current ||
              controller.state.sessionId !== state.sessionId ||
              executionDisplayKey(current) !== executionDisplayKey(tail)
            )
              return;
            const display = resultDisplayRef.current;
            if (display.scope !== resultScope) return;
            const collapsed = new Set(display.collapsed),
              key = executionDisplayKey(tail);
            if (collapsed.has(key)) collapsed.delete(key);
            else collapsed.add(key);
            const next = { ...display, collapsed };
            resultDisplayRef.current = next;
            setResultDisplay(next);
          }}
        />
      </TuiFooter>
    </Box>
  );
}
