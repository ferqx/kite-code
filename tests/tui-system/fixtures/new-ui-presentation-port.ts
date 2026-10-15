import type { Command, Execution, Message, Run, SessionView } from '@kite-ai/client';
import { TuiController, type TuiPort, type TuiSnapshot } from '@kite-ai/ui/tui';
/** Synthetic display-source fixture, deliberately without any Runtime/Service or execution authority. */
export const DISPLAY_STORE = 'presentation-fixture-store';
export const DISPLAY_SESSION = 'presentation-fixture';
export function displayMessage(
  id: string,
  seq: number,
  content: string,
  extra: Partial<Message> = {},
): Message {
  return {
    id,
    seq: String(seq),
    sessionId: DISPLAY_SESSION,
    runId: null,
    role: 'assistant',
    status: 'complete',
    content,
    ...extra,
  };
}
export function displayExecution(id: string, extra: Partial<Execution> = {}): Execution {
  return {
    id,
    originStoreId: DISPLAY_STORE,
    sessionId: DISPLAY_SESSION,
    runId: 'display-run',
    kind: 'tool',
    definitionId: 'builtin.files/files.read',
    definitionVersion: '1',
    status: 'running',
    result: null,
    resultRevision: '1',
    cancelRequestedAt: null,
    parentExecutionId: null,
    childSessionId: null,
    ...extra,
  };
}
export function displayRun(active: boolean, createdAt: number): Run {
  return {
    id: 'display-run',
    sessionId: DISPLAY_SESSION,
    originStoreId: DISPLAY_STORE,
    originCommandId: 'display-origin',
    status: active ? 'running' : 'completed',
    isActive: active,
    createdAt,
    finishedAt: active ? null : Date.now(),
    reason: null,
    configuration: {
      snapshot: {
        planning: {
          binding: {
            tools: [
              {
                extensionId: 'builtin.files',
                definitionId: 'builtin.files/files.read',
                definitionVersion: '1',
              },
            ],
            readOnlyDefinitions: [
              { kind: 'tool', definitionId: 'builtin.files/files.read', definitionVersion: '1' },
            ],
          },
        },
      },
    },
  };
}
export function displayView(
  messages: Message[] = [],
  executions: Execution[] = [],
  runs: Run[] = [],
): SessionView {
  return {
    storeId: DISPLAY_STORE,
    snapshotCursor: '1',
    session: {
      id: DISPLAY_SESSION,
      workspaceId: 'display-workspace',
      parentSessionId: null,
      rootSessionId: DISPLAY_SESSION,
      title: 'Display fixture',
      controlRevision: '1',
      contextSelectionId: 'display-selection',
      nextSeq: String(messages.length + 1),
      deletedAt: null,
    },
    messages,
    executions,
    runs,
  };
}
export function displaySnapshot(
  messages: Message[],
  executions: Execution[] = [],
  runs: Run[] = [],
): TuiSnapshot {
  return {
    storeId: DISPLAY_STORE,
    view: displayView(messages, executions, runs),
    messages,
    interactions: [],
    environment: { workspacePath: process.cwd(), modelName: 'mock-model' },
  };
}
const unavailable = async (): Promise<never> => {
  throw Error('synthetic display fixture has no execution authority');
};
export function createPresentationController(
  read: () => TuiSnapshot,
  onInput?: (content: string) => Promise<void>,
) {
  let sequence = 0;
  const port: TuiPort = {
    storeId: DISPLAY_STORE,
    nextCommandId: () => `display-input-${++sequence}`,
    listSessions: async () => [],
    readSession: async () => read(),
    submit: async (sessionId, intent): Promise<Command> => {
      if (!onInput) return unavailable();
      await onInput(intent.content);
      // This only acknowledges an input delivered to the synthetic fixture. It claims no Run outcome.
      return {
        id: intent.commandId,
        sessionId,
        kind: intent.kind,
        originStoreId: DISPLAY_STORE,
        status: 'accepted',
        receipt: {},
        cancelRequestedAt: null,
      };
    },
    answer: unavailable,
    cancel: unavailable,
    getCommand: unavailable,
  };
  return new TuiController(port);
}
