import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createLoopOverview, type LoopOverviewNodeFactory } from './loop-flows.ts';

type Edge = { from: string; to: string; kind?: string };
type Fact = { id: string; raw?: string; recordKind?: string; derived?: string };
type Snapshot = {
  view: string;
  nodes: string[];
  edges: Edge[];
  nodeFacts: Fact[];
  step: number;
  selectedLog: string | null;
};
interface PrototypeWindow extends Window {
  __prototypeInspect(): Snapshot;
}
interface Message {
  role: string;
  sourceIds?: string[];
  content?: unknown;
}
interface EvidenceCase {
  id: string;
  sessions: { id: string }[];
  logs: {
    sessionId: string;
    cursor: string;
    objectId?: string;
    details?: { executionId?: string };
  }[];
  executions: {
    id: string;
    kind: string;
    callId?: string;
    sessionId: string;
    resultAcceptance?: { sourceId: string; runId: string; selectionId: string } | null;
    parentExecutionId?: string | null;
    authorization?: { policy?: { checkExecutionId?: string; sourceExecutionId?: string } };
  }[];
  models: {
    requestId: string;
    sessionId: string;
    runId: string;
    reviewInput?: {
      rootTaskIndex: number | null;
      currentTaskIndex: number | null;
      authorizationContext?: {
        availability: string;
        taskInputs: { content: string }[];
        executionBase: { cwd: string };
        recordedReads?: { path: string }[];
      };
      settings?: { maxOutputTokens?: number; reasoningEffort?: string };
    } | null;
  }[];
  toolMessageReceipts: {
    executionId: string;
    callId: string;
    receivedBy: string[];
    complete: boolean;
    message: Message;
  }[];
  sourceMessageReceipts: {
    sourceId: string;
    carrierExecutionId: string;
    sessionId: string;
    childSessionId: string | null;
    receivedBy: string[];
    message: Message;
    acceptance: { sourceId: string; runId: string; selectionId: string };
  }[];
  logReadProof: { storeMetadataUnchanged: boolean };
}

const directory = new URL('./', import.meta.url);
// The offline page embeds the function body; verify it without module closures as well.
const isolatedFactory = new Function(
  `return (${createLoopOverview.toString()});`,
)() as typeof createLoopOverview;
const makeNode: LoopOverviewNodeFactory = (id, title, lane, description, extra = {}) => ({
  id,
  title,
  lane,
  description,
  ...extra,
});
const sourceLineCounts = new Map<string, number>();
let isolatedCombinations = 0;
for (const actor of ['main', 'child', 'report']) {
  for (const scenario of isolatedFactory(makeNode).scenarios) {
    const graph = isolatedFactory(makeNode, scenario.id, actor);
    const ids = new Set(graph.nodes.map((node) => node.id));
    const cells = new Set<string>();
    assert.equal(ids.size, graph.nodes.length);
    assert(graph.nodes.length <= 20, 'Keep Loop scenarios readable');
    for (const node of graph.nodes) {
      assert(typeof node.implementation === 'string' && node.implementation.length > 0);
      const cell = `${node.lane}/${node.row}`;
      assert(!cells.has(cell), `Overlapping Loop nodes: ${scenario.id}/${cell}`);
      cells.add(cell);
      assert(Array.isArray(node.refs) && node.refs.length > 0);
      for (const reference of node.refs as { path: string; line: number }[]) {
        if (!sourceLineCounts.has(reference.path))
          sourceLineCounts.set(
            reference.path,
            (await readFile(new URL(`../../../../${reference.path}`, directory), 'utf8')).split(
              '\n',
            ).length,
          );
        assert(reference.line >= 1 && reference.line <= sourceLineCounts.get(reference.path)!);
      }
    }
    for (const edge of graph.edges) assert(ids.has(edge.from) && ids.has(edge.to));
    if (scenario.id === 'completion_pending_steer') {
      assert.deepEqual(scenario.actors, ['main']);
      assert.equal(
        graph.actor,
        'main',
        'Other actors are explicitly normalized to the root fixture',
      );
      assert(
        ids.has('completion_resource_wait'),
        'Approved completion resource waits stay observable',
      );
      assert(
        graph.edges.some(
          (edge) => edge.from === 'completion_resource_wait' && edge.to === 'retire_completion',
        ),
      );
      assert(!graph.edges.some((edge) => edge.from === 'completion_unknown'));
      assert(!graph.edges.some((edge) => edge.from === 'late_old_answer'));
    }
    isolatedCombinations++;
  }
}
const html = await readFile(new URL('index.html', directory), 'utf8');
const evidence: { cases: EvidenceCase[] } = JSON.parse(
  await readFile(new URL('evidence.json', directory), 'utf8'),
);
const consoleErrors: Error[] = [];
const scrollTargets: HTMLElement[] = [];
let compactViewport = false;
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => consoleErrors.push(error));
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: new URL('index.html', directory).href,
  virtualConsole,
  beforeParse(window) {
    window.scrollTo = () => {};
    window.HTMLElement.prototype.scrollIntoView = function () {
      scrollTargets.push(this);
    };
    window.matchMedia = (query) =>
      ({
        matches: query.includes('max-width') ? compactViewport : query.includes('reduced-motion'),
      }) as MediaQueryList;
  },
});
const window = dom.window as unknown as PrototypeWindow;
const document = window.document;
const inspect = () => window.__prototypeInspect();
const click = (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector);
  assert(element, `Missing ${selector}`);
  element.click();
};
const select = (id: string, value: string) => {
  const element = document.getElementById(id) as HTMLSelectElement | null;
  assert(element, `Missing #${id}`);
  assert([...element.options].some((option) => option.value === value && !option.disabled));
  element.value = value;
  element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
};
const fact = (id: string) => inspect().nodeFacts.find((item) => item.id === id);
const detailText = () => document.getElementById('log-detail-content')?.textContent ?? '';
const inputSearch = (value: string) => {
  const element = document.getElementById('log-search') as HTMLInputElement;
  element.value = value;
  element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};
function assertSelectedStep() {
  const current = inspect();
  const selected = document.querySelector<HTMLElement>('.node.selected')?.dataset.node;
  assert(selected, 'A visible graph node is selected');
  assert.equal(
    current.nodes.indexOf(selected),
    current.step,
    'Selection and playback share an index',
  );
  assert.equal(
    document.querySelector('.step-count')?.textContent,
    `${current.step + 1} / ${current.nodes.length}`,
    'Visible progress describes the selected node',
  );
}
function assertGraph() {
  const snapshot = inspect();
  assert.equal(new Set(snapshot.nodes).size, snapshot.nodes.length, 'Unique node identities');
  for (const edge of snapshot.edges) {
    assert(snapshot.nodes.includes(edge.from), `Unknown edge source ${edge.from}`);
    assert(snapshot.nodes.includes(edge.to), `Unknown edge target ${edge.to}`);
  }
  for (const node of snapshot.nodeFacts) {
    if (node.recordKind === 'run' && node.raw)
      assert(
        [
          'running',
          'waiting_interaction',
          'waiting_execution',
          'cancelling',
          'completed',
          'failed',
          'cancelled',
          'interrupted',
        ].includes(node.raw),
        `Invalid Run state ${node.raw}`,
      );
  }
}
function controlPath(from: string, to: string) {
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === to) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    return inspect().edges.some(
      (edge) =>
        edge.from === id && !['return', 'observation'].includes(edge.kind ?? '') && visit(edge.to),
    );
  };
  return visit(from);
}

try {
  assert.equal(consoleErrors.length, 0, consoleErrors.map((error) => error.message).join('\n'));
  assert.equal(inspect().view, 'loop', 'Project Loop is the entry view');
  const scenarios = [...document.querySelectorAll<HTMLOptionElement>('#loop-scenario option')].map(
    (option) => option.value,
  );
  let loopCombinations = 0;
  for (const actor of ['main', 'child', 'report']) {
    select('loop-actor', actor);
    for (const scenario of scenarios) {
      const option = document.querySelector<HTMLOptionElement>(
        `#loop-scenario option[value="${scenario}"]`,
      );
      if (option?.disabled) continue;
      select('loop-scenario', scenario);
      assertGraph();
      if (actor !== 'main') {
        assert(!inspect().nodes.includes('before'));
        assert(!inspect().nodes.includes('before_complete'));
      }
      loopCombinations++;
    }
  }
  select('loop-actor', 'main');
  select('loop-scenario', 'batch_success');
  assert(controlPath('a_gate', 'b_gate'), 'A dispatch releases B admission');
  assert(!controlPath('a_result', 'b_gate'), 'B does not wait for A completion');
  assert(controlPath('a_result', 'join') && controlPath('b_result', 'join'));
  assert(controlPath('join', 'next'), 'The whole batch precedes the next Model boundary');
  select('loop-scenario', 'auto_timeout');
  assert(controlPath('a_gate', 'b_gate') && controlPath('join', 'next'));
  click('[data-node="a_gate"]');
  assert.match(document.getElementById('node-detail')?.textContent ?? '', /3000ms|3000/);
  assert.match(document.getElementById('node-detail')?.textContent ?? '', /timeout_continue/);
  assert.match(document.getElementById('node-detail')?.textContent ?? '', /晚到/);
  click('#open-tool');
  assert.equal((document.getElementById('branch') as HTMLSelectElement).value, 'auto_timeout');
  assert(fact('review_timeout') && !fact('allow') && !fact('unavailable'));
  assert(controlPath('review_timeout', 'recheck') && controlPath('recheck', 'receipt'));
  click('[data-node="review_timeout"]');
  assert.match(document.getElementById('node-detail')?.textContent ?? '', /filesystem.*network/);
  assert.match(document.getElementById('node-detail')?.textContent ?? '', /晚到/);
  select('branch', 'auto_reuse');
  assert(fact('review_reuse') && !fact('check'));
  assert(controlPath('review_reuse', 'recheck'));
  select('operation', 'launch');
  assert(fact('review_reuse') && fact('job_auth'));
  assert(!controlPath('next', 'job_auth'));
  click('[data-mode="full"]');
  assert(!fact('check') && !fact('review_timeout') && !fact('review_reuse'));
  assert(controlPath('full', 'recheck'));
  click('[data-view="loop"]');
  select('loop-scenario', 'authority_failure');
  assert(!inspect().nodes.includes('next'), 'Missing durable receipts cannot continue Model');
  select('loop-scenario', 'run_cancel');
  assert.equal(fact('cancelled_run')?.raw, 'cancelled');
  assert(!inspect().nodes.includes('next'), 'Run cancellation stops the next Model');
  assert(inspect().edges.some((edge) => edge.to === 'cancel_run' && edge.kind === 'input'));
  select('loop-scenario', 'completion_pending_steer');
  assert.equal(fact('retire_completion')?.raw, 'cancelled');
  assert.equal(fact('fresh_completion')?.raw, 'planned');
  assert.equal(fact('completion_settled')?.raw, 'completed');
  assert(controlPath('completion_steer', 'retire_completion'));
  assert(controlPath('dispatch_pending', 'retire_completion'));
  assert.equal(fact('completion_resource_wait')?.raw, 'planned');
  assert(controlPath('governance_pending', 'completion_resource_wait'));
  assert(controlPath('completion_resource_wait', 'retire_completion'));
  assert(
    !controlPath('completion_resource_wait', 'fresh_effect'),
    'Leaving an old resource wait still requires Loop refresh and a fresh approval',
  );
  assert(
    inspect().edges.some(
      (edge) =>
        edge.from === 'refresh_completion' &&
        edge.to === 'fresh_completion' &&
        edge.kind === 'return',
    ),
    'Completion retirement re-enters the existing Loop before fresh preparation',
  );
  assert(controlPath('fresh_completion', 'fresh_approval'));
  assert(controlPath('fresh_approval', 'fresh_effect'));
  assert(!controlPath('late_old_answer', 'fresh_effect'), 'Old answers cannot approve fresh calls');
  assert.equal(fact('completion_unknown')?.raw, 'failed');
  assert(controlPath('dispatched_completion', 'completion_unknown'));
  assert(
    !inspect().edges.some((edge) => edge.from === 'completion_unknown'),
    'Actual unknown effects cannot continue or replay completion',
  );
  select('loop-scenario', 'completion');
  assert(controlPath('conditions', 'finish') && controlPath('finish', 'completed'));
  select('loop-scenario', 'resume');
  assert(!controlPath('response', 'model'), 'Restored successful Model is not replayed');

  click('[data-view="approval"]');
  select('family', 'shell');
  select('operation', 'execute');
  click('[data-mode="auto"]');
  select('branch', 'manual_ceiling');
  assert(controlPath('allow', 'ceiling_human') && controlPath('ceiling_human', 'recheck'));
  click('[data-mode="accept_edits"]');
  select('branch', 'grant_reuse');
  assert(fact('grant_match') && !fact('human'));
  select('branch', 'grant_other_session');
  assert(controlPath('grant_miss', 'human'));
  select('operation', 'read');
  select('branch', 'observed_failed');
  assert.equal(fact('observed_job')?.raw, 'failed');
  assert.equal(fact('receipt')?.raw, 'succeeded');
  select('operation', 'launch');
  select('branch', 'job_reject');
  assert.equal(fact('receipt')?.raw, 'succeeded');
  assert.equal(fact('job_deny')?.raw, 'failed');
  assert(!controlPath('next', 'job_auth'), 'The next Model is not a Job start dependency');

  click('[data-view="child"]');
  const branches = [...document.querySelectorAll<HTMLOptionElement>('#child-branch option')].map(
    (option) => option.value,
  );
  for (const branch of branches) {
    select('child-branch', branch);
    assertGraph();
    assert(!controlPath('accepted', 'slot'), 'Child activation is independent of Tool result');
    assert(controlPath('spawn', 'slot'));
  }
  select('child-branch', 'active');
  assert(!fact('idle_auth') && fact('checkpoint'));
  select('child-branch', 'deferred_input');
  assert.equal(fact('settle')?.raw, 'succeeded');
  assert.equal(fact('deferred')?.derived, 'deferred / pending');
  select('child-branch', 'suppressed');
  assert.equal(fact('settle')?.raw, 'succeeded');
  assert.equal(fact('suppressed')?.raw, undefined);

  click('[data-view="catalog"]');
  assert.equal(document.querySelector('[data-open-family="execution-evidence"]'), null);
  assert.match(document.body.textContent ?? '', /通用执行回执模型入口已退役/);
  click('[data-view="loop"]');
  select('loop-scenario', 'compression');
  click('[data-node="compress"]');
  assert.match(document.getElementById('node-detail')?.textContent ?? '', /不创建新Run/);
  click('[data-node="publish"]');
  assert.match(document.getElementById('node-detail')?.textContent ?? '', /通用回执模型入口已退役/);
  assert.match(
    document.getElementById('node-detail')?.textContent ?? '',
    /累计checkpoint|累计checkpoint清单/,
  );

  let sourceCount = 0;
  let sourceReceptions = 0;
  let omittedToolMessages = 0;
  for (const item of evidence.cases) {
    assert(item.logReadProof.storeMetadataUnchanged);
    const executions = new Map(item.executions.map((execution) => [execution.id, execution]));
    const models = new Map(item.models.map((model) => [model.requestId, model]));
    const cursorKeys = new Set<string>();
    for (const log of item.logs) {
      BigInt(log.cursor);
      const key = `${log.sessionId}:${log.cursor}`;
      assert(!cursorKeys.has(key));
      cursorKeys.add(key);
    }
    for (const receipt of item.toolMessageReceipts) {
      const execution = executions.get(receipt.executionId);
      assert(execution && execution.callId === receipt.callId);
      for (const modelId of receipt.receivedBy)
        assert.equal(models.get(modelId)?.sessionId, execution.sessionId);
      if (!receipt.complete && !('sourceCaseId' in item)) omittedToolMessages++;
    }
    for (const receipt of item.sourceMessageReceipts) {
      const carrier = executions.get(receipt.carrierExecutionId);
      assert.equal(carrier?.resultAcceptance?.sourceId, receipt.sourceId);
      assert.deepEqual(carrier?.resultAcceptance, receipt.acceptance);
      assert.equal(receipt.message.role, 'user');
      assert(receipt.message.sourceIds?.includes(receipt.sourceId));
      for (const modelId of receipt.receivedBy)
        assert.equal(models.get(modelId)?.sessionId, receipt.sessionId);
      if (!('sourceCaseId' in item)) {
        sourceCount++;
        sourceReceptions += receipt.receivedBy.length;
      }
    }
  }
  assert.equal(sourceCount, 48);
  assert.equal(sourceReceptions, 257);
  assert.equal(omittedToolMessages, 4);

  const appended = evidence.cases.filter((item) => 'sourceCaseId' in item) as (EvidenceCase & {
    sourceCaseId: string;
    displayId: string;
    outcome: {
      runs: { status: string; isActive: boolean }[];
      assertionStatus: string;
      failure: string | null;
      failedChecks: string[];
    };
    source: { codeBefore: unknown; codeAfter: unknown; codeUnchanged: boolean };
    models: {
      requestId: string;
      sessionId: string;
      runId: string;
      purpose: string;
      outputAvailability: string;
      reviewTargetExecutionId?: string | null;
      code: string | null;
      incomplete: boolean | null;
      outputEvidence: { complete: boolean };
    }[];
  })[];
  assert.equal(new Set(evidence.cases.map((item) => item.id)).size, evidence.cases.length);
  for (const item of appended) {
    assert.equal(item.id, item.displayId);
    assert(item.id.endsWith(`::${item.sourceCaseId}`));
    assert(item.source.codeBefore && item.source.codeAfter);
    assert.equal(item.source.codeUnchanged, true);
    assert(item.outcome.runs.length > 0);
    const originals = new Map(item.executions.map((execution) => [execution.id, execution]));
    for (const execution of item.executions) {
      const policy = execution.authorization?.policy;
      if (!policy?.checkExecutionId) continue;
      const reviewer = originals.get(policy.checkExecutionId);
      assert.equal(reviewer?.kind, 'model');
      assert.equal(reviewer?.parentExecutionId, policy.sourceExecutionId);
    }
    for (const model of item.models) {
      if (model.purpose === 'authorization_check')
        assert.equal(
          model.reviewTargetExecutionId,
          originals.get(model.requestId)?.parentExecutionId,
        );
      if (model.outputAvailability === 'no_canonical_output') {
        assert.equal(model.outputEvidence.complete, false);
        assert(model.code || model.incomplete);
      }
      const compact = model.reviewInput?.authorizationContext;
      if (compact?.availability === 'available') {
        assert(compact.taskInputs.length > 0);
        assert(compact.executionBase.cwd.length > 0);
        assert(Number.isInteger(model.reviewInput!.rootTaskIndex));
        assert(Number.isInteger(model.reviewInput!.currentTaskIndex));
        assert(!('decisionContext' in model.reviewInput!));
      }
    }
  }
  const semanticCase = appended.find((item) => 'semanticReview' in item);
  if (semanticCase) {
    click('[data-view="logs"]');
    select('log-case', semanticCase.id);
    const original = document.querySelector<HTMLDetailsElement>('[data-semantic-review-original]');
    assert(
      original && !original.open,
      'Detailed semantic source is present and collapsed by default',
    );
    assert.match(
      document.querySelector('[data-case-outcome]')?.textContent ?? '',
      /独立语义复核结论/,
    );
    assert(original.querySelector('pre')?.textContent?.includes('sourceReportSha256'));
  }
  const failedCompleted = appended.find(
    (item) =>
      item.outcome.assertionStatus === 'failed' &&
      item.outcome.runs.some((run) => run.status === 'completed'),
  );
  if (appended.length) {
    assert(failedCompleted, 'Retain completed Run with failed business assertions');
    click('[data-view="logs"]');
    select('log-case', failedCompleted.id);
    const outcomeText = document.querySelector('[data-case-outcome]')?.textContent ?? '';
    assert(outcomeText.includes('completed') && outcomeText.includes('failed'));
    assert(outcomeText.includes(failedCompleted.outcome.failure!));
    assert.match(outcomeText, /manualReviewRequired/);
    assert.match(outcomeText, /assertions_passed.*机械断言/);
    const timeoutCase = appended.find((item) =>
      item.models.some((model) => model.code === 'authorization_check_timeout'),
    );
    assert(timeoutCase, 'Real timeout models without outputs remain selectable');
    const timeout = timeoutCase.models.find(
      (model) => model.code === 'authorization_check_timeout',
    )!;
    assert.equal(timeout.purpose, 'authorization_check');
    select('log-case', timeoutCase.id);
    select('execution-picker', timeout.requestId);
    click('[data-log-tab="model"]');
    assert.match(
      document.getElementById('log-detail-content')?.textContent ?? '',
      /authorization_check_timeout/,
    );
    const compactCase = appended.find((item) =>
      item.models.some((model) => model.reviewInput?.authorizationContext),
    );
    if (compactCase) {
      const model = compactCase.models.find((entry) => entry.reviewInput?.authorizationContext)!;
      select('log-case', compactCase.id);
      select('execution-picker', model.requestId);
      click('[data-log-tab="model"]');
      const summary = document.querySelector('[data-review-material]')?.textContent ?? '';
      assert.match(summary, /本次审核材料/);
      assert(summary.includes(model.reviewInput!.authorizationContext!.executionBase.cwd));
      if (model.reviewInput!.settings?.maxOutputTokens === undefined)
        assert.match(summary, /原记录未提供该参数/);
      if (model.reviewInput!.authorizationContext!.recordedReads === undefined)
        assert.match(summary, /已读材料原记录未提供/);
      assert.match(summary, /缺失不补成256/);
    }
  }
  click('[data-view="logs"]');
  select('log-case', 'natural-child-full');
  const childCase = evidence.cases.find((item) => item.id === 'natural-child-full')!;
  const source = childCase.sourceMessageReceipts.find((item) => item.childSessionId)!;
  select('source-picker', source.sourceId);
  assert(
    document.getElementById('log-detail-content')?.textContent?.includes('Child result source'),
  );
  click(`[data-model-jump][data-source-id="${source.sourceId}"]`);
  assert(
    document.getElementById('log-detail-content')?.textContent?.includes(source.receivedBy[0]!),
  );
  assert(document.getElementById('log-detail-content')?.textContent?.includes(source.sourceId));

  let interactionRegressions = 0;
  // A graph handoff may reset playback, but can never retain an unrelated numeric index.
  click('[data-view="tool"]');
  select('family', 'shell');
  select('operation', 'execute');
  click('[data-mode="auto"]');
  select('branch', 'approve');
  click('[data-view="loop"]');
  select('loop-scenario', 'batch_success');
  click('[data-node="next"]');
  click('[data-view="tool"]');
  assertSelectedStep();
  const beforeNext = inspect();
  if (!(document.getElementById('next') as HTMLButtonElement).disabled) {
    click('#next');
    assertSelectedStep();
    assert.equal(inspect().step, beforeNext.step + 1, 'Next cannot jump backward after a handoff');
  }
  click('[data-view="loop"]');
  select('loop-scenario', 'human_deny');
  click('#open-tool');
  assert.equal((document.getElementById('branch') as HTMLSelectElement).value, 'reject');
  assert.equal(fact('receipt')?.raw, 'failed', 'A denied Loop branch opens its denied Tool path');
  interactionRegressions++;

  click('[data-mode="accept_edits"]');
  select('branch', 'mode_change');
  assert(fact('reroute'), 'The mode-change scenario waits for an explicit target mode');
  click('[data-mode="full"]');
  assert(!fact('reroute') && fact('recheck') && fact('receipt'));
  assert(controlPath('full', 'recheck'), 'Full still reaches final dispatch verification');
  click('[data-mode="accept_edits"]');
  select('branch', 'mode_change');
  click('[data-mode="auto"]');
  assert(!fact('reroute') && fact('recheck') && fact('receipt'));
  assert(controlPath('allow', 'recheck'), 'Auto approval returns to final verification');
  interactionRegressions++;

  click('[data-view="loop"]');
  select('loop-actor', 'main');
  select('loop-scenario', 'completion_pending_steer');
  for (const actor of ['child', 'report'])
    assert(
      document.querySelector<HTMLOptionElement>(`#loop-actor option[value="${actor}"]`)?.disabled,
      'A root-only scenario cannot silently accept another actor',
    );
  assert.match(document.getElementById('loop-actor-limit')?.textContent ?? '', /根|main/);
  interactionRegressions++;

  click('[data-view="tool"]');
  select('family', 'shell');
  select('operation', 'execute');
  select('branch', 'approve');
  const finalLeaf = inspect()
    .nodes.filter((id) => id.startsWith('leaf_'))
    .at(-1)!;
  click(`[data-node="${finalLeaf}"]`);
  assert.equal(document.getElementById(`node-${finalLeaf}`)?.style.gridColumn, '5');
  assert.match(document.getElementById('node-detail')?.textContent ?? '', /exitCode/);
  assert.match(document.getElementById('node-detail')?.textContent ?? '', /停止确认/);
  select('operation', 'launch');
  assert.equal(document.getElementById('node-job_terminal')?.style.gridColumn, '5');
  click('[data-node="accepted_tool"]');
  assert.match(document.getElementById('node-detail')?.textContent ?? '', /只证明受理/);
  interactionRegressions++;

  // Navigation must use the current view's actor, not the last Tool-view selection.
  select('actor', 'main');
  select('operation', 'execute');
  click('[data-mode="accept_edits"]');
  select('branch', 'job_reject');
  click('[data-view="child"]');
  select('child-branch', 'active');
  click('#flow-log');
  const selectedCaseId = () => (document.getElementById('log-case') as HTMLSelectElement).value;
  const navigationContext = () => document.querySelector('.callout.info strong')?.textContent ?? '';
  assert.match(navigationContext(), /child|子 Agent/);
  assert.doesNotMatch(navigationContext(), /shell_execute|shell\.execute/);
  assert(
    evidence.cases
      .find((item) => item.id === selectedCaseId())!
      .sourceMessageReceipts.some((receipt) => receipt.childSessionId),
    'Background navigation opens a case containing an actual child report',
  );
  click('[data-view="loop"]');
  select('loop-scenario', 'batch_success');
  select('loop-actor', 'child');
  click('#flow-log');
  assert.match(navigationContext(), /子 Agent/);
  assert.doesNotMatch(navigationContext(), /主 Agent/);
  interactionRegressions++;

  const sourceCase = evidence.cases.find((item) =>
    item.sourceMessageReceipts.some(
      (receipt) =>
        receipt.childSessionId &&
        receipt.receivedBy.length > 0 &&
        item.logs.some((log) => log.objectId === receipt.sourceId),
    ),
  )!;
  const tracedSource = sourceCase.sourceMessageReceipts.find(
    (receipt) =>
      receipt.childSessionId &&
      receipt.receivedBy.length > 0 &&
      sourceCase.logs.some((log) => log.objectId === receipt.sourceId),
  )!;
  select('log-case', sourceCase.id);
  inputSearch('');
  select('source-picker', tracedSource.sourceId);
  const unrelatedTool = sourceCase.executions.find(
    (execution) =>
      execution.kind === 'tool' &&
      !sourceCase.sourceMessageReceipts.some(
        (receipt) => receipt.carrierExecutionId === execution.id,
      ),
  )!;
  select('execution-picker', unrelatedTool.id);
  click('[data-log-tab="model"]');
  assert(detailText().includes(unrelatedTool.id));
  assert(
    !detailText().includes(tracedSource.sourceId),
    'Old source focus cannot invent a Tool relation',
  );
  assert.equal((document.getElementById('source-picker') as HTMLSelectElement).value, '');
  interactionRegressions++;

  click('[data-log-tab="approval"]');
  const trace = document.querySelector('[data-approval-trace]');
  assert(trace, 'Historical records keep an explicit observation section');
  assert.match(trace.textContent ?? '', /未记录（历史原件不补造）/);
  for (const field of [
    'prepareMs',
    'queueMs',
    'providerMs',
    'totalMs',
    'policyEvidenceId',
    'requestedScope',
    'effectiveScope',
  ])
    assert((trace.textContent ?? '').includes(field), `Missing observation field ${field}`);
  click('[data-log-tab="model"]');
  inputSearch(tracedSource.sourceId);
  const sourceLog = sourceCase.logs.find((log) => log.objectId === tracedSource.sourceId)!;
  click(`[data-log="${sourceLog.sessionId}:${sourceLog.cursor}"]`);
  click('[data-log-tab="model"]');
  assert.equal(
    inspect().selectedLog,
    `${sourceLog.sessionId}:${sourceLog.cursor}`,
    'Source navigation retains the original event identity',
  );
  assert(detailText().includes(tracedSource.sourceId));
  assert(detailText().includes(tracedSource.carrierExecutionId));
  click(`[data-model-jump][data-source-id="${tracedSource.sourceId}"]`);
  assert(detailText().includes(tracedSource.receivedBy[0]!));
  assert(detailText().includes(tracedSource.sourceId));
  interactionRegressions++;

  const originalCall = sourceCase.executions.find(
    (execution) =>
      execution.kind === 'tool' &&
      execution.callId &&
      sourceCase.logs.some((log) => (log.details?.executionId ?? log.objectId) === execution.id),
  )!;
  inputSearch(originalCall.callId!);
  const matchedRows = [...document.querySelectorAll<HTMLElement>('[data-log]')];
  const expectedEvents = sourceCase.logs.filter(
    (log) => (log.details?.executionId ?? log.objectId) === originalCall.id,
  );
  assert(expectedEvents.length > 0 && matchedRows.length >= expectedEvents.length);
  assert(
    expectedEvents.every((log) =>
      matchedRows.some((row) => row.dataset.log === `${log.sessionId}:${log.cursor}`),
    ),
    'A call ID copied from Model output finds the original Tool events',
  );
  interactionRegressions++;

  const inspectorWasRevealed = () =>
    scrollTargets.some((target) => target.matches('.log-detail, .log-detail .content')) ||
    !!document.activeElement?.closest('.log-detail');
  inputSearch('');
  compactViewport = true;
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 390 });
  scrollTargets.length = 0;
  click('[data-log]');
  await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  assert(inspectorWasRevealed(), 'A stacked mobile inspector is revealed after selecting an event');
  compactViewport = false;
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 1440 });
  scrollTargets.length = 0;
  click('[data-log]');
  await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  assert(!inspectorWasRevealed(), 'Desktop event selection does not move focus into the inspector');
  interactionRegressions++;

  // Private in-memory renderer fixture: never save fabricated observations to evidence.json.
  const probeEvidence = JSON.parse(JSON.stringify(evidence));
  const probeCase = probeEvidence.cases[0];
  const probeExecution = probeCase.executions.find(
    (entry: { kind: string }) => entry.kind === 'tool',
  );
  probeExecution.authorization = {
    dispatched: true,
    policy: {
      evidenceId: 'fixture-policy-evidence',
      reason: 'timeout_continue',
      sourceExecutionId: 'fixture-origin',
      requestedScope: { filesystem: 'full_access', network: 'internet' },
      effectiveScope: { filesystem: 'full_access', network: 'internet' },
    },
    timing: {
      budgetMs: 3000,
      startedAt: 1000,
      deadlineAt: 4000,
      prepareMs: 20,
      queueMs: 2980,
      providerMs: 0,
      totalMs: 3000,
    },
  };
  const probeHtml = html.replace(
    /(<script id="evidence-data" type="application\/json">)[\s\S]*?(<\/script>)/,
    (_match, start, end) => start + JSON.stringify(probeEvidence).replace(/</g, '\\u003c') + end,
  );
  const probeDom = new JSDOM(probeHtml, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: new URL('index.html', directory).href,
    beforeParse(w) {
      w.scrollTo = () => {};
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.matchMedia = () => ({ matches: false }) as MediaQueryList;
    },
  });
  try {
    const d = probeDom.window.document;
    d.querySelector<HTMLElement>('[data-view="logs"]')!.click();
    const picker = d.getElementById('execution-picker') as HTMLSelectElement;
    picker.value = probeExecution.id;
    picker.dispatchEvent(new probeDom.window.Event('change', { bubbles: true }));
    d.querySelector<HTMLElement>('[data-log-tab="approval"]')!.click();
    const text = d.querySelector('[data-approval-trace]')!.textContent ?? '';
    for (const expected of [
      'fixture-policy-evidence',
      'timeout_continue',
      'full_access',
      'internet',
      '2980',
      '3000',
    ])
      assert(text.includes(expected), `Observed field is rendered: ${expected}`);
    assert(
      !text.includes('[object Object]'),
      'Structured requested/effective scopes remain legible',
    );
  } finally {
    probeDom.window.close();
  }

  assert.equal(consoleErrors.length, 0, consoleErrors.map((error) => error.message).join('\n'));
  console.log(
    JSON.stringify({
      loopCombinations,
      isolatedCombinations,
      sourceCount,
      sourceReceptions,
      omittedToolMessages,
      interactionRegressions,
      status: 'passed',
    }),
  );
} finally {
  dom.window.close();
}
