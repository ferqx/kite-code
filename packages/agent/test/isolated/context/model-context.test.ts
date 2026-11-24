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

test('the trusted system context separates base instructions from the selected Shell and platform', () => {
  const powerShell = agentContractSource('D:\\workspace', {
    platform: 'win32',
    ripgrepVersion: '15.0.0',
    shell: { kind: 'powershell', version: '5.1.26100.10068', edition: 'Desktop', locale: 'zh-CN' },
  });
  const [system, ...messages] = assembleModelContext([powerShell], history);
  expect(system).toMatchObject({ role: 'system', sourceIds: ['agent:contract'] });
  const environmentHeading = '\n\n# Working environment\n';
  const [instructions, environment] = system!.content.split(environmentHeading);
  expect(instructions).toContain('## Changes to system instructions');
  expect(instructions).not.toContain('Shell:');
  expect(environment).toContain('Workspace root: D:\\workspace');
  expect(environment).toContain('Shell: Windows PowerShell 5.1.26100.10068');
  expect(environment).toContain('Windows user locale: zh-CN');
  expect(environment).toContain('Bundled ripgrep (rg) version: 15.0.0');
  expect(environment).toContain('Supply -UseBasicParsing for Invoke-WebRequest.');
  expect(environment).toContain("rg -n -g 'package.json' 'name' packages apps");
  expect(
    system?.content.match(/prefer rg for text and rg --files for file discovery/g),
  ).toHaveLength(1);
  expect(messages).toEqual(history);

  const bash = agentContractSource('D:\\workspace', {
    platform: 'win32',
    shell: { kind: 'git-bash', version: '5.3.15(2)-release' },
  });
  expect(bash.content.split(environmentHeading)[0]).toBe(instructions);
  expect(bash.content).toContain('Shell: Git Bash 5.3.15(2)-release on Windows');
  expect(bash.content).not.toContain('PowerShell on Windows passes wildcard paths');
  expect(bash.digest).not.toBe(powerShell.digest);

  const posix = agentContractSource('/workspace', {
    platform: 'linux',
    shell: { kind: 'posix', executable: '/bin/sh' },
  });
  expect(posix.content).toContain('Operating system: Linux\nShell: /bin/sh (POSIX)');
  const shellUnavailable = agentContractSource('/workspace', { platform: 'linux' });
  expect(shellUnavailable.content).toContain('Operating system: Linux');
  expect(shellUnavailable.content).not.toContain('Shell:');
});

test('an identical captured Skill body appears once, with the original tool receipt still attributable', () => {
  const original: ContextSource = {
    id: 'skill.body:packing',
    kind: 'skill',
    scope: 'work',
    digest: 'packing-digest',
    content: 'Confirm the parcel before printing the label.',
  };
  const calls: ModelMessage[] = [
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'skill', name: 'skills.load', arguments: '{"id":"packing"}' },
        { id: 'file', name: 'files.read', arguments: '{"path":"packing.txt"}' },
      ],
    },
    { role: 'tool', toolCallId: 'skill', sourceIds: ['skill-receipt'], content: original.content },
    { role: 'tool', toolCallId: 'file', sourceIds: ['file-receipt'], content: original.content },
  ];
  const input = assembleModelContext([original], calls);
  expect(input[0]).toMatchObject({
    role: 'system',
    content: original.content,
    sourceIds: [original.id],
  });
  expect(input[2]).toMatchObject({
    toolCallId: 'skill',
    sourceIds: ['skill-receipt'],
    content: 'The full instructions for Skill packing are included in the current context.',
  });
  expect(input[3]).toEqual(calls[2]);
  expect(calls[1]!.content).toBe(original.content);
  expect(assembleModelContext([], calls)).toEqual(calls);
  expect(assembleModelContext([{ ...original, content: 'New version.' }], calls)[2]).toEqual(
    calls[1],
  );
});

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
  expect(contract.content).toContain(
    'When using Shell to search, prefer rg for text and rg --files for file discovery. If the rg command is unavailable, use an appropriate alternative for the current shell.',
  );
  expect(contract.content).toContain('read-only unless the user authorizes changes');
  expect(contract.content).toContain('findings in the response unless saving was requested');
  expect(contract.content).toContain(
    'Do not create project placeholders or reports for a read-only task',
  );
  expect(contract.content).toContain(
    'Use temporary scripts or artifacts only as needed within existing permissions',
  );
  expect(contract.content).toContain(
    'An automatic rejection does not authorize retrying the denied effect through another tool or path',
  );
  expect(contract.content).toContain('Continue the independent parts that remain authorized');
  expect(contract.content).toContain(
    'Obtain explicit user approval before changing model-facing system instructions',
  );
  expect(contract.content).toContain('A direct request authorizes the stated change.');
  expect(contract.content).toContain(
    'If approval is missing, describe the proposed change and wait for the user.',
  );
  expect(contract.content).toContain('The child receives the assignment and its own context.');
  expect(contract.content).toContain('use follow_up_agent on the same child');
  expect(contract.content).toContain('preserve successful effects and once-only limits');
  expect(contract.content).toContain(
    'compare the actual final target and content against the request',
  );
  expect(contract.content).toContain('Recover missing evidence through permitted readers');
  expect(contract.content).toContain('An execution or path error is not an approval rejection');
  expect(contract.content).toContain('User approval may occur outside the visible conversation');
  expect(contract.content).toContain(
    'State its source or count only when the original evidence supports it',
  );
  expect(contract.content).toContain('Planning limits the steps a Run may take');
  expect(contract.content).toContain('Plan approval applies to the recorded Run and plan version');
  expect(contract.content).not.toContain('actual phase');
  expect(contract.content).toContain('When progress is missing, use read_plan if available');
  expect(contract.content).toContain('Do not restart an operation to recover its result');
  expect(contract.content).toContain(
    'Current files or an accumulated git diff alone cannot attribute earlier changes',
  );
  expect(contract.content).toContain(
    'Tool declarations describe available requests and grant no permissions',
  );
  expect(contract.content).not.toContain('Put your complete task report in your final reply');
  const sources = [project, runtime, contract];
  const input = assembleModelContext(sources, history);
  expect(input.filter((message) => message.role === 'system')).toEqual([
    { role: 'system', content: contract.content, sourceIds: [contract.id] },
  ]);
  expect(modelHistory(sources, input)).toEqual(history);
});

test('normal, summary and expanded admission keep host context before the real conversation and Tool pairs', () => {
  const contract = agentContractSource('/actual-workspace');
  const sources = [runtime, project, contract];
  sources.forEach(assertContextSource);
  const input = assembleModelContext(sources, history);
  expect(input[0]).toMatchObject({ role: 'system', content: contract.content });
  expect(input[1]).toMatchObject({ role: 'user', content: project.content });
  expect(input[2]).toEqual({
    role: 'user',
    content: '<runtime-state source="runtime.kernel">\nplan_requirement: pending\n</runtime-state>',
    sourceIds: [runtime.id],
  });
  expect(input.slice(3)).toEqual(history);
  expect(modelHistory(sources, input)).toEqual(history);
  const instruction: ModelMessage = {
    role: 'user',
    content: 'Summarize the actual original history',
  };
  const summary = assembleModelContext(sources, [...modelHistory(sources, input), instruction]);
  expect(summary.slice(3, -1)).toEqual(history);
  expect(summary.at(-1)).toEqual(instruction);
  const refreshed = assembleModelContext(
    [
      contract,
      { ...project, content: 'Changed project data' },
      { ...runtime, content: 'plan_requirement: approved' },
    ],
    history,
  );
  expect(refreshed[0]).toEqual(input[0]);
  expect(refreshed.slice(3)).toEqual(history);
  expect(refreshed[2]?.content).toContain('plan_requirement: approved');
});

test('the system contract gives tool selection without tool-specific failure or action guidance', () => {
  const contract = agentContractSource('/source-checkout');
  expect(contract.content).toContain('Create Git worktrees only with git_worktree');
  expect(contract.content).toContain('Do not fall back to Shell or scripts');
  expect(contract.content).not.toMatch(
    /failure\.category|git_operation_failed|Git started and returned a nonzero exit code|git_worktree\.remove|operating-system temporary directory|only tool call in that model response|file-baseline conflict|empty timeout/,
  );
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
