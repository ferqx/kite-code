import { expect, test } from 'bun:test';
import type { SessionView, SkillCataloguePage } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import { TuiController, type TuiPort, TuiSession } from '../../src/tui';
import { manualWorkflow } from '../../src/tui/skills';
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
  const ui = render(<TuiSession controller={f.controller} />);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
  await tick();
  expect(ui.lastFrame()).toContain('Knowledge Skills · total 303');
  expect(ui.lastFrame()).toContain('Workflow activation is not available here');
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
  expect(f.counts().reads).toBe(2);
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
  const ui = render(<TuiSession controller={f.controller} />);
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

function workflowFixture() {
  const f = fixture();
  const page = catalogue();
  page.entries = [
    {
      ...page.entries[0]!,
      name: 'review',
      workflow: {
        extensionId: 'builtin.skill-workflow',
        definitionVersion: '1',
        skillId: 'skill:review',
        name: 'review',
        revision: 'c'.repeat(64),
        state: 'available',
        reason: null,
        manualAllowed: true,
        emptyInputValid: true,
        contextMode: 'inline',
      },
    },
  ];
  let count = 0;
  const sent: Array<{ sessionId: string; request: Parameters<TuiPort['submit']>[1] }> = [];
  f.port.nextCommandId = () => `workflow-${++count}`;
  f.port.skills = { ...f.port.skills!, workflowActivation: true };
  f.port.skills!.read = async () => page;
  const receipt = (id: string, sessionId: string, kind = 'run.start') => ({
    id,
    sessionId,
    originStoreId: 'store',
    kind,
    status: 'accepted' as const,
    receipt: null,
    cancelRequestedAt: null,
  });
  f.port.submit = async (sessionId, request) => {
    sent.push({ sessionId, request });
    return receipt(request.commandId, sessionId, request.kind);
  };
  return { ...f, page, sent, receipt };
}
test('manual Workflow uses exact empty input, task content, fixed priority and active follow-up', async () => {
  const f = workflowFixture();
  await f.controller.select('a');
  f.controller.setDraft('/review inspect original text');
  await f.controller.send();
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]!.request).toEqual({
    kind: 'run.start',
    expectedStoreId: 'store',
    commandId: 'workflow-1',
    content: 'inspect original text',
    extensionInputs: [
      {
        extensionId: 'builtin.skill-workflow',
        definitionVersion: '1',
        input: {
          activations: [{ key: 'workflow-1', skillId: 'skill:review', input: {} }],
        },
      },
    ],
  });
  expect(
    Object.isFrozen(
      (f.sent[0]!.request as import('@kite-ai/client').StartCommandRequest).extensionInputs,
    ),
  ).toBe(true);
  expect(f.controller.state.draft).toBe('');
  f.page.entries[0]!.workflow!.name = 'skills';
  expect(manualWorkflow(f.page, 'skills')).toBeUndefined();
  f.controller.setDraft('/skills extra');
  await f.controller.send();
  expect(f.sent).toHaveLength(1);
  expect(f.controller.state.error).toBe('unexpected_command_arguments');
  f.page.entries[0]!.workflow!.name = 'review';
  f.controller.state.snapshot!.view.runs.push({
    id: 'active',
    isActive: true,
    status: 'running',
  } as never);
  f.controller.state.snapshot!.view.session.contextSelectionId = 'selection';
  f.controller.setDraft('/review');
  await f.controller.send();
  expect(f.sent[1]!.request).toMatchObject({
    kind: 'input.follow_up',
    afterRunId: 'active',
    contextSelectionId: 'selection',
    content: 'Run the review Skill Workflow.',
  });
  f.controller.dispose();
});
test('ambiguous, knowledge-only and unqualified Workflow never create work; candidates are visible in Ink', async () => {
  const f = workflowFixture();
  await f.controller.select('a');
  for (const transform of [
    () => {
      f.page.entries.push(structuredClone(f.page.entries[0]!));
    },
    () => {
      f.page.entries = [f.page.entries[0]!];
      f.page.entries[0]!.workflow!.emptyInputValid = false;
    },
    () => {
      delete f.page.entries[0]!.workflow;
    },
  ]) {
    transform();
    f.controller.setDraft('/review task');
    await f.controller.send();
    expect(f.sent).toHaveLength(0);
    expect(f.controller.state.draft).toBe('/review task');
  }
  const available = workflowFixture();
  await available.controller.select('a');
  await available.controller.openSkills();
  const ui = render(<TuiSession controller={available.controller} />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(ui.lastFrame()).toContain('/review [task]');
  expect(ui.lastFrame()).toContain('Read only · Use /name [task]');
  expect(available.sent).toHaveLength(0);
  ui.unmount();
  available.controller.dispose();
  f.controller.dispose();
});
test('lost Workflow response preserves original request/draft and lookup checks original kind without repost', async () => {
  const f = workflowFixture();
  await f.controller.select('a');
  const originalSubmit = f.port.submit;
  f.port.submit = async (sessionId, request) => {
    await originalSubmit(sessionId, request);
    throw Error('lost');
  };
  f.controller.setDraft('/review task');
  await f.controller.send();
  expect(f.controller.state.intent?.phase).toBe('unknown');
  expect(f.controller.state.draft).toBe('/review task');
  await f.controller.send();
  expect(f.sent).toHaveLength(1);
  const lookups: string[] = [];
  f.port.getCommand = async (id, sessionId) => {
    lookups.push(id);
    return f.receipt(id, sessionId, 'input.steer');
  };
  await f.controller.lookup();
  expect(f.controller.state.intent?.phase).toBe('unknown');
  expect(f.controller.state.draft).toBe('/review task');
  f.port.getCommand = async (id, sessionId) => {
    lookups.push(id);
    return f.receipt(id, sessionId);
  };
  await f.controller.select('b');
  f.controller.setDraft('new scope text');
  await f.controller.lookup();
  expect(lookups).toEqual(['workflow-1', 'workflow-1']);
  expect(f.sent).toHaveLength(1);
  expect(f.controller.state.draft).toBe('new scope text');
  expect(
    (f.sent[0]!.request as import('@kite-ai/client').StartCommandRequest).extensionInputs,
  ).toEqual([
    {
      extensionId: 'builtin.skill-workflow',
      definitionVersion: '1',
      input: { activations: [{ key: 'workflow-1', skillId: 'skill:review', input: {} }] },
    },
  ]);
  f.controller.dispose();
});
test('directory reads bind draft/generation and close or switch discards delayed activation', async () => {
  for (const action of ['edit', 'close', 'switch', 'dispose']) {
    const f = workflowFixture();
    await f.controller.select('a');
    f.controller.setDraft('/review task');
    let resolve!: (value: SkillCataloguePage) => void;
    f.port.skills!.read = () =>
      new Promise((done) => {
        resolve = done;
      });
    const pending = f.controller.send();
    if (action === 'edit') f.controller.setDraft('/review changed');
    if (action === 'close') f.controller.closePanel();
    if (action === 'switch') await f.controller.select('b');
    if (action === 'dispose') f.controller.dispose();
    resolve(f.page);
    await pending;
    expect(f.sent).toHaveLength(0);
    f.controller.dispose();
  }
});

test('a replaced catalogue read cannot activate from a later verified panel; concurrent send stays single', async () => {
  const f = workflowFixture();
  await f.controller.select('a');
  f.controller.setDraft('/review task');
  let finish!: (page: SkillCataloguePage) => void;
  f.port.skills!.read = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const sending = f.controller.send();
  await f.controller.send();
  f.port.skills!.read = async () => f.page;
  await f.controller.openSkills();
  expect(f.controller.state.skills?.read).toBe('verified');
  finish(f.page);
  await sending;
  expect(f.sent).toHaveLength(0);
  f.controller.closePanel();
  await f.controller.send();
  expect(f.sent).toHaveLength(1);
  f.controller.dispose();
});
test('capability absence, disabled Workflow, unknown read and changed selection fail without work', async () => {
  const f = workflowFixture();
  await f.controller.select('a');
  f.controller.setDraft('/review task');
  f.port.skills = { ...f.port.skills!, workflowActivation: false };
  let reads = 0;
  f.port.skills.read = async () => {
    reads++;
    return f.page;
  };
  await f.controller.send();
  expect(reads).toBe(0);
  expect(f.sent).toHaveLength(0);
  f.port.skills = { ...f.port.skills, workflowActivation: true };
  f.page.entries[0]!.workflow!.state = 'disabled';
  f.page.entries[0]!.workflow!.reason = 'workflow_disabled';
  await f.controller.send();
  expect(f.controller.state.error).toBe('workflow_disabled');
  f.page.entries[0]!.workflow!.state = 'available';
  f.page.entries[0]!.workflow!.reason = null;
  f.port.skills.read = async () => {
    throw Error('source lost');
  };
  await f.controller.send();
  expect(f.controller.state.skills?.read).toBe('unknown');
  expect(f.controller.state.error).toBe('skill_catalogue_unavailable');
  expect(f.sent).toHaveLength(0);
  let finish!: (page: SkillCataloguePage) => void;
  f.port.skills.read = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const sending = f.controller.send();
  const originalRead = f.port.readSession;
  f.port.readSession = async (id, signal) => {
    const result = await originalRead(id, signal);
    result.view.session.contextSelectionId = 'changed-selection';
    return result;
  };
  await f.controller.select('a');
  finish(f.page);
  await sending;
  expect(f.sent).toHaveLength(0);
  expect(f.controller.state.draft).toBe('/review task');
  f.controller.dispose();
});

test('Ink CtrlL recovers only the original lost Workflow receipt then refreshes without resubmission', async () => {
  const f = workflowFixture();
  await f.controller.select('a');
  f.controller.setDraft('/review original task');
  const submit = f.port.submit;
  f.port.submit = async (sessionId, request) => {
    await submit(sessionId, request);
    throw Error('lost response');
  };
  await f.controller.send();
  let lookups = 0;
  f.port.getCommand = async (id, sessionId) => {
    lookups++;
    return f.receipt(id, sessionId);
  };
  const ui = render(<TuiSession controller={f.controller} />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(ui.lastFrame()).toContain('unknown');
  ui.stdin.write('\u000c');
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(lookups).toBe(1);
  expect(f.sent).toHaveLength(1);
  expect(f.controller.state.intent?.phase).toBe('accepted');
  expect(f.controller.state.draft).toBe('');
  expect(ui.lastFrame()).toContain('workflow-1');
  ui.unmount();
  f.controller.dispose();
});

test('CtrlC while resolving a Workflow aborts only the read and cannot cancel the active original Run', async () => {
  const f = workflowFixture();
  await f.controller.select('a');
  f.controller.state.snapshot!.view.runs.push({
    id: 'active',
    originCommandId: 'original-run',
    isActive: true,
    status: 'running',
  } as never);
  f.controller.setDraft('/review task');
  let resolve!: (page: SkillCataloguePage) => void,
    signal!: AbortSignal,
    cancels = 0;
  f.port.cancel = async () => {
    cancels++;
    throw Error('unexpected cancellation');
  };
  f.port.skills!.read = (_id, _workspace, abort) => {
    signal = abort;
    return new Promise((done) => {
      resolve = done;
    });
  };
  const sending = f.controller.send();
  await f.controller.cancel();
  expect(signal.aborted).toBe(true);
  resolve(f.page);
  await sending;
  expect(cancels).toBe(0);
  expect(f.sent).toHaveLength(0);
  expect(f.controller.state.draft).toBe('/review task');
  f.controller.dispose();
});

test('a pending catalogue cannot post after another original interaction write becomes busy or unknown', async () => {
  for (const answerPhase of ['busy', 'unknown']) {
    const f = workflowFixture();
    await f.controller.select('a');
    f.controller.setDraft('/review task');
    const card = {
      id: 'approval',
      revision: '1',
      state: 'pending',
      kind: 'approval',
      originStoreId: 'store',
      presentationSessionId: 'a',
      request: { grants: ['approve_once'] },
      requiredRefs: [],
    } as unknown as import('@kite-ai/client').Interaction;
    const readSession = f.port.readSession;
    f.port.readSession = async (id, signal) => ({
      ...(await readSession(id, signal)),
      interactions: [card],
    });
    await f.controller.select('a');
    let readDone!: (page: SkillCataloguePage) => void,
      answerDone!: () => void,
      answers = 0;
    f.port.skills!.read = () =>
      new Promise((resolve) => {
        readDone = resolve;
      });
    f.port.answer = async () => {
      answers++;
      await new Promise<void>((resolve) => {
        answerDone = resolve;
      });
      throw Error('lost original answer');
    };
    const sending = f.controller.send();
    const answering = f.controller.answer(card, 'approve');
    if (answerPhase === 'unknown') {
      answerDone();
      await answering;
    }
    readDone(f.page);
    await sending;
    if (answerPhase === 'busy') {
      answerDone();
      await answering;
    }
    expect(answers).toBe(1);
    expect(f.sent).toHaveLength(0);
    expect(f.controller.state.intent?.kind).toBe('interaction.answer');
    expect(f.controller.state.intent?.phase).toBe('unknown');
    expect(f.controller.state.draft).toBe('/review task');
    f.controller.dispose();
  }
});
