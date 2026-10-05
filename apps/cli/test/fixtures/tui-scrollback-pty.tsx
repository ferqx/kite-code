import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionView } from '@kite-ai/client';
import { TuiController, type TuiPort, TuiSession, type TuiSnapshot } from '@kite-ai/ui/tui';
import { render } from 'ink';

// This fixture supplies a finite UI port; it does not qualify Service or Model execution.
const root = process.argv[2]!;
let rounds = 1;
let changedVersion = 0;
let mutationCalls = 0;
const snapshot = (sessionId: string): TuiSnapshot => ({
  storeId: 'owned-render-store',
  view: {
    storeId: 'owned-render-store',
    snapshotCursor: String(rounds),
    session: {
      id: sessionId,
      workspaceId: 'owned-render-workspace',
      parentSessionId: null,
      rootSessionId: sessionId,
      title: sessionId,
      controlRevision: '0',
      contextSelectionId: 'selection',
      nextSeq: '99',
      deletedAt: null,
    },
    runs: [],
    executions: [],
    messages: [],
  } as SessionView,
  messages: Array.from({ length: rounds }, (_, round) => ({
    id: `${sessionId}-message-${round + 1}`,
    sessionId,
    runId: null,
    seq: String(round + 1),
    status: 'complete',
    role: 'assistant',
    content:
      Array.from(
        { length: 30 },
        (_, line) =>
          `ROUND_${round + 1}_LINE_${String(line + 1).padStart(2, '0')} ${'bounded wrapped complete body '.repeat(6)}`,
      ).join('\n\n') +
      (changedVersion && round === 2 ? `\n\nSEMANTIC_CHANGED_BODY_${changedVersion}` : ''),
  })),
  interactions: [],
});
const forbidden = async () => {
  mutationCalls++;
  throw new Error('renderer fixture must not submit or query work');
};
const port: TuiPort = {
  storeId: 'owned-render-store',
  nextCommandId: () => 'unused',
  listSessions: async () => [
    { id: 'a', title: 'a' },
    { id: 'b', title: 'b' },
  ],
  readSession: async (sessionId) => snapshot(sessionId),
  submit: forbidden,
  answer: forbidden,
  cancel: forbidden,
  getCommand: forbidden,
};
const controller = new TuiController(port);
await controller.select('a');
const app = render(<TuiSession controller={controller} />, {
  patchConsole: false,
  exitOnCtrlC: false,
});
let busy = false;
let lastToken = -1;
let finished = false;
let timer: ReturnType<typeof setInterval>;
const ack = (token: number) =>
  writeFileSync(
    join(root, 'ack.json'),
    JSON.stringify({
      token,
      sessionId: controller.state.sessionId,
      storedMessages: controller.state.snapshot?.messages.length,
      visibleMessages: controller.visibleMessages.length,
      mutationCalls,
    }),
  );
function finish(exitCode: number, normalComplete: boolean, error?: string) {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  app.unmount();
  app.cleanup();
  controller.dispose();
  writeFileSync(
    join(root, 'host-exit.json'),
    JSON.stringify({ pid: process.pid, exitCode, normalComplete, mutationCalls, error }),
  );
  process.exit(exitCode);
}
timer = setInterval(async () => {
  if (busy || !existsSync(join(root, 'control.json'))) return;
  busy = true;
  try {
    const control = JSON.parse(readFileSync(join(root, 'control.json'), 'utf8')) as {
      token: number;
      action: string;
    };
    if (control.token === lastToken) return;
    lastToken = control.token;
    if (control.action === 'round2' || control.action === 'round3') {
      rounds = control.action === 'round2' ? 2 : 3;
      await controller.select('a');
    } else if (control.action === 'status') {
      controller.observationUnavailable('bounded-probe');
    } else if (control.action === 'clear') {
      controller.clearDisplay();
    } else if (control.action === 'refresh') {
      await controller.select('a');
    } else if (control.action === 'changed') {
      changedVersion++;
      await controller.select('a');
    } else if (control.action === 'session-b' || control.action === 'session-a') {
      await controller.select(control.action === 'session-b' ? 'b' : 'a');
    } else if (control.action === 'stop') {
      ack(control.token);
      finish(0, true);
    } else {
      throw new Error('unknown owned fixture control');
    }
    await Bun.sleep(150);
    ack(control.token);
  } catch (error) {
    finish(1, false, error instanceof Error ? error.message : String(error));
  } finally {
    busy = false;
  }
}, 10);
setTimeout(() => ack(0), 200);
process.once('SIGTERM', () => finish(1, false, 'owned fixture terminated before normal stop'));
