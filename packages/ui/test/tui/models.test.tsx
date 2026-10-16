import { expect, test } from 'bun:test';
import type { ModelSettingsView, SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import {
  TuiController,
  type TuiModelIntent,
  type TuiModelOutcome,
  type TuiPort,
  type TuiSnapshot,
} from '../../src/tui';
import { TuiModelPanel } from '../../src/tui/model-panel';

const observed = (_workspaceId = 'w'): ModelSettingsView => ({
  storeId: 'store',
  scope: 'user',
  readSet: {
    userEtag: 'a'.repeat(64),
    workspaceEtag: null,
    explicitDigest: 'c'.repeat(64),
    effectiveDigest: 'd'.repeat(64),
  },
  defaultModelId: 'one',
  models: [
    {
      id: 'one',
      provider: 'compatible',
      model: 'same',
      enabled: true,
      configured: true,
      diagnostics: [],
    },
    {
      id: 'two',
      provider: 'compatible',
      model: 'same',
      enabled: true,
      configured: true,
      diagnostics: [],
    },
  ],
  errors: [],
});
function fixture(workspaces: Record<string, string> = {}) {
  let count = 0;
  const sent: TuiModelIntent[] = [];
  const looked: TuiModelIntent[] = [];
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => `c${++count}`,
    listSessions: async () => [],
    readSession: async (id) =>
      ({
        storeId: 'store',
        view: {
          storeId: 'store',
          session: {
            id,
            rootSessionId: id,
            parentSessionId: null,
            workspaceId: workspaces[id] ?? 'w',
          },
          runs: [],
          executions: [],
          messages: [],
        } as unknown as SessionView,
        messages: [],
        interactions: [],
      }) as TuiSnapshot,
    submit: async () => {
      throw Error('no Model');
    },
    answer: async () => {
      throw Error('no answer');
    },
    cancel: async () => {
      throw Error('no cancel');
    },
    getCommand: async () => {
      throw Error('no command');
    },
    models: {
      read: async (workspaceId) => observed(workspaceId),
      submit: async (intent) => {
        sent.push(intent);
        return { intent, status: 'outcome_unknown' };
      },
      lookup: async (intent) => {
        looked.push(intent);
        return { intent, status: 'applied' };
      },
    },
  };
  return { port, sent, looked, controller: new TuiController(port) };
}
test('pending model save keeps duplicate keyboard feedback under the controller guard with one original request', async () => {
  const f = fixture();
  let finish!: (outcome: TuiModelOutcome) => void;
  f.port.models!.submit = (intent) =>
    new Promise((resolve) => {
      f.sent.push(intent);
      finish = resolve;
    });
  await f.controller.select('a');
  await f.controller.openModels();
  const ui = render(<TuiModelPanel controller={f.controller} />);
  const unsubscribe = f.controller.subscribe(() =>
    ui.rerender(<TuiModelPanel controller={f.controller} />),
  );
  const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
  try {
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(f.sent).toHaveLength(1);
    ui.stdin.write('\r');
    await tick();
    expect(f.sent).toHaveLength(1);
    expect(f.controller.state.error).toBe('model_settings_original_outcome_required');
    finish({ intent: f.sent[0]!, status: 'outcome_unknown' });
    await tick();
    ui.stdin.write('k');
    await tick();
    expect(f.looked).toEqual([f.sent[0]!]);
    expect(f.sent).toHaveLength(1);
  } finally {
    unsubscribe();
    ui.unmount();
    f.controller.dispose();
  }
});

test('models freeze read set, unknown blocks a second write, lookup only queries the original and preserves failed default', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openModels();
  const facts = f.controller.state.models!;
  await f.controller.chooseModel({ kind: 'default', modelId: 'two' });
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]!.request.expectedReadSet).toEqual(facts.readSet!);
  expect(f.controller.state.models!.defaultModelId).toBe('one');
  await f.controller.chooseModel({ kind: 'default', modelId: 'one' });
  expect(f.sent).toHaveLength(1);
  let queried: TuiModelIntent | undefined;
  f.port.models!.lookup = async (intent) => {
    queried = intent;
    return { intent, status: 'failed' };
  };
  await f.controller.lookupModel();
  expect(queried).toEqual(f.sent[0]);
  expect(f.sent).toHaveLength(1);
  expect(f.controller.state.models!.defaultModelId).toBe('one');
  expect(f.controller.state.error).toBe('model_settings_save_failed');
  f.controller.dispose();
});
test('models stale observation and obsolete panel observations cannot mutate; late reads and receipts never cross sessions', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openModels();
  const original = f.controller.state.models!;
  f.controller.observationUnavailable('lost');
  await f.controller.chooseModel({ kind: 'default', modelId: 'two' });
  expect(f.sent).toHaveLength(0);
  f.controller.observationReady('store');
  await f.controller.openModels();
  await f.controller.chooseModel({ kind: 'default', modelId: 'two' }, original);
  expect(f.sent).toHaveLength(0);
  let resolve!: (o: import('../../src/tui').TuiModelOutcome) => void;
  f.port.models!.submit = (intent) =>
    new Promise((r) => {
      f.sent.push(intent);
      resolve = r;
    });
  const writing = f.controller.chooseModel({ kind: 'default', modelId: 'two' });
  await f.controller.select('b');
  resolve({ intent: f.sent[0]!, status: 'applied' });
  await writing;
  expect(f.controller.state.modelOutcome).toBeUndefined();
  expect(f.controller.state.models).toBeUndefined();
  let read!: (o: ModelSettingsView) => void;
  f.port.models!.read = () =>
    new Promise((r) => {
      read = r;
    });
  const opening = f.controller.openModels();
  await f.controller.select('a');
  read(observed());
  await opening;
  expect(f.controller.state.models).toBeUndefined();
  f.controller.dispose();
});
test('model catalogue unavailable, invalid choices, and disabled default do not create work', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.routeCommand('/model');
  await f.controller.chooseModel({ kind: 'default', modelId: 'missing' });
  await f.controller.chooseModel({ kind: 'enabled', modelId: 'one', enabled: false });
  expect(f.sent).toHaveLength(0);
  f.port.models = undefined;
  await f.controller.openModels();
  expect(f.controller.state.error).toBe('model_settings_unavailable');
  f.controller.dispose();
});
test('effort uses explicit adapter choices and closed operation; null clears original scope, absent capability creates no write', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.routeCommand('/effort');
  expect(f.controller.state.panel).toBe('effort');
  await f.controller.chooseModel({ kind: 'effort', modelId: 'one', reasoningEffort: 'high' });
  expect(f.sent).toHaveLength(0);
  f.port.models!.read = async () => ({
    ...observed(),
    models: observed().models.map((m) => ({
      ...m,
      reasoningEffort: 'low' as const,
      reasoningEffortSupport: 'compatible_wire' as const,
      reasoningEffortChoices: ['low' as const, 'high' as const],
      reasoningEffortReadonlyReason: null,
    })),
  });
  await f.controller.openModels('effort');
  await f.controller.chooseModel({ kind: 'effort', modelId: 'one', reasoningEffort: 'max' });
  expect(f.sent).toHaveLength(0);
  await f.controller.chooseModel({ kind: 'effort', modelId: 'one', reasoningEffort: null });
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]!.request.operation).toEqual({
    kind: 'effort',
    modelId: 'one',
    reasoningEffort: null,
  });
  expect(f.controller.state.models!.models[0]!.reasoningEffort).toBe('low');
  f.controller.dispose();
});
test('known model CAS failure preserves facts and allows a later explicit choice without automatic resubmission', async () => {
  const f = fixture();
  f.port.models!.submit = async (intent) => {
    f.sent.push(intent);
    return { intent, status: 'failed' };
  };
  await f.controller.select('a');
  await f.controller.openModels();
  const facts = f.controller.state.models;
  await f.controller.chooseModel({ kind: 'default', modelId: 'two' });
  expect(f.sent).toHaveLength(1);
  expect(f.controller.state.models).toBe(facts);
  expect(f.controller.state.modelOutcome?.status).toBe('failed');
  await f.controller.openModels();
  expect(f.sent).toHaveLength(1);
  await f.controller.chooseModel({ kind: 'default', modelId: 'two' });
  expect(f.sent).toHaveLength(2);
  expect(f.sent[1]!.request.commandId).not.toBe(f.sent[0]!.request.commandId);
  f.controller.dispose();
});

test('model settings remain queryable by original ID from another Session in the same Workspace and either settings panel', async () => {
  const f = fixture();
  try {
    await f.controller.select('a');
    await f.controller.routeCommand('/model');
    await f.controller.chooseModel({ kind: 'default', modelId: 'two' });
    const original = structuredClone(f.sent[0]!);
    expect(original).toMatchObject({
      sessionId: 'a',
      scope: 'user',
      request: { commandId: 'c1', expectedStoreId: 'store' },
    });
    await f.controller.select('b');
    await f.controller.routeCommand('/effort');
    expect(f.controller.state.modelOutcome).toEqual({
      intent: original,
      status: 'outcome_unknown',
    });
    await f.controller.chooseModel({ kind: 'default', modelId: 'one' });
    expect(f.sent).toHaveLength(1);
    expect(f.controller.state.error).toBe('model_settings_original_outcome_required');
    await f.controller.lookupModel();
    expect(f.looked).toEqual([original]);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toEqual(original);
    expect(f.controller.state.sessionId).toBe('b');
    expect(f.controller.state.panel).toBe('effort');
    expect(f.controller.state.modelOutcome).toEqual({ intent: original, status: 'applied' });
    await f.controller.routeCommand('/model');
    await f.controller.chooseModel({ kind: 'default', modelId: 'two' });
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toMatchObject({
      sessionId: 'b',
      request: { commandId: 'c2', expectedStoreId: 'store' },
    });
  } finally {
    f.controller.dispose();
  }
});

test('one user model intent blocks competing writes across Workspaces until its original is checked', async () => {
  const f = fixture({ c: 'other' });
  try {
    await f.controller.select('a');
    await f.controller.openModels();
    await f.controller.chooseModel({ kind: 'default', modelId: 'two' });
    const original = f.sent[0]!;
    await f.controller.select('c');
    await f.controller.openModels('effort');
    expect(f.controller.state.modelOutcome).toEqual({
      intent: original,
      status: 'outcome_unknown',
    });
    await f.controller.chooseModel({ kind: 'default', modelId: 'two' });
    expect(f.sent).toHaveLength(1);
    await f.controller.lookupModel();
    expect(f.looked).toEqual([original]);
    await f.controller.chooseModel({ kind: 'default', modelId: 'two' });
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toMatchObject({ sessionId: 'c', scope: 'user' });
    expect(f.sent[1]!.request.workspaceId).toBeUndefined();
    await f.controller.select('b');
    await f.controller.openModels();
    expect(f.controller.state.modelOutcome).toEqual({
      intent: f.sent[1]!,
      status: 'outcome_unknown',
    });
    await f.controller.lookupModel();
    expect(f.looked).toEqual(f.sent);
  } finally {
    f.controller.dispose();
  }
});

test('closing and changing model panels retires save and lookup display ownership while current read errors remain visible', async () => {
  const f = fixture();
  let finishSave: ((value: TuiModelOutcome) => void) | undefined;
  let finishLookup: ((value: TuiModelOutcome) => void) | undefined;
  let writing: Promise<void> | undefined;
  let querying: Promise<void> | undefined;
  let closedQuery: Promise<void> | undefined;
  let reads = 0;
  f.port.models!.read = async (workspaceId) => {
    reads++;
    return observed(workspaceId);
  };
  f.port.models!.submit = (intent) => {
    f.sent.push(intent);
    return new Promise((resolve) => {
      finishSave = resolve;
    });
  };
  f.port.models!.lookup = (intent) => {
    f.looked.push(intent);
    return new Promise((resolve) => {
      finishLookup = resolve;
    });
  };
  try {
    await f.controller.select('a');
    await f.controller.openModels();
    writing = f.controller.chooseModel({ kind: 'default', modelId: 'two' });
    f.controller.closePanel();
    closedQuery = f.controller.lookupModel();
    // Release an incorrectly admitted old-controller lookup before asserting its absence.
    if (f.looked.length) finishLookup!({ intent: f.sent[0]!, status: 'outcome_unknown' });
    await closedQuery;
    expect(f.looked).toHaveLength(0);
    f.port.models!.read = async () => {
      reads++;
      throw Error('current_effort_read_failed');
    };
    await f.controller.openModels('effort');
    const displayed = f.controller.state.modelOutcome;
    const currentReads = reads;
    finishSave!({ intent: f.sent[0]!, status: 'failed' });
    await writing;
    expect(f.controller.state.panel).toBe('effort');
    expect(f.controller.state.modelOutcome).toBe(displayed);
    expect(f.controller.state.error).toBe('current_effort_read_failed');
    expect(reads).toBe(currentReads);
    f.port.models!.read = async (workspaceId) => {
      reads++;
      return observed(workspaceId);
    };
    await f.controller.openModels();
    expect(f.controller.state.modelOutcome).toEqual({ intent: f.sent[0]!, status: 'failed' });
    querying = f.controller.lookupModel();
    f.controller.closePanel();
    f.port.models!.read = async () => {
      reads++;
      throw Error('current_models_read_failed');
    };
    await f.controller.openModels();
    const laterDisplay = f.controller.state.modelOutcome;
    const laterReads = reads;
    finishLookup!({ intent: f.sent[0]!, status: 'outcome_unknown' });
    await querying;
    expect(f.controller.state.modelOutcome).toBe(laterDisplay);
    expect(f.controller.state.error).toBe('current_models_read_failed');
    expect(reads).toBe(laterReads);
    expect(f.looked).toEqual([f.sent[0]!]);
    expect(f.sent).toHaveLength(1);
  } finally {
    f.controller.dispose();
    if (f.sent[0]) {
      finishSave?.({ intent: f.sent[0], status: 'failed' });
      finishLookup?.({ intent: f.sent[0], status: 'outcome_unknown' });
    }
    await Promise.allSettled([writing, querying, closedQuery]);
  }
});

test('the later original model lookup cannot be downgraded by an earlier save or same-ID query', async () => {
  const f = fixture();
  let finishSave: ((value: TuiModelOutcome) => void) | undefined;
  const finishes: ((value: TuiModelOutcome) => void)[] = [];
  let writing: Promise<void> | undefined;
  let earlier: Promise<void> | undefined;
  let later: Promise<void> | undefined;
  f.port.models!.submit = (intent) => {
    f.sent.push(intent);
    return new Promise((resolve) => {
      finishSave = resolve;
    });
  };
  f.port.models!.lookup = (intent) => {
    f.looked.push(intent);
    return new Promise((resolve) => finishes.push(resolve));
  };
  try {
    await f.controller.select('a');
    await f.controller.openModels();
    writing = f.controller.chooseModel({ kind: 'default', modelId: 'two' });
    earlier = f.controller.lookupModel();
    later = f.controller.lookupModel();
    finishes[1]!({ intent: f.sent[0]!, status: 'applied' });
    await later;
    const current = f.controller.state.modelOutcome;
    finishes[0]!({ intent: f.sent[0]!, status: 'outcome_unknown' });
    await earlier;
    finishSave!({ intent: f.sent[0]!, status: 'outcome_unknown' });
    await writing;
    expect(current).toEqual({ intent: f.sent[0]!, status: 'applied' });
    expect(f.controller.state.modelOutcome).toBe(current);
    await f.controller.openModels('effort');
    expect(f.controller.state.modelOutcome).toEqual(current);
    expect(f.looked).toEqual([f.sent[0]!, f.sent[0]!]);
    expect(f.sent).toHaveLength(1);
  } finally {
    f.controller.dispose();
    if (f.sent[0]) {
      finishSave?.({ intent: f.sent[0], status: 'outcome_unknown' });
      for (const finish of finishes) finish({ intent: f.sent[0], status: 'outcome_unknown' });
    }
    await Promise.allSettled([writing, earlier, later]);
  }
});

test('a model lookup uses the current saved terminal fact when the reopened panel still displays unknown', async () => {
  for (const terminal of ['applied', 'failed'] as const) {
    const f = fixture();
    let finishSave: ((value: TuiModelOutcome) => void) | undefined;
    let writing: Promise<void> | undefined;
    f.port.models!.submit = (intent) => {
      f.sent.push(intent);
      return new Promise((resolve) => {
        finishSave = resolve;
      });
    };
    try {
      await f.controller.select('a');
      await f.controller.openModels();
      writing = f.controller.chooseModel({ kind: 'default', modelId: 'two' });
      f.controller.closePanel();
      await f.controller.openModels('effort');
      const displayed = f.controller.state.modelOutcome;
      finishSave!({ intent: f.sent[0]!, status: terminal });
      await writing;
      expect(f.controller.state.modelOutcome).toBe(displayed);
      expect(displayed?.status).toBe('outcome_unknown');
      f.port.models!.lookup = async (intent) => {
        f.looked.push(intent);
        throw Error('original_model_lookup_unavailable');
      };
      await f.controller.lookupModel();
      expect(f.controller.state.modelOutcome).toEqual({ intent: f.sent[0]!, status: terminal });
      f.port.models!.lookup = async (intent) => {
        f.looked.push(intent);
        return { intent, status: 'outcome_unknown' };
      };
      await f.controller.lookupModel();
      expect(f.controller.state.modelOutcome).toEqual({ intent: f.sent[0]!, status: terminal });
      await f.controller.openModels();
      expect(f.controller.state.modelOutcome).toEqual({ intent: f.sent[0]!, status: terminal });
      expect(f.looked).toEqual([f.sent[0]!, f.sent[0]!]);
      expect(f.sent).toHaveLength(1);
    } finally {
      f.controller.dispose();
      if (f.sent[0]) finishSave?.({ intent: f.sent[0], status: terminal });
      await Promise.allSettled([writing]);
    }
  }
});

test('original effort ordering retains every actual adapter choice and clear without inventing availability', async () => {
  const { orderedTuiEfforts } = await import('../../src/tui/model-panel');
  expect(
    orderedTuiEfforts(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultar']),
  ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultar', null, 'none', 'minimal']);
  expect(orderedTuiEfforts(['high', 'low'])).toEqual(['low', 'high', null]);
  expect(orderedTuiEfforts([])).toEqual([null]);
});
