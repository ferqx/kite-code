import type { ModelMessage } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { shellOperationKey } from '../../../src/shell-input';
import type { ExecutionRecord, Json } from '../../../src/storage/types';
import {
  childToolEvidence,
  type ToolObservation,
  toolObservation,
} from '../../../src/tool-observations';

const identity = { sessionId: 'child', runId: 'current', storeId: 'store' };
const lookup = (): ToolObservation => ({
  kind: 'lookup',
  scope: 'src',
  query: 'literal',
  sources: [],
  matchCount: 0,
  complete: true,
  coverage: 'page',
});
const inspection = (): ToolObservation => ({
  kind: 'inspection',
  scope: 'src/entry.ts',
  sources: [{ path: 'src/entry.ts', version: 'a'.repeat(64), fromLine: 1, toLine: 4 }],
  complete: true,
  coverage: 'file',
});
function pair(id: string, tool = 'lookup', content = 'untrusted displayed body'): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `call-${id}`, name: tool, arguments: '{}' }],
    },
    { role: 'tool', toolCallId: `call-${id}`, sourceIds: [id], content },
  ];
}
function record(
  id: string,
  observation = lookup(),
  overrides: Partial<ExecutionRecord> = {},
): ExecutionRecord {
  return {
    id,
    kind: 'tool',
    sessionId: identity.sessionId,
    runId: identity.runId,
    originStoreId: identity.storeId,
    callId: `call-${id}`,
    definitionId: 'lookup',
    definitionVersion: '3',
    status: 'succeeded',
    result: { outcome: 'succeeded', content: JSON.stringify({ observation }) },
    ...overrides,
  } as ExecutionRecord;
}
test('observations validate bounded line identities without treating malformed JSON as evidence', () => {
  expect(toolObservation(JSON.stringify({ observation: inspection() }))).toEqual(inspection());
  const withExcerpt = {
    ...inspection(),
    excerpt: { text: 'original preview 雪🙂', truncated: false },
  };
  expect(toolObservation(JSON.stringify({ observation: withExcerpt }))).toEqual(withExcerpt);
  expect(
    toolObservation(JSON.stringify({ observation: { ...lookup(), matchUnit: 'files' } })),
  ).toEqual({ ...lookup(), matchUnit: 'files' });
  for (const observation of [
    { ...inspection(), complete: 'yes' },
    { ...lookup(), matchCount: -1 },
    { ...lookup(), matchUnit: 'repositories' },
    { ...inspection(), sources: [{ path: 'a', version: 'v', fromLine: 4, toLine: 2 }] },
    { ...inspection(), sources: [{ path: 'a', version: '' }] },
    { ...inspection(), excerpt: { text: 'not a complete descriptor' } },
    { ...inspection(), excerpt: { text: 7, truncated: false } },
  ])
    expect(toolObservation(JSON.stringify({ observation }))).toBeUndefined();
  expect(toolObservation('not JSON')).toBeUndefined();
});

test('child evidence binds exact current scope and call provenance, deduplicates executions, and keeps definition versions distinct', async () => {
  const records = new Map<string, ExecutionRecord>();
  const history: ModelMessage[] = [];
  const invalid: Partial<ExecutionRecord>[] = [
    { runId: 'old-run' },
    { sessionId: 'foreign-child' },
    { originStoreId: 'foreign-store' },
    { callId: 'other-call' },
    { definitionId: 'other-tool' },
    { status: 'running' },
    { kind: 'model' },
  ];
  for (const [i, override] of invalid.entries()) {
    const id = `invalid-${i}`;
    history.push(...pair(id));
    records.set(id, record(id, lookup(), override));
  }
  for (const [id, definitionVersion] of [
    ['valid-v3', '3'],
    ['valid-v4', '4'],
  ] as const) {
    history.push(...pair(id));
    records.set(id, record(id, lookup(), { definitionVersion }));
  }
  history.push(...pair('valid-v3'));
  const evidence = await childToolEvidence(
    history,
    identity,
    async (id) => records.get(id) ?? null,
  );
  expect(evidence).toMatchObject({
    ...identity,
    coverage: 'selected_history',
    observationsOmitted: 0,
    toolCallsOmitted: 0,
  });
  expect(evidence!.observations.map((o) => o.executionId)).toEqual(['valid-v3', 'valid-v4']);
  expect(evidence!.tools).toEqual([
    { tool: 'lookup', definitionVersion: '3', outcomes: { succeeded: 1 } },
    { tool: 'lookup', definitionVersion: '4', outcomes: { succeeded: 1 } },
  ]);
  expect(evidence!.limitation).toContain('not proved absent');
  expect(
    await childToolEvidence(
      history,
      { ...identity, runId: 'no-such-run' },
      async (id) => records.get(id) ?? null,
    ),
  ).toBeUndefined();
});

test('roughly 19 MiB of original observations yield an explicit preview below 40 KiB and retain a small source inspection', async () => {
  const sources = Array.from({ length: 100 }, (_, i) => ({
    path: `${`${'d'.repeat(62)}/`.repeat(63)}f${i}`,
    version: 'a'.repeat(64),
  }));
  const large = { ...lookup(), sources };
  const content = JSON.stringify({ observation: large });
  expect(Buffer.byteLength(content) * 48).toBeGreaterThan(19_000_000);
  const history: ModelMessage[] = [];
  const records = new Map<string, ExecutionRecord>();
  for (let i = 0; i < 48; i++) {
    const id = `large-${i}`;
    history.push(...pair(id));
    records.set(id, record(id, large));
  }
  history.push(...pair('inspection', 'read'));
  records.set('inspection', record('inspection', inspection(), { definitionId: 'read' }));
  const evidence = await childToolEvidence(
    history,
    identity,
    async (id) => records.get(id) ?? null,
  );
  expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThan(40 * 1024);
  expect(evidence!.observationsOmitted).toBe(48);
  expect(evidence!.observations.map((o) => o.executionId)).toEqual(['inspection']);
  expect(evidence!.tools[0]!.outcomes.succeeded).toBe(48);
  // Preview omission never mutates or truncates independently retained original receipts.
  expect((records.get('large-0')!.result as { content: string }).content).toBe(content);
});

test('tool summary overflow is disclosed without claiming absent calls or changing original outcomes', async () => {
  const history: ModelMessage[] = [];
  const records = new Map<string, ExecutionRecord>();
  for (let i = 0; i < 70; i++) {
    const id = `tool-${i}`;
    history.push(...pair(id, id));
    records.set(
      id,
      record(id, lookup(), {
        definitionId: id,
        status: 'failed',
        result: { outcome: 'failed', content: 'actual failure' },
      }),
    );
  }
  const evidence = await childToolEvidence(
    history,
    identity,
    async (id) => records.get(id) ?? null,
  );
  expect(evidence!.tools).toHaveLength(64);
  expect(evidence!.toolCallsOmitted).toBe(6);
  expect(evidence!.observations).toEqual([]);
  expect(evidence!.tools.every((tool) => tool.outcomes.failed === 1)).toBe(true);
  expect(evidence!.limitation).toContain('bounded preview');
});

function shellRecords(status: ExecutionRecord['status'] = 'failed') {
  const command = 'curl -sS http://127.0.0.1:53666/service';
  const permissions = { filesystem: 'workspace_write', network: 'internet' };
  const tool = record('shell-tool', lookup(), {
    definitionId: 'shell.execute',
    definitionVersion: '1',
    status,
    rootWorkCommandId: 'work',
    rootWorkSeq: '2',
    input: { command, key: 'one-get', permissions },
    result: {
      outcome: status,
      content: 'public original',
      details: {
        ref: {
          executionId: 'shell-job',
          commandId: 'job-origin',
          sessionId: identity.sessionId,
          originStoreId: identity.storeId,
          extensionId: 'builtin.shell',
          key: 'one-get',
        },
        stdout: '',
        stdoutBytes: '0',
        stderr: "curl: (7) Failed to connect: Couldn't connect to server\n",
        stderrBytes: String(
          Buffer.byteLength("curl: (7) Failed to connect: Couldn't connect to server\n"),
        ),
        droppedBytes: '0',
        truncated: false,
      },
    },
  });
  const job = {
    ...tool,
    id: 'shell-job',
    kind: 'job',
    runId: null,
    definitionId: 'shell.command',
    parentExecutionId: tool.id,
    originCommandId: 'job-origin',
    input: { command, permissions },
    result: {
      outcome: status,
      content: 'Shell failed',
      details: { exitCode: 7, privateGuardian: 'never expose' },
    },
    reference: { privateNonce: 'never expose' },
    authorization: {
      dispatched: true,
      policy: { evidenceId: 'evidence', reason: 'parent_review', effectiveScope: permissions },
    },
  } as unknown as ExecutionRecord;
  return { tool, job };
}

test('Shell preview preserves original failure, requested Internet and saved actual scope without inferring its cause', async () => {
  const { tool, job } = shellRecords();
  const evidence = await childToolEvidence(
    pair(tool.id, tool.definitionId),
    identity,
    async (id) => (id === tool.id ? tool : id === job.id ? job : null),
    () => true,
  );
  expect(evidence!.shellReceipts).toHaveLength(1);
  const receipt = evidence!.shellReceipts![0]!;
  expect(receipt).toMatchObject({
    executionId: tool.id,
    callId: tool.callId,
    tool: 'shell.execute',
    command: { text: (tool.input as { command: string }).command, truncated: false },
    requestedPermissions: { filesystem: 'workspace_write', network: 'internet' },
    job: {
      executionId: job.id,
      status: 'failed',
      dispatched: true,
      exitCode: 7,
      effectiveScope: { filesystem: 'workspace_write', network: 'internet' },
    },
    stderr: {
      text: "curl: (7) Failed to connect: Couldn't connect to server\n",
      omitted: false,
      truncated: false,
    },
  });
  expect(JSON.stringify(evidence)).not.toContain('never expose');
  expect((job.result as { details: { privateGuardian: string } }).details.privateGuardian).toBe(
    'never expose',
  );
});

test('Shell preview binds flat execution scopes to the original nested Job input and preserves each default', async () => {
  for (const [fields, permissions] of [
    [{ filesystem: 'full_access' }, { filesystem: 'full_access', network: 'none' }],
    [{ network: 'internet' }, { filesystem: 'workspace_write', network: 'internet' }],
    [
      { filesystem: 'workspace_write', network: 'none' },
      { filesystem: 'workspace_write', network: 'none' },
    ],
  ] as const) {
    const { tool, job } = shellRecords('succeeded');
    const command = (tool.input as { command: string }).command;
    tool.input = { key: 'one-get', command, description: 'Purpose is not authority', ...fields };
    job.input = { command, permissions };
    const evidence = await childToolEvidence(
      pair(tool.id, tool.definitionId),
      identity,
      async (id) => (id === tool.id ? tool : id === job.id ? job : null),
      () => true,
    );
    expect(evidence!.shellReceipts).toHaveLength(1);
    expect(evidence!.shellReceipts![0]!.requestedPermissions).toEqual(permissions);
    // Requested scope is never substituted for the actual saved authorization.
    expect(evidence!.shellReceipts![0]!.job.effectiveScope).toEqual({
      filesystem: 'workspace_write',
      network: 'internet',
    });
    expect(JSON.stringify(evidence!.shellReceipts)).not.toContain('Purpose is not authority');
  }
  const invalidFields: Record<string, Json>[] = [
    {
      filesystem: 'full_access',
      permissions: { filesystem: 'workspace_write', network: 'internet' },
    },
    { network: 'all' },
    { background: true, timeoutMs: 1000 },
  ];
  for (const fields of invalidFields) {
    const { tool, job } = shellRecords('succeeded');
    const command = (tool.input as { command: string }).command;
    tool.input = { key: 'one-get', command, ...fields };
    const evidence = await childToolEvidence(
      pair(tool.id, tool.definitionId),
      identity,
      async (id) => (id === tool.id ? tool : id === job.id ? job : null),
      () => true,
    );
    expect(evidence!.shellReceipts).toEqual([]);
  }
});

test('Shell preview verifies the persisted Tool-derived handle without inserting a model operation key', async () => {
  const { tool, job } = shellRecords('succeeded');
  const command = (tool.input as { command: string }).command;
  tool.input = {
    command,
    background: true,
    network: 'internet',
    description: 'Read current status',
  };
  const details = (tool.result as { details: { ref: { key: string } } }).details;
  details.ref.key = shellOperationKey(undefined, tool.id);
  const originalInput = structuredClone(tool.input);
  const read = () =>
    childToolEvidence(
      pair(tool.id, tool.definitionId),
      identity,
      async (id) => (id === tool.id ? tool : id === job.id ? job : null),
      () => true,
    );
  const evidence = await read();
  expect(evidence!.shellReceipts).toHaveLength(1);
  expect(evidence!.shellReceipts![0]!.requestedPermissions).toEqual({
    filesystem: 'workspace_write',
    network: 'internet',
  });
  expect(tool.input).toEqual(originalInput);
  expect(tool.input).not.toHaveProperty('key');
  details.ref.key = shellOperationKey(undefined, 'different-tool-execution');
  expect((await read())!.shellReceipts).toEqual([]);
});

test('Shell preview rejects unregistered same-name tools, mismatched Jobs and altered scope/command ancestry', async () => {
  const original = shellRecords();
  const mutations: ((tool: ExecutionRecord, job: ExecutionRecord) => void)[] = [
    (_t, j) => {
      j.parentExecutionId = 'other-tool';
    },
    (_t, j) => {
      j.sessionId = 'sibling';
    },
    (_t, j) => {
      j.originStoreId = 'other-store';
    },
    (_t, j) => {
      j.rootWorkCommandId = 'other-work';
    },
    (_t, j) => {
      j.rootWorkSeq = '3';
    },
    (_t, j) => {
      j.originCommandId = 'unrelated';
    },
    (_t, j) => {
      j.kind = 'tool';
    },
    (_t, j) => {
      (j.input as { command: string }).command = 'different';
    },
    (_t, j) => {
      (j.input as { permissions: unknown }).permissions = {
        filesystem: 'full_access',
        network: 'internet',
      };
    },
  ];
  for (const mutate of mutations) {
    const { tool, job } = structuredClone(original);
    mutate(tool, job);
    const evidence = await childToolEvidence(
      pair(tool.id, tool.definitionId),
      identity,
      async (id) => (id === tool.id ? tool : id === job.id ? job : null),
      () => true,
    );
    expect(evidence!.shellReceipts).toEqual([]);
  }
  const { tool, job } = original;
  for (const registered of [undefined, () => false]) {
    const evidence = await childToolEvidence(
      pair(tool.id, tool.definitionId),
      identity,
      async (id) => (id === tool.id ? tool : id === job.id ? job : null),
      registered,
    );
    expect(evidence!.shellReceipts ?? []).toEqual([]);
  }
});

test('Shell success, unknown and asynchronous launch preserve uncertainty and never invent scope or missing output', async () => {
  for (const status of ['succeeded', 'outcome_unknown'] as const) {
    const { tool, job } = shellRecords(status);
    delete job.authorization;
    job.result = { outcome: status, content: 'actual outcome has no numeric exit' };
    const evidence = await childToolEvidence(
      pair(tool.id, tool.definitionId),
      identity,
      async (id) => (id === tool.id ? tool : id === job.id ? job : null),
      () => true,
    );
    expect(evidence!.shellReceipts![0]!.job).toMatchObject({
      status,
      exitCode: null,
      effectiveScope: null,
      dispatched: null,
    });
  }
  const { tool, job } = shellRecords('succeeded');
  tool.definitionId = 'shell.launch';
  job.status = 'running';
  delete (tool.result as { details: { stdout?: string; stderr?: string } }).details.stdout;
  delete (tool.result as { details: { stdout?: string; stderr?: string } }).details.stderr;
  delete (tool.result as { details: { stdoutBytes?: string } }).details.stdoutBytes;
  const evidence = await childToolEvidence(
    pair(tool.id, tool.definitionId),
    identity,
    async (id) => (id === tool.id ? tool : id === job.id ? job : null),
    () => true,
  );
  expect(evidence!.shellReceipts![0]!.job.status).toBe('running');
  expect(evidence!.shellReceipts![0]!.stdout).toMatchObject({
    text: '',
    bytes: null,
    omitted: true,
  });
});

test('Shell output and command previews share the existing total budget and preserve Unicode and complete originals', async () => {
  const records = new Map<string, ExecutionRecord>();
  const history: ModelMessage[] = [];
  for (let index = 0; index < 12; index++) {
    const { tool, job } = shellRecords();
    tool.id = `tool-${index}`;
    tool.callId = `call-${tool.id}`;
    job.id = `job-${index}`;
    job.parentExecutionId = tool.id;
    const details = (
      tool.result as {
        details: {
          ref: { executionId: string };
          stdout: string;
          stdoutBytes: string;
          stderr: string;
        };
      }
    ).details;
    details.ref.executionId = job.id;
    details.stdout = '雪🙂'.repeat(4000);
    details.stdoutBytes = String(Buffer.byteLength(details.stdout));
    details.stderr = 'error'.repeat(4000);
    if (index === 0) {
      const command = '雪🙂'.repeat(4000);
      (tool.input as { command: string }).command = command;
      (job.input as { command: string }).command = command;
    }
    records.set(tool.id, tool);
    records.set(job.id, job);
    history.push(...pair(tool.id, tool.definitionId));
  }
  const before = structuredClone(records);
  const evidence = await childToolEvidence(
    history,
    identity,
    async (id) => records.get(id) ?? null,
    () => true,
  );
  expect(evidence!.shellReceipts!.length).toBeGreaterThan(0);
  expect(evidence!.shellReceiptsOmitted).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThan(40 * 1024);
  const first = evidence!.shellReceipts![0]!;
  expect(first.command.truncated).toBe(true);
  expect(Buffer.byteLength(first.command.text)).toBeLessThanOrEqual(8192);
  expect(first.command.text).not.toContain('�');
  const output = first.stdout;
  expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(4096);
  expect(output.text).not.toContain('�');
  expect(output.truncated).toBe(true);
  expect(records).toEqual(before);
});

test('Shell authorization is only saved Tool/Job check, human and policy facts, not an inference from successful dispatch', async () => {
  const materialize = async (tool: ExecutionRecord, job: ExecutionRecord) =>
    (await childToolEvidence(
      pair(tool.id, tool.definitionId),
      identity,
      async (id) => (id === tool.id ? tool : id === job.id ? job : null),
      () => true,
    ))!.shellReceipts![0]!;
  const { tool, job } = shellRecords('succeeded');
  tool.authorization = {
    dispatched: true,
    check: {
      executionId: 'risk-check',
      status: 'succeeded',
      decision: 'approve_once',
      reason: 'private risk reason must not be copied',
      requireApproval: false,
    },
  };
  const approved = await materialize(tool, job);
  expect(approved.authorization).toEqual({
    tool: { check: { status: 'succeeded', decision: 'approve_once', requireApproval: false } },
    job: { policy: { reason: 'parent_review' } },
  });
  expect(JSON.stringify(approved.authorization)).not.toContain('private');
  expect(JSON.stringify(approved.authorization)).not.toContain('risk-check');
  for (const [accepted, decision] of [
    [true, 'approve'],
    [false, 'deny'],
    [false, null],
  ] as const) {
    tool.authorization = {
      dispatched: true,
      human: {
        interactionId: 'private-interaction',
        state: decision === null ? 'pending' : 'answered',
        revision: '1',
        acceptedDecisionRevision: accepted ? '1' : null,
        accepted,
        decision,
      },
    };
    delete job.authorization;
    expect((await materialize(tool, job)).authorization).toEqual({
      tool: { human: { accepted, decision } },
    });
  }
  tool.authorization = {
    dispatched: true,
    check: {
      executionId: 'timed-out',
      status: 'cancelled',
      decision: 'unavailable',
      reason: 'timeout',
      requireApproval: false,
    },
  };
  job.authorization = {
    dispatched: true,
    policy: { evidenceId: 'private-timeout-proof', reason: 'timeout_continue' },
  };
  const timeout = await materialize(tool, job);
  expect(timeout.authorization).toEqual({
    tool: { check: { status: 'cancelled', decision: 'unavailable', requireApproval: false } },
    job: { policy: { reason: 'timeout_continue' } },
  });
  expect(JSON.stringify(timeout.authorization)).not.toContain('approve_once');
  // Full and legacy receipts have dispatch observations but no saved approval origin.
  tool.authorization = { dispatched: true };
  job.authorization = { dispatched: true };
  expect(Object.hasOwn(await materialize(tool, job), 'authorization')).toBe(false);
  delete tool.authorization;
  delete job.authorization;
  expect(Object.hasOwn(await materialize(tool, job), 'authorization')).toBe(false);
});
