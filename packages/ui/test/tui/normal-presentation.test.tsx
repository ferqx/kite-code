import { expect, test } from 'bun:test';
import type { Command, SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import { TuiController, type TuiPort, TuiSession, type TuiSnapshot } from '../../src/tui';

test('ordinary Ink keeps the original conversation layout and complete result; diagnostics require an explicit option', async () => {
  let gets = 0,
    posts = 0,
    cancels = 0;
  const snapshot: TuiSnapshot = {
    storeId: 'private-store',
    environment: {
      workspacePath: '/owned/workspace',
      modelName: 'actual-model',
      effort: 'high',
      permissionMode: 'auto',
    },
    view: {
      storeId: 'private-store',
      session: {
        id: 'private-session',
        workspaceId: 'w',
        title: 'My conversation',
        nextSeq: '1',
        contextSelectionId: 'context',
      },
      runs: [],
      executions: [
        {
          id: 'private-execution',
          originStoreId: 'private-store',
          sessionId: 'private-session',
          kind: 'tool',
          definitionId: 'files.read',
          status: 'succeeded',
          resultRevision: '1',
          cancelRequestedAt: null,
          result: {
            text: 'original line1\n完整🙂line2',
            meta: { falseValue: false, empty: null },
            files: ['a', 'b'],
          },
        },
      ],
      messages: [],
    } as unknown as SessionView,
    messages: [
      {
        id: 'private-message',
        sessionId: 'private-session',
        runId: null,
        seq: '1',
        role: 'assistant',
        content: 'Original complete answer',
        status: 'complete',
      },
    ],
    interactions: [],
  };
  const original: Command = {
    id: 'private-command',
    sessionId: 'private-session',
    originStoreId: 'private-store',
    kind: 'run.start',
    status: 'accepted',
    receipt: {},
    cancelRequestedAt: null,
  };
  const port: TuiPort = {
    storeId: 'private-store',
    executions: {
      getExecution: async () => snapshot.view.executions[0]!,
      output: async () => {
        throw Error('no Job');
      },
      getView: async () => snapshot.view,
      getRun: async () => {
        throw Error('no Run');
      },
      messages: async () => [],
      modelOutput: async () => {
        throw Error('no Model');
      },
      stop: async () => {
        throw Error('Tool is read only');
      },
      getCommand: async () => {
        throw Error('no Command');
      },
    },
    nextCommandId: () => 'private-command',
    listSessions: async () => [],
    readSession: async () => snapshot,
    submit: async () => {
      posts++;
      throw Error('lost response');
    },
    getCommand: async () => {
      gets++;
      return original;
    },
    cancel: async () => {
      cancels++;
      return original;
    },
    answer: async () => {
      throw Error('no approval in fixture');
    },
  };
  const controller = new TuiController(port);
  await controller.select('private-session');
  const app = render(<TuiSession controller={controller} />);
  const tick = () => Bun.sleep(30);
  try {
    await tick();
    expect(app.lastFrame()).toContain('Kite Code');
    expect(app.lastFrame()).toContain('actual-model high');
    expect(app.lastFrame()).toContain('/owned/workspace');
    expect(app.lastFrame()).toContain('Original complete answer');
    expect(app.lastFrame()).toContain('● files.read');
    expect(app.lastFrame()).toContain('more lines');
    // The original compact card keeps a bounded preview; its real detail reader retains every field.
    app.stdin.write('\u0005');
    await tick();
    expect(app.lastFrame()).toContain('Recorded execution result');
    expect(app.lastFrame()).toContain('完整🙂line2');
    expect(app.lastFrame()).toContain('false');
    expect(app.lastFrame()).toContain('null');
    app.stdin.write('\u001b');
    await tick();
    expect(app.lastFrame()).toContain('❯');
    for (const identity of [
      'private-store',
      'private-session',
      'private-execution',
      'private-message',
      'New Run >',
    ])
      expect(app.lastFrame()).not.toContain(identity);
    app.rerender(<TuiSession controller={controller} testDiagnostics />);
    await tick();
    expect(app.lastFrame()).toContain('private-execution');
    app.rerender(<TuiSession controller={controller} />);
    await tick();
    controller.setDraft('/help');
    await tick();
    app.stdin.write('\r');
    await tick();
    expect(app.lastFrame()).toContain('Help');
    app.stdin.write('\u0003');
    await tick();
    expect(controller.state.panel).toBeUndefined();
    expect(cancels).toBe(0);
    controller.setDraft('exact user task');
    await tick();
    app.stdin.write('\r');
    await tick();
    expect(posts).toBe(1);
    expect(controller.state.intent?.phase).toBe('unknown');
    expect(app.lastFrame()).not.toContain('check the original request');
    app.stdin.write('\u000c');
    await tick();
    expect(gets).toBe(1);
    expect(posts).toBe(1);
    app.rerender(<TuiSession controller={controller} testDiagnostics />);
    await tick();
    expect(app.lastFrame()).toContain('private-command');
  } finally {
    app.unmount();
    controller.dispose();
  }
});

for (const observationFailed of [false, true]) {
  test(`ordinary Ink reports an explicit export failure with observation ${observationFailed ? 'unavailable' : 'ready'}`, async () => {
    const controller = errorPresentationController();
    await controller.select('a');
    if (observationFailed) controller.observationUnavailable('network');
    const ui = render(<TuiSession controller={controller} />);
    try {
      await controller.exportLoadedText();
      await Bun.sleep(30);
      expect(controller.state.error).toBe('Export failed');
      expect(ui.lastFrame()).toContain('Export failed');
      expect(ui.lastFrame()).not.toContain('observation_unavailable');
    } finally {
      ui.unmount();
      controller.dispose();
    }
  });
}

for (const failure of ['tui_identity_mismatch', 'temporary_history_read_failure']) {
  test(`ordinary Ink ${failure.includes('identity') ? 'reports identity refusal' : 'suppresses transient snapshot errors'}`, async () => {
    const controller = errorPresentationController(failure);
    await controller.select('a');
    const ui = render(<TuiSession controller={controller} />);
    try {
      await Bun.sleep(30);
      expect(controller.state.error).toBe(failure);
      expect(controller.state.snapshotStale).toBe(true);
      if (failure.includes('identity')) expect(ui.lastFrame()).toContain(failure);
      else expect(ui.lastFrame()).not.toContain(failure);
    } finally {
      ui.unmount();
      controller.dispose();
    }
  });
}

function errorPresentationController(readFailure?: string) {
  return new TuiController({
    storeId: 'store',
    nextCommandId: () => 'unused',
    listSessions: async () => [],
    readSession: async (id) => {
      if (readFailure) throw Error(readFailure);
      return {
        storeId: 'store',
        view: {
          storeId: 'store',
          session: { id, workspaceId: 'w', contextSelectionId: 'selection', nextSeq: '0' },
          runs: [],
          executions: [],
          messages: [],
        } as unknown as SessionView,
        messages: [],
        interactions: [],
      };
    },
    exportLoadedText: {
      write: async () => {
        throw Error('disk_full');
      },
    },
    submit: async () => {
      throw Error('unexpected_write');
    },
    answer: async () => {
      throw Error('unexpected_answer');
    },
    cancel: async () => {
      throw Error('unexpected_cancel');
    },
    getCommand: async () => {
      throw Error('unexpected_lookup');
    },
  });
}

test('ordinary Ink reports observation identity refusal and clears successful snapshot error provenance', async () => {
  const controller = errorPresentationController('temporary_history_read_failure');
  await controller.select('a');
  expect(controller.state.errorSource).toBe('snapshot');
  const healthy = errorPresentationController();
  controller.port.readSession = healthy.port.readSession;
  healthy.dispose();
  await controller.select('a');
  expect(controller.state.errorSource).toBeUndefined();
  controller.observationUnavailable('store_changed');
  const ui = render(<TuiSession controller={controller} />);
  try {
    await Bun.sleep(30);
    expect(ui.lastFrame()).toContain('observation_unavailable:store_changed');
  } finally {
    ui.unmount();
    controller.dispose();
  }
});

test('ordinary Ink hides reconciliation errors but shows a later action failure even with identical read-error text', async () => {
  const controller = errorPresentationController();
  controller.port.reconcileSession = async () => {
    throw Error('temporary_reconciliation_failure');
  };
  await controller.select('a');
  const ui = render(<TuiSession controller={controller} />);
  try {
    await Bun.sleep(30);
    expect(controller.state.errorSource).toBe('snapshot');
    expect(ui.lastFrame()).not.toContain('temporary_reconciliation_failure');
    controller.port.readSession = async () => {
      throw Error('Export failed');
    };
    await controller.select('a', { reconcile: false });
    await Bun.sleep(30);
    expect(controller.state.error).toBe('Export failed');
    expect(ui.lastFrame()).not.toContain('Export failed');
    await controller.exportLoadedText();
    await Bun.sleep(30);
    expect(controller.state.errorSource).toBeUndefined();
    expect(ui.lastFrame()).toContain('Export failed');
  } finally {
    ui.unmount();
    controller.dispose();
  }
});
