import { expect, test } from 'bun:test';
import type { SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import {
  activity,
  currentActivityVerified,
  TuiController,
  type TuiPort,
  TuiSession,
  type TuiSnapshot,
} from '../../src/tui';
import { TuiActivityLine, TuiRecordedPhaseTime } from '../../src/tui/chrome';
import { activityDot } from '../../src/tui/ink/activity-dot';
import ToolSummaryBlock from '../../src/tui/ink/ToolSummaryBlock';
import { defaultTuiPreferences } from '../../src/tui/preferences';
import { TuiPresentationProvider } from '../../src/tui/presentation';

function snapshot(
  connectionInstanceId?: string,
  ownerInstanceId: string | null = 'owner-a',
): TuiSnapshot {
  return {
    storeId: 'store',
    ...(connectionInstanceId ? { connectionInstanceId } : {}),
    activityOwner: { instanceId: ownerInstanceId, generation: '1' },
    view: {
      storeId: 'store',
      session: { id: 's', workspaceId: 'w', ownerInstanceId },
      runs: [
        { id: 'run', sessionId: 's', originStoreId: 'store', isActive: true, status: 'running' },
      ],
      executions: [],
    } as unknown as SessionView,
    messages: [],
    interactions: [],
  };
}

test('connected owner verifies live activity; another owner remains an unverified persisted run', () => {
  const own = snapshot('owner-a');
  expect(currentActivityVerified(own)).toBe(true);
  expect(activity(own)).toBe('Working');
  const foreign = snapshot('owner-b');
  expect(currentActivityVerified(foreign)).toBe(false);
  expect(activity(foreign)).toBe('Unknown — verify original work');
  expect(foreign.view.runs[0]!.status).toBe('running');
  expect(foreign.view.runs[0]!.isActive).toBe(true);
  expect(activityDot(true, null)).toBe('? ');
  expect(activityDot(true, 0)).toBe('● ');
});

test('older ports without a connection identity keep their existing observation contract', () => {
  expect(currentActivityVerified(snapshot())).toBe(true);
  expect(activity(snapshot())).toBe('Working');
  expect(currentActivityVerified(snapshot('owner-a', null))).toBe(false);
});

test('foreign owner renders an explicit uncertainty notice without issuing recovery or cancellation', async () => {
  let writes = 0;
  const foreign = snapshot('owner-b');
  const forbidden = async () => {
    writes++;
    throw Error('unexpected business write');
  };
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => 'unused',
    listSessions: async () => [],
    readSession: async () => foreign,
    submit: forbidden,
    answer: forbidden,
    cancel: forbidden,
    getCommand: forbidden,
  };
  const controller = new TuiController(port);
  await controller.select('s');
  const app = render(<TuiSession controller={controller} />);
  try {
    await Bun.sleep(30);
    expect(app.lastFrame()).toContain('work may still be executing in another owner.');
    expect(app.lastFrame()).not.toContain('Working');
    expect(writes).toBe(0);
    expect(controller.state.snapshot?.view.runs[0]?.status).toBe('running');
  } finally {
    app.unmount();
    controller.dispose();
  }
});

test('unverified owner keeps recorded reasoning readable while live indicators are explicitly unverified', () => {
  const app = render(
    <TuiPresentationProvider
      value={{ preferences: defaultTuiPreferences, activityVerified: false }}
    >
      <TuiActivityLine activity="Working" />
      <TuiRecordedPhaseTime startedAt={1} label="Thinking" />
      <ToolSummaryBlock
        block={{
          id: 1,
          kind: 'tool_summary',
          tools: [],
          createdAt: 1,
          summaryLine: '',
          active: true,
          hasThought: true,
          hasThinking: true,
          latestActivity: { kind: 'thinking', text: 'Original recorded reasoning' },
        }}
        columns={80}
      />
    </TuiPresentationProvider>,
  );
  try {
    expect(app.lastFrame()).not.toContain('Working');
    expect(app.lastFrame()).not.toContain('Thinking');
    expect(app.lastFrame()).toContain('? Activity unverified');
    expect(app.lastFrame()).toContain('Original recorded reasoning');
  } finally {
    app.unmount();
    app.cleanup();
  }
});
