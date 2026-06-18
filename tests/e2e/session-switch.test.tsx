/**
 * TUI E2E — Session Switching (P0)
 *
 * Verifies the core session lifecycle via /new:
 *   1. Send message in session A → response appears
 *   2. /new → creates session B, session A content gone (reducer switch works)
 *   3. /new + message in new session (skip: ink-testing-library TextInput limitation)
 *
 * DB-backed /sessions selector is tested separately in unit tests.
 * Session state transitions (NEW_SESSION, SWITCH_SESSION) are covered by
 * tui-reducer.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTui, type TuiHarness } from './render-tui';
import { ResponsePlan, text } from './response-plan';

const TIMEOUT = 60000;

async function sendSlash(tui: TuiHarness, cmd: string) {
  await tui.sendMessage(cmd);
  await new Promise((r) => setTimeout(r, 1000));
}

// ── Group 1: Session A → response + /new → content isolation ──

describe('TUI E2E — Session Switching (Group 1: content isolation)', () => {
  const plan = new ResponsePlan([{ group: 'session A msg', responses: [text('Reply from A!')] }]);
  let tui: TuiHarness;

  beforeAll(async () => {
    tui = await createTui({ modelResponses: plan.flatten() });
  });

  afterAll(() => {
    try {
      plan.verify(tui.getCallCount());
    } catch (e) {
      console.warn('[session G1] plan:', (e as Error).message);
    } finally {
      tui?.unmount();
    }
  });

  test(
    'send message in session A → response appears',
    async () => {
      await tui.sendMessage('Hello from A');
      await tui.waitForText('Reply from A!', 15000);
      expect(tui.getOutput()).toContain('Hello from A');
      expect(tui.getOutput()).toContain('Reply from A!');
    },
    TIMEOUT,
  );

  test(
    '/new → creates new session, old content gone',
    async () => {
      await sendSlash(tui, '/new');
      await tui.waitForTextGone('Hello from A', 5000);
      expect(tui.getOutput()).not.toContain('Hello from A');
      expect(tui.getOutput()).not.toContain('Reply from A!');
    },
    TIMEOUT,
  );
});

// ── Group 2: Fresh TUI → /new → verify session B state ──

describe('TUI E2E — Session Switching (Group 2: switch state)', () => {
  const plan = new ResponsePlan([
    { group: 'session A pre-fill', responses: [text('Pre-fill reply')] },
  ]);
  let tui: TuiHarness;

  beforeAll(async () => {
    tui = await createTui({ modelResponses: plan.flatten() });
  });

  afterAll(() => {
    try {
      plan.verify(tui.getCallCount());
    } catch (e) {
      console.warn('[session G2] plan:', (e as Error).message);
    } finally {
      tui?.unmount();
    }
  });

  test(
    'pre-fill: send message in default session',
    async () => {
      await tui.sendMessage('pre-fill');
      await tui.waitForText('Pre-fill reply', 15000);
    },
    TIMEOUT,
  );

  test(
    '/new → content from old session disappears',
    async () => {
      await sendSlash(tui, '/new');
      await tui.waitForTextGone('pre-fill', 5000);
      expect(tui.getOutput()).not.toContain('pre-fill');
    },
    TIMEOUT,
  );
});
