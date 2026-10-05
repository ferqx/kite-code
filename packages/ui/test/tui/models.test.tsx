import { expect, test } from 'bun:test';
import type { ModelSettingsView, SessionView } from '@kite-ai/client';
import { TuiController, type TuiModelIntent, type TuiPort, type TuiSnapshot } from '../../src/tui';

const observed = (): ModelSettingsView => ({
  storeId: 'store',
  scope: 'workspace',
  workspaceId: 'w',
  readSet: {
    userEtag: 'a'.repeat(64),
    workspaceEtag: 'b'.repeat(64),
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
function fixture() {
  let count = 0;
  const sent: TuiModelIntent[] = [];
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => `c${++count}`,
    listSessions: async () => [],
    readSession: async (id) =>
      ({
        storeId: 'store',
        view: {
          storeId: 'store',
          session: { id, rootSessionId: id, parentSessionId: null, workspaceId: 'w' },
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
      read: async () => observed(),
      submit: async (intent) => {
        sent.push(intent);
        return { intent, status: 'outcome_unknown' };
      },
      lookup: async (intent) => ({ intent, status: 'applied' }),
    },
  };
  return { port, sent, controller: new TuiController(port) };
}
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
