import type { Interaction, Message, SessionView } from '@kite-ai/client';
import { Box, Static, useInput, usePaste, useStdout } from 'ink';
import {
  useCallback,
  useEffect,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { interactionKey } from './cards';
import { ComposerBuffer } from './composer';
import { TuiComposer } from './composer-input';
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
import { QuestionPanel } from './question-panel';
import { TuiRecoveryPanel } from './recovery-panel';
import { TuiSkillsPanel } from './skills-panel';
import { TuiStatusPanel } from './status-panel';

export * from './controller';
export { TerminalMarkdown } from './markdown';
export * from './mcp-auth';
export * from './mcp-connection';
export * from './mcp-reconnection';
export * from './mcp-source';
export * from './mcp-source-mutation';

/** Independent Ink renderer. Host owns admission, full readers and Service lifetime. */
export function TuiSession({ controller }: { controller: TuiController }) {
  const state = useSyncExternalStore(controller.subscribe, () => controller.state);
  return (
    <TuiPresentationProvider value={{ preferences: state.preferences }}>
      <TuiHistory controller={controller} />
      <TuiSessionView controller={controller} />
    </TuiPresentationProvider>
  );
}
type Execution = SessionView['executions'][number];
const endedExecution = (execution: Execution) =>
  ['succeeded', 'failed', 'cancelled'].includes(execution.status);
const settledMessage = (message: Message, runs: SessionView['runs'] | undefined) =>
  message.status === 'complete' || !runs?.some((run) => run.id === message.runId && run.isActive);
const prefixLength = <T,>(items: readonly T[], settled: (item: T) => boolean) => {
  const index = items.findIndex((item) => !settled(item));
  return index < 0 ? items.length : index;
};
type HistoryItem =
  | { key: string; version: string; message: Message }
  | { key: string; version: string; execution: Execution };

/** Ink owns the emitted bytes; these are only the current immutable render items. */
function TuiHistory({ controller }: { controller: TuiController }) {
  const state = useSyncExternalStore(controller.subscribe, () => controller.state);
  const { stdout, write } = useStdout();
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
    const messageCount = prefixLength(messages, (message) =>
      settledMessage(message, state.snapshot?.view.runs),
    );
    const results = executions.filter((execution) => execution.kind !== 'model');
    const executionCount =
      messageCount === messages.length ? prefixLength(results, endedExecution) : 0;
    return [
      ...messages.slice(0, messageCount).map((message) => ({
        key: `message:${message.id}`,
        version: JSON.stringify([
          message.seq,
          message.role,
          message.status,
          message.content,
          message.contentFormat,
          message.outputBody,
          state.fullOutputs.get(message.id),
        ]),
        message,
      })),
      ...results.slice(0, executionCount).map((execution) => ({
        key: `execution:${execution.id}`,
        version: JSON.stringify([
          execution.definitionId,
          execution.status,
          execution.resultRevision,
          execution.result,
        ]),
        execution,
      })),
    ];
  }, [messages, executions, state.fullOutputs, state.snapshot?.view.runs]);
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
      {(item) =>
        'message' in item ? (
          <TuiMessage key={item.key} message={item.message} controller={controller} />
        ) : (
          <TuiExecution key={item.key} execution={item.execution} />
        )
      }
    </Static>
  );
}
function TuiMessage({ message, controller }: { message: Message; controller: TuiController }) {
  const { t } = useTuiPresentation();
  const state = controller.state;
  return (
    <Box flexDirection="column">
      <Text bold>
        {message.role} {'['}
        {terminalText(message.id)}
        {']'} {message.status}
      </Text>
      <TerminalMarkdown content={state.fullOutputs.get(message.id) ?? message.content} />
      {message.outputBody && !state.fullOutputs.has(message.id) && (
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
function TuiExecution({ execution }: { execution: Execution }) {
  return (
    <Box flexDirection="column">
      <Text>
        {terminalText(execution.definitionId)} {'['}
        {terminalText(execution.id)}
        {']'} {execution.status}
      </Text>
      <Text>{terminalText(JSON.stringify(execution.result, null, 2))}</Text>
    </Box>
  );
}

function TuiSessionView({ controller }: { controller: TuiController }) {
  const fileQuery = useCallback(
    (token?: FileToken) => {
      void controller.readFileCandidates(token);
    },
    [controller],
  );
  const { t } = useTuiPresentation();
  const state = useSyncExternalStore(controller.subscribe, () => controller.state);
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
  const [selected, setSelected] = useState(0);
  const [cardChooser, setCardChooser] = useState(false);
  const [cardIndex, setCardIndex] = useState(0);
  const [cardOptions, setCardOptions] = useState<readonly Interaction[]>([]);
  const [selectedCard, setSelectedCard] = useState<string>();
  const [cardDrafts, setCardDrafts] = useState(new Map<string, string>());
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
  const answer = cardDrafts.get(approvalKey) ?? '';
  const sourceQuestion = card && isMcpSourceQuestion(card);
  const form =
    card?.kind === 'question' && !sourceQuestion ? questionForm(card.request) : undefined;
  let question = questionDrafts.current.get(approvalKey);
  if (form && !question) {
    question = questionDraft(form);
    questionDrafts.current.set(approvalKey, question);
  }
  const questionActive = !!form && !!question && !state.panel && !chooser && !cardChooser;
  const selectedSource = sourceChoices.get(approvalKey);
  const selectedApproval = approvalChoices.get(approvalKey);
  const setAnswer = (value: string | ((previous: string) => string)) =>
    setCardDrafts((previous) => {
      const next = new Map(previous);
      next.set(
        approvalKey,
        typeof value === 'function' ? value(previous.get(approvalKey) ?? '') : value,
      );
      return next;
    });
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
    setCardDrafts((previous) => new Map([...previous].filter(([key]) => !obsolete(key))));
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
      if (!questionActive || !form || !question) return;
      const field = form.fields[question.step]!,
        draft = question.fields[question.step]!;
      if (field.text && (!field.choices.length || draft.selected === field.choices.length)) {
        draft.buffer.insert(text, true);
        draft.skipped = false;
        renderQuestion((n) => n + 1);
      }
    },
    { isActive: questionActive },
  );
  useInput((input, key) => {
    if (state.panel === 'recovery') return;
    if (state.panel === 'executions') return;
    if (state.panel === 'mcp') return;
    if (state.panel === 'skills' || state.panel === 'theme' || state.panel === 'language') return;
    if (state.panel === 'status') {
      if (key.escape || (key.ctrl && input === 'c')) controller.closePanel();
      else if (input.toLowerCase() === 'r') void controller.openStatus();
      return;
    }
    if (key.ctrl && input === 'c') {
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
    if (chooser) {
      if (key.escape) setChooser(false);
      else if (key.upArrow) setSelected((n) => Math.max(0, n - 1));
      else if (key.downArrow) setSelected((n) => Math.min(state.sessions.length - 1, n + 1));
      else if (key.return && state.sessions[selected]) {
        void controller.select(state.sessions[selected]!.id);
        setChooser(false);
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
    if (key.ctrl && input === 'a' && card) {
      void controller.loadAttachment(card);
      return;
    }
    if (card) {
      if (form && question) {
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
          if (key.leftArrow) draft.buffer.horizontal(-1);
          else if (key.rightArrow) draft.buffer.horizontal(1);
          else if (key.home) draft.buffer.boundary(false, 72);
          else if (key.end) draft.buffer.boundary(true, 72);
          else if (key.upArrow) draft.buffer.vertical(-1, 72);
          else if (key.downArrow) draft.buffer.vertical(1, 72);
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
      if (key.return) {
        if (answer.trim().startsWith('/')) {
          void controller.routeCommand(answer);
          setAnswer('');
        } else
          void controller.answer(
            card,
            (sourceQuestion && selectedSource !== undefined
              ? JSON.stringify({ decision: sourceDecisions[selectedSource] })
              : answer) ||
              (card.kind === 'approval' && selectedApproval !== undefined
                ? choices[selectedApproval]!
                : ''),
          );
        return;
      }
      if (key.backspace || key.delete) setAnswer((t) => t.slice(0, -1));
      else if (!key.ctrl && !key.meta) setAnswer((t) => t + input);
      return;
    }
  });
  const messages = controller.visibleMessages;
  const executions = controller.visibleExecutions.filter((execution) => execution.kind !== 'model');
  const messageCount = prefixLength(messages, (message) =>
    settledMessage(message, state.snapshot?.view.runs),
  );
  const executionCount =
    messageCount === messages.length ? prefixLength(executions, endedExecution) : 0;
  if (state.panel === 'executions') return <TuiExecutionPanel controller={controller} />;
  if (state.panel === 'mcp') return <TuiMcpPanel key={state.sessionId} controller={controller} />;
  if (state.panel === 'theme' || state.panel === 'language')
    return <TuiPreferencePanel key={state.panel} controller={controller} />;
  if (state.panel === 'status') return <TuiStatusPanel controller={controller} />;
  if (state.panel === 'recovery')
    return <TuiRecoveryPanel key={state.sessionId} controller={controller} />;
  if (state.panel === 'skills')
    return <TuiSkillsPanel key={state.sessionId} controller={controller} />;
  return (
    <Box flexDirection="column">
      <Text bold>
        {t('Session')} {terminalText(state.sessionId ?? t('not selected'))} {'·'}{' '}
        {t(activity(state.snapshot))}
        {state.loading ? t(' · Loading') : ''}
        {state.stale ? t(' · Stale') : ''}
      </Text>
      {(state.panel === 'models' || state.panel === 'effort') && (
        <TuiModelPanel key={state.sessionId} controller={controller} />
      )}
      {state.panel === 'permissions' && (
        <TuiPermissionPanel key={state.sessionId} controller={controller} />
      )}
      {chooser && (
        <Box flexDirection="column">
          <Text>{t('Select Session (arrows/Enter, Esc)')}</Text>
          {state.sessions.map((session, index) => (
            <Text key={session.id}>
              {index === selected ? '> ' : '  '}
              {terminalText(session.title)} {'['}
              {terminalText(session.id)}
              {']'}
            </Text>
          ))}
        </Box>
      )}
      {messages.slice(messageCount).map((message) => (
        <TuiMessage key={message.id} message={message} controller={controller} />
      ))}
      {executions.slice(executionCount).map((execution) => (
        <TuiExecution key={execution.id} execution={execution} />
      ))}
      {cardChooser && (
        <Box flexDirection="column">
          <Text bold>
            Pending cards · {cardOptions.length} · Up/Down, Enter selects original card, Esc closes
          </Text>
          {cardOptions.slice(Math.max(0, cardIndex - 2), cardIndex + 3).map((item) => (
            <Text key={interactionKey(item)}>
              {cardOptions[cardIndex] === item ? '› ' : '  '}
              {item.kind} [{terminalText(item.id)}] original Session {terminalText(item.sessionId)}{' '}
              · Store {terminalText(item.originStoreId)} · revision {item.revision}
              {cards.some((current) => interactionKey(current) === interactionKey(item))
                ? ''
                : ' · changed; reopen to select'}
            </Text>
          ))}
        </Box>
      )}
      {card && !cardChooser && (
        <Box flexDirection="column">
          <Text bold>
            {card.kind} {'['}
            {terminalText(card.id)}
            {t('] original Session')} {terminalText(card.sessionId)} {t('· revision')}{' '}
            {card.revision}
          </Text>
          {form &&
            Object.entries(card.request as Record<string, unknown>)
              .filter(
                ([key, value]) =>
                  ['title', 'question', 'description'].includes(key) && typeof value === 'string',
              )
              .map(([key, value]) => <Text key={key}>{terminalText(String(value))}</Text>)}
          {form && question ? (
            <QuestionPanel form={form} draft={question} />
          ) : (
            <Text>{terminalText(JSON.stringify(card.request, null, 2))}</Text>
          )}
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
          {state.attachments.get(approvalKey) && (
            <Text>{terminalText(state.attachments.get(approvalKey)!)}</Text>
          )}
          {form && (
            <Text>
              {t(
                'Ctrl+A: read required attachment. Question: choose or enter the original-schema answer above.',
              )}
            </Text>
          )}
          {!form && (
            <Text>
              {t(
                'Ctrl+A: read required attachment. Approval: approve (once), approve same_command only if offered, deny. Question: original-schema JSON. Plan: approve offered mode / revise feedback / deny.',
              )}
            </Text>
          )}
          {!form && <Text>{terminalText(answer)}</Text>}
        </Box>
      )}
      {state.panel === 'rewind' && (
        <Box flexDirection="column">
          <Text>
            Files recovery: arrows/Enter preview; 1 session only, 2 code only, 3 both; Enter
            confirms selected scope. R reloads readonly directory. Esc closes.
          </Text>
          {state.fileRecovery?.points?.payload.items.map((item, i) => (
            <Text key={item.checkpoint.id}>
              {panelIndex === i ? '› ' : ''}
              {item.checkpoint.id} original {item.checkpoint.boundary.sessionId} trigger{' '}
              {item.checkpoint.boundary.triggerSeq}
            </Text>
          ))}
          {state.fileRecovery?.detail && (
            <Text>{terminalText(JSON.stringify(state.fileRecovery.detail.preview.payload))}</Text>
          )}
          {state.fileRecovery?.scopeChoice && (
            <Text>Confirm {state.fileRecovery.scopeChoice} with Enter</Text>
          )}
          {state.fileRecovery?.intent && (
            <Text>
              {terminalText(JSON.stringify(state.fileRecovery.intent))} A: pending approval panel;
              R: original GET; C: explicitly continue untouched leg
            </Text>
          )}
          {state.fileRecovery?.saved?.map((intent, i) => (
            <Text key={intent.code?.request.commandId ?? intent.fork!.request.commandId}>
              Saved {i + 1}: {intent.scope} code {intent.code?.phase ?? '-'} fork{' '}
              {intent.fork?.phase ?? '-'}; L queries selected original intent
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
        onTogglePlan={() => controller.togglePlanning()}
      />
    </Box>
  );
}
