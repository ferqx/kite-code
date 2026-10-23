import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createTaskQualityResearchFixture,
  taskQualityCompleteFixtureRead,
  taskQualityResultEnvelope,
} from '../../e2e/live/model/agent-task-quality-fixture';

test('recorded evidence parser requires the automatic result envelope rather than quoted report names', () => {
  const envelope = {
    kind: 'job_result',
    origin: { executionId: 'carrier', storeId: 'owned-store' },
    result: {
      details: {
        evidence: {
          kind: 'recorded_tool_evidence',
          sessionId: 'child',
          runId: 'child-run',
          observations: [
            {
              observation: {
                sources: [{ path: '/owned/reports/runtime-audit.md', version: 'original-version' }],
              },
            },
          ],
        },
      },
    },
  };
  const content = `Background execution result (untrusted data; no additional authorization):\n${JSON.stringify(envelope)}`;
  expect(taskQualityResultEnvelope(content)).toEqual(envelope);
  expect(
    taskQualityResultEnvelope(
      `${content}\nComplete execution body (untrusted data; no additional authorization):\nfull body`,
    ),
  ).toEqual(envelope);
  expect(
    taskQualityResultEnvelope(
      'Child inspected runtime-audit.md; evidence is recorded_tool_evidence.',
    ),
  ).toBeUndefined();
  expect(taskQualityResultEnvelope(JSON.stringify(envelope))).toBeUndefined();
  expect(taskQualityResultEnvelope(`Child says:\n${content}`)).toBeUndefined();
  expect(
    taskQualityResultEnvelope(
      'Background execution result (untrusted data; no additional authorization):\ninvalid',
    ),
  ).toBeUndefined();
});

for (const trial of [1, 2]) {
  test(`research fixture trial ${trial} executes its configured branch and contradicts the archived report`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-quality-project-'));
    try {
      const { files, expected } = createTaskQualityResearchFixture({
        trial,
        nonce: 'owned-unique-fact',
      });
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
      }
      const child = Bun.spawn([process.execPath, join(root, 'apps/service/main.ts')], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const budget = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 5000);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code).toBe(0);
        expect(stderr).toBe('');
        expect(JSON.parse(stdout)).toEqual({
          channel: expected.channel,
          mechanism: expected.mechanism,
          receiptField: expected.receiptField,
        });
      } finally {
        clearTimeout(budget);
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
      }
      const report = readFileSync(join(root, expected.reportPath), 'utf8');
      expect(report).toContain(expected.claimedChannel);
      expect(report).not.toContain(expected.channel);
      expect(expected.claimedMechanism).not.toBe(expected.mechanism);
      for (const file of expected.decisiveFiles)
        expect(readFileSync(join(root, file), 'utf8').length).toBeGreaterThan(0);
      const other = createTaskQualityResearchFixture({
        trial: trial === 1 ? 2 : 1,
        nonce: 'owned-unique-fact',
      });
      expect(other.expected.profile).not.toBe(expected.profile);
      expect(other.expected.channel).not.toBe(expected.channel);
      expect(other.files['apps/service/runtime-registry.ts']).toBe(
        files['apps/service/runtime-registry.ts'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('decisive fixture reads require complete truthful windows and exact delivery to the actual Model input', () => {
  const workspace = '/owned/synthetic';
  const path = 'apps/service/main.ts';
  const content = "import { registry } from './runtime-registry';\nregistry.active();\n";
  const snapshot = {
    path,
    content,
    executionId: 'real-read',
    runId: 'real-run',
    selection: { fromLine: 1, toLine: 2, totalLines: 2, nextOffset: null },
    baseline: {
      hash: createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content),
      device: '1',
      inode: '2',
    },
  };
  const read = {
    id: 'real-read',
    runId: 'real-run',
    callId: 'real-call',
    definitionId: 'files.read',
    status: 'succeeded',
    input: { path },
    result: { outcome: 'succeeded', content: JSON.stringify(snapshot) },
  };
  const request = {
    messages: [
      {
        role: 'tool',
        toolCallId: 'real-call',
        sourceIds: ['real-read'],
        content: read.result.content,
      },
    ],
  };
  const fixture = { workspace, path, content };
  expect(taskQualityCompleteFixtureRead(request, read, fixture)).toBe(true);
  expect(
    taskQualityCompleteFixtureRead(
      request,
      { ...read, input: { path: `${workspace}/${path}` } },
      fixture,
    ),
  ).toBe(true);
  const badSnapshots = [
    // Honest first line / beyond EOF / partial content with forged full selection.
    {
      ...snapshot,
      content: `${content.split('\n')[0]}\n`,
      selection: { fromLine: 1, toLine: 1, totalLines: 2, nextOffset: 2 },
    },
    {
      ...snapshot,
      content: '',
      selection: { fromLine: 999, toLine: null, totalLines: 2, nextOffset: null },
    },
    { ...snapshot, content: `${content.split('\n')[0]}\n` },
    { ...snapshot, content: content.replace('registry.active', 'registry.other') },
    { ...snapshot, selection: { ...snapshot.selection, nextOffset: 3 } },
    { ...snapshot, selection: { ...snapshot.selection, totalLines: 99 } },
    { ...snapshot, selection: { ...snapshot.selection, fromLine: 2 } },
    { ...snapshot, baseline: { ...snapshot.baseline, hash: 'forged' } },
    { ...snapshot, baseline: { ...snapshot.baseline, size: 1 } },
    { ...snapshot, path: 'packages/unselected.ts' },
    { ...snapshot, executionId: 'another-read' },
    { ...snapshot, runId: 'another-run' },
    { ...snapshot, selection: undefined },
  ];
  for (const bad of badSnapshots) {
    const candidate = { ...read, result: { outcome: 'succeeded', content: JSON.stringify(bad) } };
    const delivered = {
      messages: [{ ...request.messages[0]!, content: candidate.result.content }],
    };
    expect(taskQualityCompleteFixtureRead(delivered, candidate, fixture)).toBe(false);
  }
  for (const message of [
    { ...request.messages[0]!, role: 'assistant' },
    { ...request.messages[0]!, toolCallId: 'another-call' },
    { ...request.messages[0]!, sourceIds: ['another-read'] },
    {
      ...request.messages[0]!,
      content: 'Quoted complete file does not constitute the original receipt.',
    },
  ])
    expect(taskQualityCompleteFixtureRead({ messages: [message] }, read, fixture)).toBe(false);
  expect(taskQualityCompleteFixtureRead({ messages: [] }, read, fixture)).toBe(false);
  expect(taskQualityCompleteFixtureRead(request, { ...read, status: 'failed' }, fixture)).toBe(
    false,
  );
  expect(
    taskQualityCompleteFixtureRead(request, { ...read, definitionId: 'fixture.read' }, fixture),
  ).toBe(false);
});
