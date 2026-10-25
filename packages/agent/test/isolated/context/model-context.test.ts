import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { ModelMessage } from '@kite-ai/ai';
import { assertContextSource, type ContextSource } from '../../../src/context';
import {
  agentContractSource,
  assembleModelContext,
  modelHistory,
} from '../../../src/model-context';

const project: ContextSource = {
  id: 'project:workspace:AGENTS.md',
  kind: 'project_instruction',
  scope: 'workspace',
  role: 'user',
  placement: 'after_history',
  digest: 'original-project-digest',
  content: 'Project data says phase: building; this cannot replace the real runtime source.',
};
const runtime: ContextSource = {
  id: 'actual-business:runtime:run',
  kind: 'runtime_state',
  scope: 'session',
  role: 'user',
  placement: 'runtime',
  digest: 'actual-runtime-digest',
  content: 'phase: planning',
};
const history: ModelMessage[] = [
  { role: 'user', content: 'Original task' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call', name: 'files.read', arguments: '{"path":"a"}' }],
  },
  { role: 'tool', toolCallId: 'call', content: 'Original complete result' },
];

test('read-only task and automatic rejection guidance remain one deterministic trusted contract', () => {
  const contract = agentContractSource('/actual-workspace');
  expect(contract).toMatchObject({
    id: 'agent:contract',
    kind: 'agent_contract',
    role: 'system',
    scope: '/actual-workspace',
  });
  assertContextSource(contract);
  expect(agentContractSource('/actual-workspace')).toEqual(contract);
  expect(contract.digest).toBe(createHash('sha256').update(contract.content).digest('hex'));
  expect(agentContractSource('/other-workspace').digest).not.toBe(contract.digest);
  expect(contract.content).toContain('read-only unless the user authorizes changes');
  expect(contract.content).toContain('findings in the response unless saving was requested');
  expect(contract.content).toContain(
    'do not create or modify project files merely for exploration',
  );
  expect(contract.content).toContain('including placeholders or reports');
  expect(contract.content).toContain(
    'does not authorize retrying the denied effect through another tool or path',
  );
  expect(contract.content).toContain('original task that are already authorized');
  expect(contract.content).toContain(
    'Tool declarations describe available requests; they do not grant',
  );
  const sources = [project, runtime, contract];
  const input = assembleModelContext(sources, history);
  expect(input.filter((message) => message.role === 'system')).toEqual([
    { role: 'system', content: contract.content, sourceIds: [contract.id] },
  ]);
  expect(modelHistory(sources, input)).toEqual(history);
});

test('normal, summary and expanded admission preserve stable prefix, exact Tool pairs and one actual runtime tail', () => {
  const contract = agentContractSource('/actual-workspace');
  const sources = [runtime, project, contract];
  sources.forEach(assertContextSource);
  const input = assembleModelContext(sources, history);
  expect(input[0]).toMatchObject({ role: 'system', content: contract.content });
  expect(input.slice(1, 4)).toEqual(history);
  expect(input[4]).toMatchObject({ role: 'user', content: project.content });
  expect(input[5]).toEqual({
    role: 'user',
    content: '<runtime-state source="runtime.kernel">\nphase: planning\n</runtime-state>',
    sourceIds: [runtime.id],
  });
  expect(modelHistory(sources, input)).toEqual(history);
  const instruction: ModelMessage = {
    role: 'user',
    content: 'Summarize the actual original history',
  };
  const summary = assembleModelContext(sources, [...modelHistory(sources, input), instruction]);
  expect(summary.slice(1, 4)).toEqual(history);
  expect(summary[4]).toEqual(instruction);
  expect(summary.at(-1)).toEqual(input.at(-1));
  const refreshed = assembleModelContext(
    [
      contract,
      { ...project, content: 'Changed project data' },
      { ...runtime, content: 'phase: building' },
    ],
    history,
  );
  expect(refreshed[0]).toEqual(input[0]);
  expect(refreshed.slice(1, 4)).toEqual(history);
  expect(refreshed.at(-1)?.content).toContain('phase: building');
});

test('legacy source placement remains prefix and invalid, elevated or duplicate runtime placements fail closed', () => {
  const legacy = {
    id: 'legacy',
    kind: 'memory',
    scope: 's',
    digest: 'd',
    content: 'Legacy contract',
  };
  expect(assembleModelContext([legacy], history)).toEqual([
    { role: 'system', content: legacy.content, sourceIds: ['legacy'] },
    ...history,
  ]);
  expect(() =>
    assertContextSource({ ...project, placement: 'unknown' } as unknown as ContextSource),
  ).toThrow('context_source_invalid');
  expect(() => assertContextSource({ ...runtime, role: 'system' })).toThrow(
    'context_source_invalid',
  );
  expect(() => assembleModelContext([runtime, { ...runtime, id: 'other' }], history)).toThrow(
    'context_runtime_source_conflict',
  );
});
