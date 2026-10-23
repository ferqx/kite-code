import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatFileReadResult } from '../../../../packages/agent/src/tools/files/model-result';
import { taskQualityResearchPrompt } from './agent-task-quality.live';
import {
  taskQualityCompleteFixtureRead,
  taskQualityPresentedRead,
  taskQualityReadMessageMatches,
} from './agent-task-quality-fixture';
import {
  comparisonChildSource,
  comparisonChildSourceMatches,
  comparisonDigest,
  comparisonPairInvariant,
  comparisonWireRequestMatches,
  comparisonWorkspaceManifest,
  presentationComparisonPlan,
} from './agent-task-quality-presentation-ab-fixture';
import { loadTaskQualityReplay } from './agent-task-quality-replay-fixture';

test('offline replay rejects changed canonical bytes and never supplies a callable Provider', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-offline-integrity-'));
  try {
    const request = {
      modelId: 'live',
      requestId: 'original',
      messages: [{ role: 'user', content: 'synthetic task' }],
      tools: [],
    };
    const canonical = JSON.stringify([{ execution: { id: 'original' }, input: { request } }]);
    const body = JSON.stringify({ model: 'synthetic', messages: request.messages });
    writeFileSync(
      join(root, 'result.json'),
      JSON.stringify({
        canonical: { complete: true, sha256: createHash('sha256').update(canonical).digest('hex') },
        metrics: { usage: [], httpStatuses: [200] },
      }),
    );
    writeFileSync(join(root, 'original-requests.json'), JSON.stringify([request]));
    writeFileSync(join(root, 'canonical-model-evidence.json'), canonical);
    writeFileSync(
      join(root, 'model-binding.json'),
      JSON.stringify({ protocol: 'chat-completions' }),
    );
    writeFileSync(
      join(root, 'wire-requests.json'),
      JSON.stringify([
        { requestId: 'original', physicalIndex: 0, body, bytes: Buffer.byteLength(body) },
      ]),
    );
    const loaded = loadTaskQualityReplay(root);
    expect(() =>
      loaded.fixture.model.stream(request, { signal: new AbortController().signal }),
    ).toThrow('provider_forbidden_in_offline_regrade');
    writeFileSync(join(root, 'canonical-model-evidence.json'), `${canonical}\n`);
    expect(() => loadTaskQualityReplay(root)).toThrow('replay_original_canonical_hash_mismatch');
    writeFileSync(join(root, 'canonical-model-evidence.json'), canonical);
    writeFileSync(
      join(root, 'original-requests.json'),
      JSON.stringify([{ ...request, messages: [{ role: 'user', content: 'changed' }] }]),
    );
    expect(() => loadTaskQualityReplay(root)).toThrow(
      'replay_canonical_and_actual_request_mismatch',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('independent parser accepts actual production full/window/empty read rendering with from_line', () => {
  const text = '首行 🪁\npreview\n';
  const baseline = {
    hash: createHash('sha256').update(text).digest('hex'),
    size: Buffer.byteLength(text),
    device: '1',
    inode: '2',
  };
  for (const [content, selection, whole] of [
    [text, { fromLine: 1, toLine: 2, totalLines: 2, nextOffset: null }, true],
    ['preview\n', { fromLine: 2, toLine: 2, totalLines: 2, nextOffset: null }, false],
    ['', { fromLine: 3, toLine: null, totalLines: 2, nextOffset: null }, false],
    ['', { fromLine: 1, toLine: null, totalLines: 0, nextOffset: null }, true],
  ] as const) {
    const raw = JSON.stringify({
      path: 'config.txt',
      content,
      baseline,
      selection,
      executionId: 'read',
      runId: 'run',
    });
    const presented = formatFileReadResult({ result: { outcome: 'succeeded', content: raw } });
    expect(presented).toBeDefined();
    expect(taskQualityPresentedRead(presented!)).toEqual({
      evidenceRef: undefined,
      path: 'config.txt',
      content,
      baseline,
      selection,
      whole,
    });
    expect(taskQualityReadMessageMatches(presented!, raw)).toBe(true);
    expect(
      taskQualityReadMessageMatches(presented!.replace('\n', '\nevidence_ref="other"\n'), raw),
    ).toBe(false);
    const historical = presented!.replace('\n', '\nevidence_ref="read"\n');
    expect(taskQualityReadMessageMatches(historical, raw)).toBe(true);
    expect(presented).not.toContain('evidence_ref=');
    expect(
      taskQualityReadMessageMatches(
        presented!.replace(`from_line=${selection.fromLine}`, 'from_line=99'),
        raw,
      ),
    ).toBe(false);
    expect(taskQualityReadMessageMatches(`${presented}extra`, raw)).toBe(false);
  }
});

test('paired tasks retain the original already-run UTF-8 task bytes', () => {
  expect(
    createHash('sha256').update(taskQualityResearchPrompt('current-chain')).digest('hex'),
  ).toBe('0ce7cc19ca8294facd7df0ef7ebc687b85f084404662692f39d96ed75ea742cf');
  expect(
    createHash('sha256').update(taskQualityResearchPrompt('claim-adoption')).digest('hex'),
  ).toBe('aac55cf8a813b825462ee0e3b5a45d952de6ef3227bca544c496bbdf2a902bc8');
});

test('each wire request preserves role, order, full Tool/Source text and call identity', () => {
  const messages = [
    { role: 'system', content: 'fixed contract' },
    { role: 'user', content: 'task 🪁' },
    { role: 'assistant', content: '' },
    { role: 'tool', toolCallId: 'call-1', content: 'full read\npreview🪁\n' },
    { role: 'user', content: 'Child Source\nexact original body\nnot_verified' },
  ];
  const chat = {
    messages: messages.map((message) =>
      message.role === 'tool'
        ? { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
        : { role: message.role, content: message.content },
    ),
  };
  expect(comparisonWireRequestMatches({ messages }, JSON.stringify(chat), 'chat-completions')).toBe(
    true,
  );
  const response = {
    input: [
      { role: 'developer', content: 'fixed contract' },
      { role: 'user', content: [{ type: 'input_text', text: 'task 🪁' }] },
      { type: 'reasoning', encrypted_content: 'opaque' },
      { type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'full read\npreview🪁\n' },
      { role: 'user', content: [{ type: 'input_text', text: messages[4]!.content }] },
    ],
  };
  expect(comparisonWireRequestMatches({ messages }, JSON.stringify(response), 'responses')).toBe(
    true,
  );
  for (const changed of [
    {
      ...chat,
      messages: chat.messages.map((m, i) => (i === 3 ? { ...m, content: 'full read' } : m)),
    },
    { ...chat, messages: chat.messages.map((m, i) => (i === 3 ? { ...m, role: 'user' } : m)) },
    {
      ...chat,
      messages: chat.messages.map((m, i) => (i === 3 ? { ...m, tool_call_id: 'other-call' } : m)),
    },
    { ...chat, messages: [...chat.messages].reverse() },
  ])
    expect(
      comparisonWireRequestMatches({ messages }, JSON.stringify(changed), 'chat-completions'),
    ).toBe(false);
  expect(
    comparisonWireRequestMatches(
      { messages: [{ role: 'user', content: 'another request body' }] },
      JSON.stringify(chat),
      'chat-completions',
    ),
  ).toBe(false);
  expect(
    comparisonWireRequestMatches(
      { messages },
      JSON.stringify(response).replace('preview', 'stable'),
      'responses',
    ),
  ).toBe(false);
  expect(comparisonWireRequestMatches({ messages }, JSON.stringify(chat), 'unsupported')).toBe(
    false,
  );
});

test('fixed eight-trial plan balances raw/compact order without extra sampling', () => {
  expect(presentationComparisonPlan).toEqual([
    ['current-chain', 1, 'raw'],
    ['current-chain', 1, 'compact'],
    ['claim-adoption', 1, 'compact'],
    ['claim-adoption', 1, 'raw'],
    ['current-chain', 2, 'compact'],
    ['current-chain', 2, 'raw'],
    ['claim-adoption', 2, 'raw'],
    ['claim-adoption', 2, 'compact'],
  ]);
});

test('workspace manifest covers additions as well as modified fixture contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-ab-manifest-'));
  try {
    writeFileSync(join(root, 'input'), 'original');
    const original = comparisonWorkspaceManifest(root);
    expect(comparisonWorkspaceManifest(root)).toEqual(original);
    writeFileSync(join(root, 'unexpected'), 'new');
    expect(comparisonWorkspaceManifest(root).sha256).not.toBe(original.sha256);
    rmSync(join(root, 'unexpected'));
    writeFileSync(join(root, 'input'), 'changed');
    expect(comparisonWorkspaceManifest(root).sha256).not.toBe(original.sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pair invariant preserves exact initial system/task/tools/wire settings', () => {
  const body = {
    model: 'owned-fixture',
    reasoning_effort: 'high',
    messages: [{ role: 'user', content: 'task' }],
  };
  const input = {
    binding: { provider: 'synthetic' },
    firstRequest: {
      modelId: 'live',
      messages: [{ role: 'system', content: 'contract' }],
      tools: [{ id: 'read' }],
    },
    wire: [{ requestId: 'one', body: JSON.stringify(body) }],
  };
  const original = comparisonDigest(comparisonPairInvariant(input));
  expect(
    comparisonDigest(
      comparisonPairInvariant({
        ...input,
        wire: [{ requestId: 'two', body: JSON.stringify(body) }],
      }),
    ),
  ).toBe(original);
  for (const changed of [
    {
      ...input,
      firstRequest: { ...input.firstRequest, messages: [{ role: 'system', content: 'different' }] },
    },
    { ...input, firstRequest: { ...input.firstRequest, tools: [{ id: 'different' }] } },
    {
      ...input,
      wire: [{ requestId: 'one', body: JSON.stringify({ ...body, reasoning_effort: 'low' }) }],
    },
  ])
    expect(comparisonDigest(comparisonPairInvariant(changed))).not.toBe(original);
  expect(() =>
    comparisonPairInvariant({ ...input, wire: [{ requestId: null, body: JSON.stringify(body) }] }),
  ).toThrow('comparison_wire_identity_missing');
  expect(() =>
    comparisonPairInvariant({
      ...input,
      wire: [
        ...input.wire,
        { requestId: 'two', body: JSON.stringify({ ...body, model: 'changed' }) },
      ],
    }),
  ).toThrow('comparison_wire_model_parameters_changed');
});

test('complete read accepts raw and compact exact source, rejects window/body/identity loss', () => {
  const content = '标识 preview 🪁\n';
  const baseline = {
    hash: createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content),
    device: '1',
    inode: '2',
  };
  const raw = {
    path: 'config.txt',
    content,
    baseline,
    executionId: 'read-id',
    runId: 'run-id',
    selection: { fromLine: 1, toLine: 1, totalLines: 1, nextOffset: null },
  };
  const original = JSON.stringify(raw);
  const compact = `Read "config.txt"; from_line=1; lines=1-1/1; next_line=null; complete file.\nbaseline=${JSON.stringify(baseline)}\nContent (${Buffer.byteLength(content)} UTF-8 bytes; starts on next line):\n${content}`;
  const read = {
    id: 'read-id',
    callId: 'call-id',
    runId: 'run-id',
    definitionId: 'files.read',
    status: 'succeeded',
    input: { path: 'config.txt' },
    result: { outcome: 'succeeded', content: original },
  };
  const message = { role: 'tool', toolCallId: 'call-id', sourceIds: ['read-id'], content: compact };
  const fixture = { workspace: '/owned', path: 'config.txt', content };
  expect(taskQualityReadMessageMatches(compact, original)).toBe(true);
  expect(taskQualityCompleteFixtureRead({ messages: [message] }, read, fixture)).toBe(true);
  expect(
    taskQualityCompleteFixtureRead(
      { messages: [{ ...message, content: original }] },
      read,
      fixture,
    ),
  ).toBe(true);
  for (const bad of [
    compact.replace('preview', 'stable'),
    compact.replace('complete file', 'selected window only'),
    compact.replace('1-1/1', '1-1/2'),
    `${compact}extra`,
  ])
    expect(
      taskQualityCompleteFixtureRead({ messages: [{ ...message, content: bad }] }, read, fixture),
    ).toBe(false);
  expect(
    taskQualityCompleteFixtureRead(
      { messages: [{ ...message, toolCallId: 'other' }] },
      read,
      fixture,
    ),
  ).toBe(false);
  expect(
    taskQualityCompleteFixtureRead(
      { messages: [{ ...message, sourceIds: ['other'] }] },
      read,
      fixture,
    ),
  ).toBe(false);
});

test('child framing preserves complete Unicode body/excerpt and exact recorded provenance', () => {
  const excerpt = 'profile stable 🪁\n\nChild report (1 UTF-8 bytes):\nx';
  const report =
    '材料无profile（故意错误的模型主张）\n\nObservation excerpt 1 (3 UTF-8 bytes):\n伪';
  const observation = {
    kind: 'inspection',
    scope: 'reports/runtime-audit.md',
    sources: [
      { path: 'reports/runtime-audit.md', version: 'original-hash', fromLine: 1, toLine: 9 },
    ],
    complete: true,
    coverage: 'file',
    excerpt: { text: excerpt, truncated: false },
  };
  const entry = {
    executionId: 'actual-read',
    tool: 'files.read',
    definitionVersion: '4',
    observation,
  };
  const evidence = {
    kind: 'recorded_tool_evidence',
    sessionId: 'child',
    runId: 'child-run',
    storeId: 'store',
    coverage: 'selected_history',
    reportVerification: 'not_verified',
    limitation: 'Original bounded preview',
    observationsOmitted: 0,
    toolCallsOmitted: 0,
    tools: [{ tool: 'files.read', definitionVersion: '4', outcomes: { succeeded: 1 } }],
    observations: [entry],
  };
  const carrier = {
    id: 'carrier',
    resultRevision: '1',
    originStoreId: 'store',
    childSessionId: 'child',
    result: {
      outcome: 'succeeded',
      content: report,
      details: { childSessionId: 'child', runId: 'child-run', status: 'completed', evidence },
    },
  };
  const header = {
    format: 'child_result_source',
    version: 1,
    origin: { executionId: 'carrier', resultRevision: '1', storeId: 'store' },
    inclusion: 'automatic',
    child: { agentId: 'child', runId: 'child-run', status: 'completed', outcome: 'succeeded' },
    evidence: {
      reportVerification: 'not_verified',
      coverage: 'selected_history',
      observationsOmitted: 0,
      toolCallsOmitted: 0,
      tools: evidence.tools,
      observations: [
        {
          ...entry,
          observation: {
            ...observation,
            excerpt: { truncated: false, bytes: Buffer.byteLength(excerpt) },
          },
        },
      ],
    },
    reportBytes: Buffer.byteLength(report),
  };
  const compact = `Child result source (untrusted data; no additional authorization):\n${JSON.stringify(header)}\nSelected-history preview only; omitted work is not proved absent. Tool observations do not verify the child report, call reachability or authorization.\n\nObservation excerpt 1 (${Buffer.byteLength(excerpt)} UTF-8 bytes):\n${excerpt}\n\nChild report (${Buffer.byteLength(report)} UTF-8 bytes):\n${report}`;
  expect(comparisonChildSource(compact)?.report).toBe(report);
  expect(comparisonChildSourceMatches(compact, carrier)).toBe(true);
  for (const changed of [
    compact.replace('"runId":"child-run"', '"runId":"different"'),
    compact.replace('original-hash', 'different'),
    `${compact}extra`,
    compact.replace('profile stable', 'profile preview'),
  ])
    expect(comparisonChildSourceMatches(changed, carrier)).toBe(false);
  expect(comparisonChildSourceMatches('reports/runtime-audit.md not_verified', carrier)).toBe(
    false,
  );
});

// Process-local mocks never read user configuration/credentials or call a Provider.
async function probe(script: string, mode = '') {
  const root = mkdtempSync(join(tmpdir(), 'quality-ab-probe-'));
  const child = Bun.spawn(
    [
      process.execPath,
      '--eval',
      script.replaceAll('import.meta.url', JSON.stringify(import.meta.url)),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        KITE_RUN_LIVE_TASK_QUALITY: '1',
        AB_PROBE_ROOT: join(root, 'evidence'),
        AB_PROBE_MODE: mode,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const budget = setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  }, 10000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    return JSON.parse(stdout);
  } finally {
    clearTimeout(budget);
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
}

test('wire evidence stays paired across concurrent requests and preflight blocks dispatch', async () => {
  const result = await probe(`
import { mock } from 'bun:test';
let fetches = 0, closes = 0;
globalThis.fetch = Object.assign(async () => { fetches++; await Bun.sleep(2); return new Response('{}'); }, { preconnect() {} });
mock.module('@kite-ai/agent/config', () => ({ createCredentialVault: () => ({ resolve: async () => { throw Error('credential_forbidden'); } }), createOsCredentialBackend: () => ({}) }));
mock.module('@kite-ai/service/configuration', () => ({ parseModelPreset: () => ({ reasoningEffort:'high' }), createUserConfiguration: () => ({ read: () => ({ value: { modelId:'owned', models:[{ id:'owned', model:'synthetic', provider:'compatible', baseURL:'https://owned.invalid' }] } }) }) }));
mock.module('@kite-ai/ai/sdk', () => ({ createCompatibleModelBinding: value => value, createSdkModelAdapter: options => ({ async *stream(request) {
  try { await options.models.get('live').fetch('https://owned.invalid', { body:JSON.stringify({ model:'synthetic', input:request.requestId, tools:[] }) }); yield { type:'finish', reason:'stop', usage:{ inputTokens:2, outputTokens:1 } }; }
  finally { closes++; }
} }) }));
const { createLiveModelFixture } = await import(new URL('./live-model-fixture.ts', import.meta.url).href);
const fixture = await createLiveModelFixture({ requestLimit:5, timeoutMs:5000, captureWireRequests:true,
  beforeModelRequest(request) { if (request.requestId==='blocked') throw Error('preflight_denied'); } });
const consume = async id => { for await (const event of fixture.model.stream({ modelId:'live', requestId:id, messages:[], tools:[] }, { signal:AbortSignal.timeout(5000) })) {} };
await Promise.all([consume('a'), consume('b')]);
let blocked = false; try { await consume('blocked'); } catch (error) { blocked = error.message==='preflight_denied'; }
console.log(JSON.stringify({ fetches, closes, blocked, wire:fixture.wireRequests }));
`);
  expect(result.fetches).toBe(2);
  expect(result.closes).toBe(2);
  expect(result.blocked).toBe(true);
  expect(result.wire).toHaveLength(2);
  for (const entry of result.wire) {
    expect(JSON.parse(entry.body).input).toBe(entry.requestId);
    expect(entry.bytes).toBe(Buffer.byteLength(entry.body));
  }
}, 15000);

test('driver keeps planned quality failures but stops binding drift before dispatch', async () => {
  const script = `
import { mock } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
let attempts = 0, dispatches = 0;
globalThis.fetch = () => { throw Error('provider_forbidden'); };
mock.module(new URL('./agent-task-quality.live.ts', import.meta.url).href, () => ({ async runAgentTaskQualityTrial(options) {
  const n = ++attempts, comparison = options.isolatedComparison;
  const metadata = { protocol:'chat-completions', model:process.env.AB_PROBE_MODE==='drift' && n===3 ? 'changed':'synthetic', settings:{ reasoning:'high' } };
  const request = { modelId:'live', requestId:'request-'+n, messages:[{ role:'system', content:'contract '+comparison.workspace }, { role:'user', content:'fixed task '+options.scenario }], tools:[] };
  comparison.beforeModelRequest(request, metadata);
  const body = JSON.stringify({ model:'synthetic', reasoning_effort:'high', messages:request.messages, tools:[] });
  comparison.beforeWireRequest({ physicalIndex:0, requestId:request.requestId, body }); dispatches++;
  mkdirSync(options.evidenceRoot);
  writeFileSync(join(options.evidenceRoot,'original-requests.json'),JSON.stringify([request]));
  writeFileSync(join(options.evidenceRoot,'wire-requests.json'),JSON.stringify([{ requestId:request.requestId, body }]));
  return { evidenceRoot:options.evidenceRoot, status:n===1?'failed':'assertions_passed', failure:n===1?'synthetic_quality_assertion':undefined, cleanupErrors:[], evidenceErrors:[], canonical:{ complete:true }, metrics:{ httpStatuses:[200] }, comparison:{ modelBinding:metadata } };
} }));
const { runTaskQualityPresentationComparison } = await import(new URL('./agent-task-quality-presentation-ab.live.ts', import.meta.url).href);
const originalLog = console.log; console.log = () => {};
const summary = await runTaskQualityPresentationComparison(process.env.AB_PROBE_ROOT);
console.log = originalLog; console.log(JSON.stringify({ summary, attempts, dispatches }));
`;
  const quality = await probe(script);
  expect(quality.attempts).toBe(8);
  expect(quality.dispatches).toBe(8);
  expect(quality.summary.completedTrials).toBe(8);
  expect(quality.summary.status).toBe('failed');
  const drift = await probe(script, 'drift');
  expect(drift.attempts).toBe(3);
  expect(drift.dispatches).toBe(2);
  expect(drift.summary.completedTrials).toBe(2);
  expect(drift.summary.failure).toBe('comparison_model_binding_changed_before_dispatch');
}, 25000);
