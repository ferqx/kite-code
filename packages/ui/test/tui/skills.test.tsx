import type { SessionView, SkillCataloguePage } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import { expect, test } from '#kite-test';
import { TuiController, type TuiPort, TuiSession } from '../../src/tui';
import { skillDetails } from '../../src/tui/skills-panel';

const catalogue = (workspaceId = 'w'): SkillCataloguePage => ({
  version: 1,
  storeId: 'store',
  workspaceId,
  revision: 'a'.repeat(64),
  availability: 'available',
  reason: null,
  entries: Array.from({ length: 303 }, (_, index) => ({
    id: `configured-${index.toString().padStart(3, '0')}`,
    name: `Skill ${index}`,
    description: index === 0 ? `${'完整描述'.repeat(300)}END_DESCRIPTION` : `Knowledge ${index}`,
    version: index === 302 ? null : 'b'.repeat(64),
    enabled: index !== 301,
    state: index === 301 ? 'disabled' : index === 302 ? 'unavailable' : 'available',
    reason: index === 302 ? 'skill_capability_missing' : null,
    requiredCapabilities: ['skills.load'],
    missingCapabilities: index === 302 ? ['skills.load'] : [],
  })),
  nextAfterId: null,
  complete: true,
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
        session: {
          id,
          rootSessionId: id,
          parentSessionId: null,
          workspaceId: id === 'c' ? 'foreign' : 'w',
        },
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
    skills: {
      read: async (_id, workspaceId) => {
        reads++;
        return catalogue(workspaceId);
      },
    },
  };
  return { port, controller: new TuiController(port), counts: () => ({ reads, effects }) };
}
test('skills fixed read-only command preserves all entries and does not activate knowledge-only entries', async () => {
  const f = fixture();
  await f.controller.select('a');
  f.controller.setDraft('original draft');
  await f.controller.routeCommand('/skills extra');
  await f.controller.routeCommand('/Skill_0 task');
  expect(f.counts()).toEqual({ reads: 0, effects: 0 });
  expect(f.controller.state.draft).toBe('original draft');
  f.controller.observationUnavailable('network');
  await f.controller.routeCommand('/skills');
  expect(f.controller.state.skills?.read).toBe('verified');
  expect(f.controller.state.skills?.facts?.entries).toHaveLength(303);
  expect(f.controller.state.skills?.facts?.entries[301]?.state).toBe('disabled');
  expect(f.controller.state.skills?.facts?.entries[302]?.state).toBe('unavailable');
  expect(f.controller.state.skills?.facts?.entries[302]?.reason).toBe('skill_capability_missing');
  expect(f.controller.state.observationState).toBe('unknown');
  expect(f.controller.state.stale).toBe(true);
  f.port.skills!.read = async () => {
    throw Error('SECRET body path');
  };
  await f.controller.openSkills();
  expect(f.controller.state.skills?.read).toBe('unknown');
  expect(f.controller.state.skills?.facts?.entries).toHaveLength(303);
  expect(f.controller.state.skills?.error).toBe('skill_catalogue_unavailable');
  expect(f.counts().effects).toBe(0);
  f.controller.dispose();
});
test('close, refresh, switch and disposal reject late or incomplete/wrong-identity catalogue facts', async () => {
  const f = fixture();
  await f.controller.select('a');
  let resolve!: (value: SkillCataloguePage) => void, signal!: AbortSignal;
  f.port.skills!.read = (_id, _w, s) => {
    signal = s;
    return new Promise((r) => {
      resolve = r;
    });
  };
  const closing = f.controller.openSkills();
  f.controller.closePanel();
  expect(signal.aborted).toBe(true);
  resolve(catalogue());
  await closing;
  expect(f.controller.state.skills?.facts).toBeUndefined();
  const old = f.controller.openSkills(),
    oldResolve = resolve,
    oldSignal = signal;
  const refreshed = f.controller.openSkills();
  expect(oldSignal.aborted).toBe(true);
  resolve(catalogue());
  await refreshed;
  oldResolve({ ...catalogue(), revision: 'c'.repeat(64) });
  await old;
  expect(f.controller.state.skills?.facts?.revision).toBe('a'.repeat(64));
  const switching = f.controller.openSkills();
  await f.controller.select('b');
  resolve(catalogue());
  await switching;
  expect(f.controller.state.skills).toBeUndefined();
  for (const bad of [
    { ...catalogue(), storeId: 'foreign' },
    catalogue('foreign'),
    { ...catalogue(), complete: false, nextAfterId: 'configured-300' },
  ]) {
    f.port.skills!.read = async () => bad;
    await f.controller.openSkills();
    expect(f.controller.state.skills?.read).toBe('unknown');
    expect(f.controller.state.skills?.facts).toBeUndefined();
  }
  f.port.skills!.read = (_id, _w, s) => {
    signal = s;
    return new Promise((r) => {
      resolve = r;
    });
  };
  const disposing = f.controller.openSkills();
  f.controller.dispose();
  expect(signal.aborted).toBe(true);
  resolve(catalogue());
  await disposing;
  expect(f.controller.state.skills?.facts).toBeUndefined();
  expect(f.counts().effects).toBe(0);
});
test('Skill detail pagination retains full metadata and renders controls as readable text', () => {
  const entry = {
    ...catalogue().entries[0]!,
    name: '控制\u001b[2J',
    description: `start\t${'中文'.repeat(1000)}\nEND`,
  };
  const pages = skillDetails(entry);
  expect(pages.length).toBeGreaterThan(1);
  const text = pages.join('\n').replaceAll('\n', '');
  expect(text).toContain('\\u001b[2J');
  expect(text).toContain('start\\t');
  expect(text).toContain('END');
  expect(text).toContain('中文'.repeat(1000));
  expect(text).not.toContain('\u001b');
});
test('Ink arrows navigate entries, detail pages preserve full text and local CtrlC cancels only reading', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openSkills();
  const ui = render(<TuiSession testDiagnostics controller={f.controller} />);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
  await tick();
  expect(ui.lastFrame()).toContain('Knowledge Skills · total 303');
  expect(ui.lastFrame()).toContain('Read only · Skill knowledge');
  expect(ui.lastFrame()).toContain('Entry 1/303');
  ui.stdin.write('\u001b[C');
  await tick();
  expect(ui.lastFrame()).toContain('Details page 2/');
  ui.stdin.write('\u001b[B');
  await tick();
  expect(ui.lastFrame()).toContain('Entry 2/303');
  expect(ui.lastFrame()).toContain('Details page 1/');
  ui.stdin.write('\u001b[B'.repeat(301));
  await tick();
  expect(ui.lastFrame()).toContain('Entry 303/303');
  expect(ui.lastFrame()).toContain('Skill 302 [unavailable]');
  ui.stdin.write('\u001b[A');
  await tick();
  expect(ui.lastFrame()).toContain('Entry 302/303');
  expect(ui.lastFrame()).toContain('Skill 301 [disabled]');
  ui.stdin.write('r');
  await tick();
  expect(f.counts().reads).toBe(3);
  expect(f.counts().effects).toBe(0);
  let resolve!: (page: SkillCataloguePage) => void, signal!: AbortSignal;
  f.port.skills!.read = (_id, _workspace, readSignal) => {
    signal = readSignal;
    return new Promise((done) => {
      resolve = done;
    });
  };
  ui.stdin.write('r');
  await tick();
  expect(f.controller.state.skills?.read).toBe('reading');
  ui.stdin.write('\u0003');
  await tick();
  expect(signal.aborted).toBe(true);
  resolve({ ...catalogue(), revision: 'c'.repeat(64) });
  await tick();
  expect(f.controller.state.panel).toBeUndefined();
  expect(f.controller.state.skills?.facts?.revision).toBe('a'.repeat(64));
  expect(f.counts().effects).toBe(0);
  ui.unmount();
  f.controller.dispose();
});
test('unavailable source is unknown and retains last confirmed catalogue; an available empty catalogue is distinct', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openSkills();
  const unavailable: SkillCataloguePage = {
    ...catalogue(),
    availability: 'unavailable',
    reason: 'configuration_unavailable',
    entries: [],
  };
  f.port.skills!.read = async () => unavailable;
  await f.controller.openSkills();
  expect(f.controller.state.skills?.read).toBe('unknown');
  expect(f.controller.state.skills?.facts?.entries).toHaveLength(303);
  expect(f.controller.state.skills?.error).toBe('configuration_unavailable');
  await f.controller.select('b');
  await f.controller.openSkills();
  expect(f.controller.state.skills?.facts?.availability).toBe('unavailable');
  const ui = render(<TuiSession testDiagnostics controller={f.controller} />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(ui.lastFrame()).toContain('total unknown');
  expect(ui.lastFrame()).toContain('Catalogue source unavailable');
  f.port.skills!.read = async () => ({ ...catalogue(), entries: [] });
  await f.controller.openSkills();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(ui.lastFrame()).toContain('total 0');
  expect(ui.lastFrame()).toContain('No configured Skill entries');
  expect(f.controller.state.skills?.read).toBe('verified');
  expect(f.counts().effects).toBe(0);
  ui.unmount();
  f.controller.dispose();
});
