import {
  type Interaction,
  type Message,
  type ModelOutputSnapshot,
  requiresInteractionAttachment,
  type SessionView,
} from '@kite-ai/client';
import { Box, Static, useInput, usePaste, useStdout } from 'ink';
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
  type TuiChromeFacts,
  TuiFooter,
  TuiHeader,
  TuiOverlayFrame,
  TuiRecordedPhaseTime,
} from './chrome';
import { fixedTuiCommands } from './commands';
import { ComposerBuffer, composerDisplay } from './composer';
import { isCtrlCBatch, TuiComposer } from './composer-input';
import { activity, type TuiController, terminalText } from './controller';
import { TuiExecutionPanel } from './execution-panel';
import {
  InkExecution,
  InkExecutionGroupView,
  InkTaskProgress,
  InkThought,
  projectInkExecutionGroups,
} from './execution-projection';
import type { FileToken } from './file-candidates';
import { TuiFileRecoveryPanel } from './file-recovery-panel';
import { TuiHelpPanel } from './help-panel';
import CompactionProgress from './ink/CompactionProgress';
import { wrapDisplayLines } from './ink/soft-wrap';
import ToolSummaryBlock from './ink/ToolSummaryBlock';
import UserMessageBlock from './ink/UserMessageBlock';
import { useInkWindowSize } from './ink/window-size';
import { TuiManagementRequestsPanel } from './management-requests-panel';
import { TerminalMarkdown } from './markdown';
import { TuiMcpPanel } from './mcp-panel';
import { isMcpSourceQuestion, sourceDecisions } from './mcp-source-question';
import { TuiModelPanel } from './model-panel';
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
    onReadinessChange?.(!gated);
  }, [gated, onReadinessChange]);
  return (
    <TuiPresentationProvider value={{ preferences: state.preferences, testDiagnostics }}>
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
  showReasoning,
}: {
  controller: TuiController;
  card?: Interaction;
  form?: ReturnType<typeof questionForm>;
  step?: number;
  collapsed: ReadonlySet<string>;
  showReasoning: boolean;
}) {
  const state = useSyncExternalStore(controller.subscribe, () => controller.state);
  const { stdout, write } = useStdout();
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
    testDiagnostics,
    columns,
  ]);
  const messages = controller.visibleMessages;
  const loadedOutputs = useMemo(
    () => displayModelOutputs(snapshot, state.loadedOutputBodies),
    [snapshot, state.loadedOutputBodies],
  );
  const executions = controller.visibleExecutions;
  const items: HistoryItem[] = useMemo(() => {
    const results = executions.filter((execution) => execution.kind !== 'model');
    const transcript = projectTuiMessages(messages, loadedOutputs);
    const phaseKey = (message: Message) =>
      JSON.stringify([
        message.originMessage?.storeId ?? snapshot?.storeId,
        message.originMessage?.sessionId ?? message.sessionId,
        message.originMessage ? message.originMessage.runId : message.runId,
      ]);
    const lastMessage = new Map(transcript.map((item, index) => [phaseKey(item.message), index]));
    const groups =
      !testDiagnostics && snapshot
        ? projectInkExecutionGroups(snapshot, loadedOutputs, true).filter((group) =>
            group.executionIds.every((id) => results.some((execution) => execution.id === id)),
          )
        : [];
    const grouped = new Map(
      groups.flatMap((group) => group.executionIds.map((id) => [id, group] as const)),
    );
    const renderedGroups = new Set<string>();
    const placed = new Set<string>();
    const belongs = (message: Message, execution: Execution) =>
      execution.sessionId === (message.originMessage?.sessionId ?? message.sessionId) &&
      execution.runId === (message.originMessage ? message.originMessage.runId : message.runId) &&
      execution.originStoreId === (message.originMessage?.storeId ?? snapshot?.storeId);
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
        const related = results.filter(
          (execution) =>
            !placed.has(execution.id) &&
            belongs(message, execution) &&
            (item.sourceIds.includes(execution.id) ||
              (message.outputBody !== undefined &&
                execution.parentExecutionId === message.outputBody.executionId) ||
              (execution.kind === 'tool' &&
                execution.toolCallId !== undefined &&
                item.kind === 'message' &&
                item.toolCalls.some((call) => call.id === execution.toolCallId))),
        );
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
              (item.sourceIds.includes(execution.id) || execution.toolCallId === item.call.id),
          );
        const body = loadedOutputs.get(message.id);
        return [
          ...(!testDiagnostics && ownedResult
            ? []
            : [
                {
                  key: `message:${message.id}`,
                  mutable:
                    message.status === 'incomplete' ||
                    (!!model && executionLive(model)) ||
                    related.some(executionLive) ||
                    (!!message.outputBody &&
                      !state.fullOutputs.has(message.id) &&
                      message.outputBody.readAvailability !== 'unsupported' &&
                      BigInt(message.outputBody.contentBytes) >
                        BigInt(new TextEncoder().encode(message.content).byteLength)),
                  version: JSON.stringify([
                    item,
                    state.fullOutputs.get(message.id),
                    body,
                    related,
                    showReasoning,
                    timing,
                    model?.status,
                  ]),
                  node:
                    item.kind === 'tool-result' ? (
                      <TuiToolResult item={item} />
                    ) : (
                      <TuiMessage
                        message={message}
                        controller={controller}
                        fullOutput={state.fullOutputs.get(message.id) ?? body?.content}
                        reasoning={item.reasoning}
                        transcript={item}
                        snapshot={snapshot}
                        loadedOutputs={loadedOutputs}
                        showReasoning={showReasoning}
                        hasReadGroup={groups.some(
                          (group) =>
                            group.messageId === message.id && group.kind === 'readonly_tools',
                        )}
                        modelStatus={model?.status}
                        elapsedMs={phaseElapsed(timing || undefined)}
                      />
                    ),
                },
              ]),
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
                  {form &&
                    Object.entries(card.request as Record<string, unknown>)
                      .filter(
                        ([key, value]) =>
                          ['title', 'question', 'description'].includes(key) &&
                          typeof value === 'string',
                      )
                      .map(([key, value]) => <Text key={key}>{terminalText(String(value))}</Text>)}
                  {form && step !== undefined ? (
                    <QuestionMaterial form={form} step={step} />
                  ) : testDiagnostics ? (
                    <Text>{terminalText(JSON.stringify(card.request, null, 2))}</Text>
                  ) : (
                    <TuiResult value={card.request} />
                  )}
                  {state.attachments.get(interactionKey(card)) && (
                    <Text>{terminalText(state.attachments.get(interactionKey(card))!)}</Text>
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
    card,
    form,
    step,
    controller,
    t,
    collapsed,
    showReasoning,
    facts,
    testDiagnostics,
    snapshot,
    columns,
    rows,
  ]);
  // Preserve the original Ink ownership split: immutable prefix goes to native
  // scrollback once; the first mutable item and following rows remain live.
  const mutableIndex = items.findIndex((item) => item.mutable);
  const materialStatic =
    testDiagnostics || (!!card && longQuestionMaterial(form, step, columns, rows));
  const sealed = materialStatic || mutableIndex < 0 ? items : items.slice(0, mutableIndex);
  const live = materialStatic || mutableIndex < 0 ? [] : items.slice(mutableIndex);
  const [committed, setCommitted] = useState({ scope, items: sealed, epoch: 0 });
  const replace =
    committed.scope !== scope ||
    committed.items.some(
      (item, index) => sealed[index]?.key !== item.key || sealed[index]?.version !== item.version,
    );
  let history = committed;
  if (replace) {
    history = { scope, items: sealed, epoch: committed.epoch + 1 };
    setCommitted(history);
  } else if (sealed.length !== committed.items.length) {
    history = { ...committed, items: sealed };
    setCommitted(history);
  }
  useInsertionEffect(() => {
    if (history.epoch && stdout.isTTY) write('\u001b[2J\u001b[3J\u001b[H');
  }, [history.epoch, stdout, write]);
  const attachment = card && state.attachments.get(interactionKey(card));
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
        {!testDiagnostics && card && attachment && (
          <Static key={`attachment:${scope}:${interactionKey(card)}`} items={[attachment]}>
            {(body, index) => (
              <Box key={index} flexDirection="column">
                <Text bold>{t('Approval material')}</Text>
                <Text>{terminalText(body)}</Text>
              </Box>
            )}
          </Static>
        )}
      </Box>
      {live.length > 0 && (
        <Box
          flexDirection="column"
          flexShrink={1}
          minHeight={0}
          maxHeight={Math.max(1, rows - 7)}
          overflowY="hidden"
        >
          {live.map((item) => (
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
  elapsedMs,
  showReasoning,
  hasReadGroup,
}: {
  message: Message;
  controller: TuiController;
  fullOutput?: string;
  reasoning?: string;
  transcript: TuiTranscriptMessage;
  snapshot?: import('./controller').TuiSnapshot;
  loadedOutputs?: ReadonlyMap<string, ModelOutputSnapshot['output']>;
  modelStatus?: Execution['status'];
  elapsedMs?: number;
  showReasoning: boolean;
  hasReadGroup?: boolean;
}) {
  const { t, testDiagnostics } = useTuiPresentation();
  const { stdout } = useStdout();
  return (
    <Box
      flexDirection="column"
      marginBottom={1}
      paddingLeft={!testDiagnostics && message.role === 'assistant' ? 2 : 0}
    >
      {testDiagnostics ? (
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
      )}
      {!testDiagnostics &&
        message.status === 'incomplete' &&
        !['planned', 'dispatching', 'running'].includes(modelStatus ?? '') && (
          <Text color="yellow">{t('Incomplete response')}</Text>
        )}
      {message.role === 'assistant' &&
        (reasoning ||
          transcript.toolCalls.length > 0 ||
          showReasoning ||
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
                expanded={showReasoning}
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
                />
              )
            )}
            {!testDiagnostics && showReasoning && reasoning && (
              <TerminalMarkdown content={reasoning} streaming={modelStatus === 'running'} />
            )}
            {showReasoning && reasoning === undefined && message.outputBody && (
              <Text dimColor>
                {message.outputBody.reasoningBytes === '0'
                  ? t('No recorded reasoning in this snapshot')
                  : `${t('Recorded reasoning not loaded;')} ${
                      message.outputBody.readAvailability === 'unsupported' ||
                      message.contentFormat === 'unsupported'
                        ? t('full read unsupported')
                        : controller.port.readModelOutput
                          ? t('Ctrl+O reads verified full body')
                          : t('full reader unavailable')
                    }`}
              </Text>
            )}
          </Box>
        )}
      {!testDiagnostics && message.role === 'user' ? (
        <UserMessageBlock
          content={terminalText(fullOutput ?? message.content)}
          columns={stdout.columns || 80}
        />
      ) : (
        <TerminalMarkdown
          content={fullOutput ?? message.content}
          streaming={
            message.status === 'incomplete' &&
            ['planned', 'dispatching', 'running'].includes(modelStatus ?? '')
          }
        />
      )}
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
  if (!testDiagnostics && snapshot)
    return (
      <InkExecution
        execution={execution}
        snapshot={snapshot}
        loadedOutputs={loadedOutputs}
        expanded={!collapsed}
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
  useInkWindowSize();
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
    showReasoning: false,
  });
  let resultDisplay = savedDisplay;
  if (savedDisplay.scope !== resultScope) {
    resultDisplay = { scope: resultScope, collapsed: new Set(), showReasoning: false };
    setResultDisplay(resultDisplay);
  } else if ([...savedDisplay.collapsed].some((key) => !resultKeys.has(key))) {
    resultDisplay = {
      ...savedDisplay,
      collapsed: new Set([...savedDisplay.collapsed].filter((key) => resultKeys.has(key))),
    };
    setResultDisplay(resultDisplay);
  }
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
  const [sourceChoices, setSourceChoices] = useState(new Map<string, number>());
  const [approvalChoices, setApprovalChoices] = useState(new Map<string, number>());
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
  const form =
    card?.kind === 'question' && !sourceQuestion ? questionForm(card.request) : undefined;
  let question = questionDrafts.current.get(approvalKey);
  if (form && !question) {
    question = questionDraft(form);
    questionDrafts.current.set(approvalKey, question);
  }
  const questionActive = !!form && !!question && !state.panel && !chooser && !cardChooser;
  const jsonQuestion = card?.kind === 'question' && !sourceQuestion && !form;
  const plainAnswerActive =
    !!card &&
    card.kind !== 'plan_review' &&
    !sourceQuestion &&
    !form &&
    !state.panel &&
    !chooser &&
    !cardChooser;
  const selectedSource = sourceChoices.get(approvalKey);
  const selectedApproval = approvalChoices.get(approvalKey);
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
  }, [state.snapshot]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Leaving the presentation Session clears its explicit Source decision.
  useEffect(() => {
    setSourceChoices(new Map());
  }, [state.sessionId]);
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
      if (!questionActive || !form || !question) return;
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
    { isActive: !state.panel },
  );
  useInput((input, key) => {
    if (key.tab && key.shift) {
      lastCancelKey.current = undefined;
      controller.togglePlanning();
      return;
    }
    const majorCancel =
      !chooser &&
      !cardChooser &&
      !state.panel &&
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
    const cancelKey = (key.ctrl && input === 'c') || (!state.panel && isCtrlCBatch(input));
    if (state.panel === 'recovery') return;
    if (state.panel === 'management_requests') return;
    if (state.panel === 'executions') return;
    if (state.panel === 'mcp') return;
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
    if (state.panel) {
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
          if (controller.state.sessionId === sessionId) controller.clearDisplay();
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
    if (key.ctrl && input === 't') {
      if (card || state.panel || chooser || cardChooser) return;
      setResultDisplay({ ...resultDisplay, showReasoning: !resultDisplay.showReasoning });
      if (!resultDisplay.showReasoning) {
        const message = controller.visibleMessages
          .filter((item) => item.role === 'assistant' && item.outputBody)
          .at(-1);
        if (
          message?.outputBody &&
          message.outputBody.reasoningBytes !== '0' &&
          !state.loadedOutputBodies.has(message.id)
        )
          void controller.loadOutput(message);
      }
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
          if (!questionValue(field, draft)) return;
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
      const offered =
        card.kind === 'approval' &&
        card.request !== null &&
        typeof card.request === 'object' &&
        !Array.isArray(card.request) &&
        Array.isArray(card.request.grants) &&
        card.request.grants.includes('same_command');
      const choices = offered ? ['approve', 'approve same_command', 'deny'] : ['approve', 'deny'];
      if (card.kind === 'approval' && (key.upArrow || key.downArrow)) {
        setApprovalChoices((previous) => {
          const next = new Map(previous),
            index = previous.get(approvalKey);
          next.set(
            approvalKey,
            index === undefined
              ? 0
              : (index + (key.downArrow ? 1 : choices.length - 1)) % choices.length,
          );
          return next;
        });
        return;
      }

      if (key.escape && card.kind === 'approval') {
        void controller.answer(card, 'deny');
        return;
      }
      if (key.return && (!jsonQuestion || (!key.shift && !key.meta))) {
        const currentAnswer = answerBuffer.text;
        if (currentAnswer.trim().startsWith('/')) {
          void controller.routeCommand(currentAnswer);
          setAnswer('');
        } else
          void controller.answer(
            card,
            (sourceQuestion && selectedSource !== undefined
              ? JSON.stringify({ decision: sourceDecisions[selectedSource] })
              : currentAnswer) ||
              (card.kind === 'approval' && selectedApproval !== undefined
                ? choices[selectedApproval]!
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
      if (key.backspace || key.delete) setAnswer((t) => t.slice(0, -1));
      else if (!key.ctrl && !key.meta) setAnswer((t) => t + input);
      return;
    }
  });
  const history = (
    <TuiHistory
      controller={controller}
      card={card}
      form={form}
      step={question?.step}
      collapsed={resultDisplay.collapsed}
      showReasoning={resultDisplay.showReasoning}
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
  if (state.panel === 'mcp')
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
  const activeLine =
    !focused &&
    !state.stale &&
    ['Working', 'Cancelling', 'Waiting for required result'].includes(running)
      ? (running as 'Working' | 'Cancelling' | 'Waiting for required result')
      : undefined;
  const activeModel = state.snapshot?.view.executions
    .filter(
      (item) =>
        item.kind === 'model' &&
        item.runId === state.snapshot?.view.runs.find((run) => run.isActive)?.id &&
        ['running', 'dispatching'].includes(item.status),
    )
    .at(-1);
  const activeTiming = activeModel && state.snapshot?.executionTimings?.[activeModel.id];
  return (
    <Box flexDirection="column">
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
      {!testDiagnostics &&
        activeModel &&
        !state.snapshot?.messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.runId === activeModel.runId &&
            ((message.sourceIds ?? []).includes(activeModel.id) ||
              message.outputBody?.executionId === activeModel.id),
        ) && (
          <ToolSummaryBlock
            block={{
              id: 0,
              kind: 'tool_summary',
              tools: [],
              summaryLine: '',
              active: true,
              hasThought: false,
              hasThinking: true,
              createdAt: activeTiming?.startedAt ?? 0,
              ...(activeTiming?.availability === 'recorded_dispatch' &&
              activeTiming.startedAt !== undefined
                ? { liveModelStartedAt: activeTiming.startedAt }
                : {}),
            }}
            columns={stdout.columns || 80}
          />
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
      {card && !cardChooser && !chooser && !state.panel && (
        <Box flexDirection="column">
          {form && question && (
            <QuestionPanel
              form={form}
              draft={question}
              compactMaterial={
                testDiagnostics ||
                longQuestionMaterial(form, question.step, stdout.columns || 80, stdout.rows || 24)
              }
            />
          )}
          {card.kind === 'approval' && (
            <TuiApprovalPanel
              card={card}
              choices={
                card.request &&
                typeof card.request === 'object' &&
                !Array.isArray(card.request) &&
                Array.isArray(card.request.grants) &&
                card.request.grants.includes('same_command')
                  ? ['approve', 'approve same_command', 'deny']
                  : ['approve', 'deny']
              }
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
              {sourceQuestion && (
                <Text>
                  {t('Up/Down explicit source decision:')}{' '}
                  {selectedSource === undefined
                    ? t('none (Enter has no answer)')
                    : t(sourceDecisions[selectedSource]!)}
                </Text>
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
                ? t('Exported loaded conversation:') +
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
      {testDiagnostics && !card && !state.panel && !chooser && !cardChooser && (
        <Text dimColor>
          {tail &&
            t(
              resultDisplay.collapsed.has(executionDisplayKey(tail))
                ? 'Empty Enter expands the current tail result'
                : 'Empty Enter collapses the current tail result',
            )}
          {tail && ' · '}
          {t(
            resultDisplay.showReasoning
              ? 'Ctrl+T hides recorded reasoning'
              : 'Ctrl+T shows recorded reasoning',
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
          <Text dimColor>
            {t(state.stale ? 'Last confirmed pending inputs' : 'Pending inputs')} ·{' '}
            {state.snapshot.pendingInputs.length}
          </Text>
          {state.snapshot.pendingInputs.map((input, index) => (
            <Box key={input.id} flexDirection="column">
              <Text dimColor>
                ↵ {index + 1} ·{' '}
                {t(input.kind === 'input.steer' ? 'Guidance pending' : 'Follow-up waiting')}
                {testDiagnostics && ` [${terminalText(input.id)}]`}
              </Text>
              <Text>{terminalText(input.request.content)}</Text>
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
            const collapsed = new Set(resultDisplay.collapsed),
              key = executionDisplayKey(tail);
            if (collapsed.has(key)) collapsed.delete(key);
            else collapsed.add(key);
            setResultDisplay({ ...resultDisplay, collapsed });
          }}
        />
      </TuiFooter>
    </Box>
  );
}
