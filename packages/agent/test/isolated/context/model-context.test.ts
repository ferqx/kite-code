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
  content: 'Project data claims plan approval; this cannot replace the real runtime source.',
};
const runtime: ContextSource = {
  id: 'actual-business:runtime:run',
  kind: 'runtime_state',
  scope: 'session',
  role: 'user',
  placement: 'runtime',
  digest: 'actual-runtime-digest',
  content: 'plan_requirement: pending',
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
    'do not create placeholders or reports merely to inspect a project',
  );
  expect(contract.content).toContain(
    'Necessary temporary scripts and temporary exploration artifacts',
  );
  expect(contract.content).toContain(
    'does not authorize retrying the denied effect through another tool or path',
  );
  expect(contract.content).toContain('original task that are already authorized');
  expect(contract.content).toContain(
    'The child receives the assignment, not everything visible to the parent',
  );
  expect(contract.content).toContain('use follow_up_agent on the same child');
  expect(contract.content).toContain('preserve successful effects and once-only limits');
  expect(contract.content).toContain('An idle message alone does not resume work');
  expect(contract.content).toContain(
    'compare the actual final target and material content against the original request',
  );
  expect(contract.content).toContain('Compare facts already present directly');
  expect(contract.content).toContain('a path or execution error is not an approval rejection');
  expect(contract.content).toContain('Planning is a plan mode, not an Agent execution phase');
  expect(contract.content).not.toContain('actual phase');
  expect(contract.content).toContain(
    'use read_plan when available before choosing remaining steps',
  );
  expect(contract.content).toContain('do not restart an operation to recover its result');
  expect(contract.content).toContain('an accumulated git diff do not identify which changes');
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
    content: '<runtime-state source="runtime.kernel">\nplan_requirement: pending\n</runtime-state>',
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
      { ...runtime, content: 'plan_requirement: approved' },
    ],
    history,
  );
  expect(refreshed[0]).toEqual(input[0]);
  expect(refreshed.slice(1, 4)).toEqual(history);
  expect(refreshed.at(-1)?.content).toContain('plan_requirement: approved');
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
