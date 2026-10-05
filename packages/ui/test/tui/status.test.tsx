import { expect, test } from 'bun:test';
import type { HostStatus, SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import { TuiController, type TuiPort, TuiSession } from '../../src/tui';

const facts = (sessionId = 'a'): HostStatus => ({
  version: 1,
  identity: {
    instanceId: 'original-instance',
    buildId: 'original-build',
    apiMajor: 1,
    profileAccessKey: 'PRIVATE_KEY',
    dataAvailability: 'available',
    storeId: 'store',
  },
  scope: { workspaceId: 'w', sessionId },
  execution: {
    state: 'available',
    reason: null,
    sandbox: { backend: 'none', available: false, qualification: 'unqualified' },
    shell: {
      configured: false,
      available: false,
      supervision: 'none',
      qualification: 'not_configured',
      reason: 'shell_not_configured',
    },
    permissions: {
      state: 'available',
      scope: 'session',
      mode: 'ask',
      defaultMode: 'ask',
      workspaceTrust: 'untrusted',
      reason: null,
    },
  },
  release: {
    state: 'available',
    active: false,
    production: null,
    qualification: 'unverified',
    reason: 'release_manifest_not_bound',
  },
  telemetry: {
    state: 'available',
    enabled: false,
    exporterConfigured: false,
    diskSpool: false,
    reason: 'exporter_not_configured',
  },
});
function fixture() {
  let reads = 0,
    effects = 0;
  const effect = async (): Promise<never> => {
    effects++;
    throw Error('unexpected mutation');
  };
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => 'unused',
    listSessions: async () => [],
    readSession: async (id) => ({
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
    }),
    submit: effect,
    answer: effect,
    cancel: effect,
    getCommand: effect,
    status: {
      mode: 'shared',
      profile: 'development',
      read: async (id) => {
        reads++;
        return facts(id);
      },
    },
  };
  return { port, controller: new TuiController(port), counts: () => ({ reads, effects }) };
}
test('status verifies finite host facts, preserves unknown and original observation, has no command effects', async () => {
  const f = fixture();
  await f.controller.select('a');
  f.controller.observationReady('store');
  await f.controller.routeCommand('/status extra');
  expect(f.counts()).toEqual({ reads: 0, effects: 0 });
  await f.controller.routeCommand('/status');
  expect(f.controller.state.status?.connection).toBe('verified');
  f.controller.observationUnavailable('network');
  expect(f.controller.state.status?.connection).toBe('unknown');
  f.port.status!.read = async () => {
    throw Error('SECRET endpoint token');
  };
  await f.controller.openStatus();
  expect(f.controller.state.status?.facts).toEqual(facts());
  expect(f.controller.state.status?.error).toBe('host_status_unavailable');
  f.port.status!.read = async () => facts();
  await f.controller.openStatus();
  expect(f.controller.state.status?.connection).toBe('verified');
  expect(f.controller.state.observationState).toBe('unknown');
  expect(f.controller.state.observationError).toBe('observation_unavailable:network');
  expect(f.counts().effects).toBe(0);
  const ui = render(<TuiSession controller={f.controller} />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(ui.lastFrame()).toContain('original-build');
  expect(ui.lastFrame()).toContain('shared');
  expect(ui.lastFrame()).not.toContain('PRIVATE_KEY');
  ui.unmount();
  f.controller.dispose();
});
test('close, switch, wrong scope and disposal isolate late diagnostic responses', async () => {
  const f = fixture();
  await f.controller.select('a');
  let resolve!: (value: HostStatus) => void, signal!: AbortSignal;
  f.port.status!.read = (_id, _w, s) => {
    signal = s;
    return new Promise((r) => {
      resolve = r;
    });
  };
  const closing = f.controller.openStatus();
  f.controller.closePanel();
  expect(signal.aborted).toBe(true);
  resolve(facts());
  await closing;
  expect(f.controller.state.status?.facts).toBeUndefined();
  f.port.status!.read = async () => ({
    ...facts('b'),
    identity: { ...facts('b').identity, storeId: 'foreign' },
  });
  await f.controller.openStatus();
  expect(f.controller.state.status?.connection).toBe('unknown');
  expect(f.controller.state.status?.facts).toBeUndefined();
  const switching = f.controller.openStatus();
  await f.controller.select('b');
  resolve(facts());
  await switching;
  expect(f.controller.state.status).toBeUndefined();
  f.port.status!.read = async () => facts('a');
  await f.controller.openStatus();
  expect(f.controller.state.status?.connection).toBe('unknown');
  expect(f.controller.state.status?.facts).toBeUndefined();
  f.port.status!.read = (_id, _w, s) => {
    signal = s;
    return new Promise((r) => {
      resolve = r;
    });
  };
  const disposing = f.controller.openStatus();
  f.controller.dispose();
  expect(signal.aborted).toBe(true);
  resolve(facts('b'));
  await disposing;
  expect(f.counts().effects).toBe(0);
});
