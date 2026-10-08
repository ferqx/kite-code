import type { Interaction, Message, SessionView } from '@kite-ai/client';
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
import { interactionKey } from './cards';
import { ComposerBuffer, composerDisplay } from './composer';
import { isCtrlCBatch, TuiComposer } from './composer-input';
import { activity, type TuiController, terminalText } from './controller';
import { TuiExecutionPanel } from './execution-panel';
import type { FileToken } from './file-candidates';
import { TerminalMarkdown } from './markdown';
import { TuiMcpPanel } from './mcp-panel';
import { isMcpSourceQuestion, sourceDecisions } from './mcp-source-question';
import { TuiModelPanel } from './model-panel';
import { TuiPermissionPanel } from './permission-panel';
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
import { TuiSessionChooser } from './session-chooser';
import { TuiSkillsPanel } from './skills-panel';
import { TuiStatusPanel } from './status-panel';

export * from './controller';
export { TerminalMarkdown } from './markdown';
export * from './mcp-auth';
export * from './mcp-connection';
export * from './mcp-reconnection';
export * from './mcp-source';
export * from './mcp-source-mutation';
export { translateTuiLabel } from './presentation';

/** Independent Ink renderer. Host owns admission, full readers and Service lifetime. */
export function TuiSession({ controller }: { controller: TuiController }) {
  const state = useSyncExternalStore(controller.subscribe, () => controller.state);
  return (
    <TuiPresentationProvider value={{ preferences: state.preferences }}>
      <TuiSessionView controller={controller} />
    </TuiPresentationProvider>
  );
}
type Execution = SessionView['executions'][number];
type HistoryItem = { key: string; version: string; node: ReactNode };
const executionDisplayKey = (execution: Execution) =>
  JSON.stringify([execution.originStoreId, execution.sessionId, execution.id]);

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
  const { t } = useTuiPresentation();
  const scope = JSON.stringify([
    state.snapshot?.storeId,
    state.snapshot?.view.session.workspaceId,
    state.sessionId,
    state.preferences.resolvedLanguage,
    state.preferences.theme,
    state.preferences.colorPreset,
  ]);
  const messages = controller.visibleMessages;
  const executions = controller.visibleExecutions;
  const items: HistoryItem[] = useMemo(() => {
    const results = executions.filter((execution) => execution.kind !== 'model');
    return [
      ...messages.map((message) => ({
        key: `message:${message.id}`,
        version: JSON.stringify([
          message.seq,
          message.role,
          message.status,
          message.content,
          message.contentFormat,
          message.outputBody,
          state.fullOutputs.get(message.id),
          showReasoning,
          state.loadedOutputBodies.get(message.id)?.reasoning,
        ]),
        node: (
          <TuiMessage
            message={message}
            controller={controller}
            fullOutput={state.fullOutputs.get(message.id)}
            reasoning={state.loadedOutputBodies.get(message.id)?.reasoning}
            showReasoning={showReasoning}
          />
        ),
      })),
      ...results.map((execution) => ({
        key: `execution:${execution.id}`,
        version: JSON.stringify([
          execution.definitionId,
          execution.status,
          execution.resultRevision,
          execution.result,
          collapsed.has(executionDisplayKey(execution)),
        ]),
        node: (
          <TuiExecution
            execution={execution}
            collapsed={collapsed.has(executionDisplayKey(execution))}
          />
        ),
      })),
      ...(card
        ? [
            {
              key: `card:${interactionKey(card)}`,
              version: JSON.stringify([
                card,
                form,
                step,
                state.attachments.get(interactionKey(card)),
              ]),
              node: (
                <Box flexDirection="column">
                  <Text bold>
                    {card.kind} [{terminalText(card.id)}
                    {t('] original Session')} {terminalText(card.sessionId)} {t('· revision')}{' '}
                    {card.revision}
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
                  ) : (
                    <Text>{terminalText(JSON.stringify(card.request, null, 2))}</Text>
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
    state.loadedOutputBodies,
    state.attachments,
    card,
    form,
    step,
    controller,
    t,
    collapsed,
    showReasoning,
  ]);
  const [committed, setCommitted] = useState({ scope, items, epoch: 0 });
  const replace =
    committed.scope !== scope ||
    committed.items.some(
      (item, index) => items[index]?.key !== item.key || items[index]?.version !== item.version,
    );
  let history = committed;
  if (replace) {
    history = { scope, items, epoch: committed.epoch + 1 };
    setCommitted(history);
  } else if (items.length !== committed.items.length) {
    history = { ...committed, items };
    setCommitted(history);
  }
  // A semantic replacement must erase the old prefix before Ink emits the new
  // Static instance. Ordinary state/input updates keep that instance untouched.
  // Ink's Static identity hook also resets its replay buffer for future reflows.
  // Use Ink's writer to restore an unchanged live footer after the erase.
  useInsertionEffect(() => {
    if (history.epoch && stdout.isTTY) write('\u001b[2J\u001b[3J\u001b[H');
  }, [history.epoch, stdout, write]);
  return (
    <Static key={history.epoch} items={history.items}>
      {(item) => (
        <Box key={item.key} flexDirection="column">
          {item.node}
        </Box>
      )}
    </Static>
  );
}
function TuiMessage({
  message,
  controller,
  fullOutput,
  reasoning,
  showReasoning,
}: {
  message: Message;
  controller: TuiController;
  fullOutput?: string;
  reasoning?: string;
  showReasoning: boolean;
}) {
  const { t } = useTuiPresentation();
  return (
    <Box flexDirection="column">
      <Text bold>
        {message.role} {'['}
        {terminalText(message.id)}
        {']'} {message.status}
      </Text>
      {showReasoning && message.role === 'assistant' && message.outputBody && (
        <Box flexDirection="column">
          <Text dimColor>
            {t('Recorded reasoning')} ·{' '}
            {message.outputBody.complete ? t('complete') : t('incomplete prefix')}
          </Text>
          {reasoning === undefined ? (
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
          ) : reasoning.length === 0 ? (
            <Text dimColor>{t('Recorded reasoning is empty')}</Text>
          ) : (
            <TerminalMarkdown content={reasoning} />
          )}
        </Box>
      )}
      <TerminalMarkdown content={fullOutput ?? message.content} />
      {message.outputBody && fullOutput === undefined && (
        <Text>
          {t('Recorded Model output preview only;')}{' '}
          {message.outputBody.readAvailability === 'unsupported' ||
          message.contentFormat === 'unsupported'
            ? t('full read unsupported')
            : controller.port.readModelOutput
              ? t('Ctrl+O reads verified full body')
              : t('full reader unavailable')}{' '}
          {'('}
          {message.outputBody.contentBytes} {t('bytes,')}{' '}
          {message.outputBody.complete ? t('complete') : t('incomplete prefix')}
          {').'}
        </Text>
      )}
    </Box>
  );
}
function TuiExecution({ execution, collapsed }: { execution: Execution; collapsed: boolean }) {
  const { t } = useTuiPresentation();
  return (
    <Box flexDirection="column">
      <Text>
        {terminalText(execution.definitionId)} {'['}
        {terminalText(execution.id)}
        {']'} {execution.status}
      </Text>
      {collapsed ? (
        <Text dimColor>{t('Result collapsed')}</Text>
      ) : (
        <Text>{terminalText(JSON.stringify(execution.result, null, 2))}</Text>
      )}
    </Box>
  );
}

function TuiSessionView({ controller }: { controller: TuiController }) {
  const { stdout } = useStdout();
  const fileQuery = useCallback(
    (token?: FileToken) => {
      void controller.readFileCandidates(token);
    },
    [controller],
  );
  const { t } = useTuiPresentation();
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
    !!card && !sourceQuestion && !form && !state.panel && !chooser && !cardChooser;
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
    if (chooser) return;
    const cancelKey = (key.ctrl && input === 'c') || (!state.panel && isCtrlCBatch(input));
    if (state.panel === 'recovery') return;
    if (state.panel === 'executions') return;
    if (state.panel === 'mcp') return;
    if (state.panel === 'skills' || state.panel === 'theme' || state.panel === 'language') return;
    if (state.panel === 'status') {
      if (key.escape || cancelKey) controller.closePanel();
      else if (input.toLowerCase() === 'r') void controller.openStatus();
      return;
    }
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
    if (state.panel === 'rewind') {
      const files = state.fileRecovery,
        items = files?.points?.payload.items ?? [];
      if (key.escape) controller.closePanel();
      else if (key.upArrow) setPanelIndex((i) => Math.max(0, i - 1));
      else if (key.downArrow)
        setPanelIndex((i) =>
          Math.min(Math.max(0, Math.max(items.length, files?.saved?.length ?? 0) - 1), i + 1),
        );
      else if (input === '1') controller.chooseFileRecoveryScope('session');
      else if (input === '2') controller.chooseFileRecoveryScope('code');
      else if (input === '3') controller.chooseFileRecoveryScope('both');
      else if (input.toLowerCase() === 'a') controller.closePanel();
      else if (input.toLowerCase() === 'r') {
        if (files?.intent) void controller.observeFileRecovery();
        else void controller.openFileRecovery();
      } else if (input.toLowerCase() === 'c') void controller.observeFileRecovery(true);
      else if (input.toLowerCase() === 'l') {
        controller.selectSavedFileRecovery(panelIndex);
        void controller.observeFileRecovery();
      } else if (key.return && files?.scopeChoice)
        void controller.startFileRecovery(files.scopeChoice);
      else if (key.return && items[panelIndex])
        void controller.readFileRecoveryPoint(items[panelIndex]!.checkpoint.id);
      return;
    }
    if (state.panel) {
      const items = state.snapshot?.view.executions.filter((e) => e.resultRevision !== null);
      if (key.escape) controller.closePanel();
      else if (key.upArrow) setPanelIndex((i) => Math.max(0, i - 1));
      else if (key.downArrow)
        setPanelIndex((i) => Math.min(Math.max(0, (items?.length ?? 0) - 1), i + 1));
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
    if (card) {
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
        if (key.ctrl || (key.meta && !key.return)) return;
        if (key.escape) question.step = Math.max(0, question.step - 1);
        else if (key.tab && !field.required) {
          draft.skipped = !draft.skipped;
        } else if (field.choices.length && (key.upArrow || key.downArrow)) {
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
    return withHistory(<TuiExecutionPanel controller={controller} />);
  if (state.panel === 'mcp')
    return withHistory(<TuiMcpPanel key={state.sessionId} controller={controller} />);
  if (state.panel === 'theme' || state.panel === 'language')
    return withHistory(<TuiPreferencePanel key={state.panel} controller={controller} />);
  if (state.panel === 'status') return withHistory(<TuiStatusPanel controller={controller} />);
  if (state.panel === 'recovery')
    return withHistory(<TuiRecoveryPanel key={state.sessionId} controller={controller} />);
  if (state.panel === 'skills')
    return withHistory(<TuiSkillsPanel key={state.sessionId} controller={controller} />);
  return (
    <Box flexDirection="column">
      {history}
      <Text bold>
        {t('Session')} {terminalText(state.sessionId ?? t('not selected'))} {'·'}{' '}
        {t(activity(state.snapshot))}
        {state.loading ? t(' · Loading') : ''}
        {state.stale ? t(' · Stale') : ''}
      </Text>
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
        <Box flexDirection="column">
          <Text bold>
            {t('Pending cards ·')} {cardOptions.length}{' '}
            {t('· Up/Down, Enter selects original card, Esc closes')}
          </Text>
          {cardOptions.slice(Math.max(0, cardIndex - 2), cardIndex + 3).map((item) => (
            <Text key={interactionKey(item)}>
              {cardOptions[cardIndex] === item ? '› ' : '  '}
              {item.kind} [{terminalText(item.id)}
              {t('] original Session')} {terminalText(item.sessionId)} · Store{' '}
              {terminalText(item.originStoreId)} {t('· revision')} {item.revision}
              {cards.some((current) => interactionKey(current) === interactionKey(item))
                ? ''
                : t(' · changed; reopen to select')}
            </Text>
          ))}
        </Box>
      )}
      {card && !cardChooser && (
        <Box flexDirection="column">
          {form && question && <QuestionPanel form={form} draft={question} />}
          {card.kind === 'approval' && (
            <Text>
              {t('Up/Down explicit approval selection:')}{' '}
              {selectedApproval === undefined
                ? t('none (Enter has no answer)')
                : selectedApproval === 0
                  ? t('only this call')
                  : selectedApproval === 1 &&
                      card.request !== null &&
                      typeof card.request === 'object' &&
                      !Array.isArray(card.request) &&
                      Array.isArray(card.request.grants) &&
                      card.request.grants.includes('same_command')
                    ? t('same command in original Session')
                    : t('deny')}
            </Text>
          )}

          {sourceQuestion && (
            <Text>
              {t('Up/Down explicit source decision:')}{' '}
              {selectedSource === undefined
                ? t('none (Enter has no answer)')
                : t(sourceDecisions[selectedSource]!)}
            </Text>
          )}
          {form && (
            <Text>
              {t(
                'Ctrl+A: read required attachment. Question: choose or enter the original-schema answer above.',
              )}
            </Text>
          )}
          {jsonQuestion && (
            <>
              <Text>{t('Ctrl+A: read required attachment. Question: original-schema JSON.')}</Text>
              <TuiAnswerInput buffer={answerBuffer} />
              <Text>{t('Arrows/Home/End: edit JSON · Enter: submit · Shift+Enter: newline')}</Text>
            </>
          )}
          {!form && !jsonQuestion && (
            <Text>
              {t(
                'Ctrl+A: read required attachment. Approval: approve (once), approve same_command only if offered, deny. Question: original-schema JSON. Plan: approve offered mode / revise feedback / deny.',
              )}
            </Text>
          )}
          {!form && !jsonQuestion && <Text>{terminalText(answer)}</Text>}
        </Box>
      )}
      {state.panel === 'rewind' && (
        <Box flexDirection="column">
          <Text>
            {t(
              'Files recovery: arrows/Enter preview; 1 session only, 2 code only, 3 both; Enter confirms selected scope. R reloads readonly directory. Esc closes.',
            )}
          </Text>
          {state.fileRecovery?.points?.payload.items.map((item, i) => (
            <Text key={item.checkpoint.id}>
              {panelIndex === i ? '› ' : ''}
              {item.checkpoint.id} {t('original')} {item.checkpoint.boundary.sessionId}{' '}
              {t('trigger')} {item.checkpoint.boundary.triggerSeq}
            </Text>
          ))}
          {state.fileRecovery?.detail && (
            <Text>{terminalText(JSON.stringify(state.fileRecovery.detail.preview.payload))}</Text>
          )}
          {state.fileRecovery?.scopeChoice && (
            <Text>
              {t('Confirm')} {state.fileRecovery.scopeChoice} {t('with Enter')}
            </Text>
          )}
          {state.fileRecovery?.intent && (
            <Text>
              {terminalText(JSON.stringify(state.fileRecovery.intent))}{' '}
              {t(
                'A: pending approval panel; R: original GET; C: explicitly continue untouched leg',
              )}
            </Text>
          )}
          {state.fileRecovery?.saved?.map((intent, i) => (
            <Text key={intent.code?.request.commandId ?? intent.fork!.request.commandId}>
              {t('Saved')} {i + 1}: {intent.scope} {t('code')} {intent.code?.phase ?? '-'}{' '}
              {t('fork')} {intent.fork?.phase ?? '-'}
              {t('; L queries selected original intent')}
            </Text>
          ))}
        </Box>
      )}
      {state.panel === 'context' && (
        <Box flexDirection="column">
          <Text>
            {t('Current selected Context projection, not actual Model input Inspector; Esc close')}
          </Text>
          {state.context ? (
            <>
              <Text>
                {t('Selection')} {terminalText(state.context.selection.id)} {t('/ frozen upper')}{' '}
                {state.context.highWaterSeq}
              </Text>
              {state.context.messages.map((message) => (
                <Text key={message.id}>
                  {message.seq} {'['}
                  {terminalText(message.id)}
                  {']'} {terminalText(message.content)}
                </Text>
              ))}
              {state.context.resultSources.map((source) => (
                <Text key={source.id}>
                  {t('Source')} {terminalText(source.id)} {'['}
                  {terminalText(source.executionId)}
                  {']'} {terminalText(JSON.stringify(source.result))}
                </Text>
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
                .map((e, i) => (
                  <Text key={e.id}>
                    {panelIndex === i ? '› ' : ''}
                    {terminalText(e.id)} {t('revision')}{' '}
                    {terminalText(e.resultRevision ?? t('unavailable'))} {'/'} {e.status}
                  </Text>
                ))}
              <Text>
                {t('Target Run')}{' '}
                {terminalText(state.snapshot?.view.runs.find((r) => r.isActive)?.id ?? 'idle')}
              </Text>
            </>
          )}
        </Box>
      )}
      {state.notice && (
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
      {state.management && (
        <Text>
          {t('Original management')} {terminalText(state.management.intent.sessionId)} {'/'}{' '}
          {terminalText(state.management.intent.request.commandId)} {state.management.intent.kind}
          {':'} {state.management.status}{' '}
          {state.management.status === 'delete_requested'
            ? t('(stop unconfirmed; files unchanged)')
            : state.management.status === 'accepted' || state.management.status === 'queued'
              ? t('(receipt queued, not completed)')
              : ''}
          {state.management.omittedExtensionState ? t(' · Fork omitted extension state') : ''}
        </Text>
      )}
      {state.intent && (
        <Text>
          {t('Original')} {terminalText(state.intent.sessionId)} {'/'}{' '}
          {terminalText(state.intent.commandId)} {terminalText(state.intent.kind)}
          {':'} {state.intent.phase} {t('(receipt is not dispatch success)')}
        </Text>
      )}
      {state.error && (
        <Text color="red">
          {t('Error:')} {terminalText(state.error)}
        </Text>
      )}
      <Text>
        {t(
          'Ctrl+B pending cards · Ctrl+R sessions · Ctrl+L refresh · Ctrl+O full output · Ctrl+C cancels exact original Command',
        )}
      </Text>
      {!card && !state.panel && !chooser && !cardChooser && (
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
      <TuiComposer
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
        onTogglePlan={() => controller.togglePlanning()}
      />
    </Box>
  );
}
