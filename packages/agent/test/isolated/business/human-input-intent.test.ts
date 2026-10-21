import { expect, test } from 'bun:test';
import {
  currentHumanInstruction,
  directHumanInputProposal,
  validateHumanInputProposal,
} from '../../../src/human-input-intent';
import type { HumanInputProposal } from '../../../src/storage/human-work-control';

const candidates = [
  { rootWorkCommandId: 'work_A', rootWorkSeq: '1', content: 'A' },
  { rootWorkCommandId: 'work_B', rootWorkSeq: '2', content: 'B' },
];
const proposal = (
  content: string,
  target = 'work_A',
  purpose: 'stop' | 'pause' | 'continue' = 'stop',
): HumanInputProposal => ({
  relation: 'same_work',
  purpose,
  targetRootWorkCommandId: target,
  selectionEffect: purpose === 'continue' ? 'select_work' : 'keep',
  basis: { kind: 'model_proposal', instruction: content },
});
const direct = (
  content: string,
  kind: 'run.start' | 'input.steer' | 'input.follow_up' = 'run.start',
  selectedWork: (typeof candidates)[number] | null = candidates[0]!,
) => directHumanInputProposal({ content, kind, selectedWork, candidates });
test('paired English contractions preserve an explicit withdrawal of a control', () => {
  for (const [purpose, content] of [
    ['stop', "Stop work_A. Don't stop work_A, it's still needed."],
    ['stop', "Stop work_A. Don't stop work_A, the users' data is still needed."],
    ['pause', "Pause work_A. Don't pause work_A, it's still needed."],
    ['continue', "Continue work_A. Don't continue work_A, it's not ready."],
  ] as const) {
    expect(currentHumanInstruction(content)).toBe(content);
    for (const kind of ['run.start', 'input.steer', 'input.follow_up'] as const)
      expect(direct(content, kind)).toBeNull();
    expect(
      validateHumanInputProposal(
        proposal(content, 'work_A', purpose),
        content,
        candidates,
        candidates[0],
      ),
    ).toMatchObject({ relation: 'unresolved', targetRootWorkCommandId: null });
  }
});
test('contractions do not suppress an affirmative different control', () => {
  const content = "Continue work_A. Don't stop work_B, it's still needed.";
  expect(currentHumanInstruction(content)).toBe(content);
  expect(direct(content)).toMatchObject({ purpose: 'continue', targetRootWorkCommandId: 'work_A' });
  expect(
    validateHumanInputProposal(
      proposal(content, 'work_A', 'continue'),
      content,
      candidates,
      candidates[0],
    ),
  ).toMatchObject({ purpose: 'continue', targetRootWorkCommandId: 'work_A' });
});
test('genuine single-quoted instructions remain reference material, including contractions', () => {
  for (const content of ["'Stop work_A'", "Continue 'work_A'."]) expect(direct(content)).toBeNull();
  const content = "Continue work_A. 'Don't continue work_A, it's not ready.'";
  expect(currentHumanInstruction(content)).toBe('Continue work_A.');
  expect(direct(content)).toMatchObject({ purpose: 'continue', targetRootWorkCommandId: 'work_A' });
});
test('an exact work ID does not turn conditional, deferred or explanatory text into immediate control', () => {
  for (const [purpose, content] of [
    ['stop', 'Stop work_A only if it fails.'],
    ['stop', 'Stop work_A tomorrow.'],
    ['stop', 'Stop work_A is an example, not an instruction.'],
    ['stop', '停止 work_A，只有它失败时。'],
    ['pause', 'Pause work_A after its current write finishes.'],
    ['pause', '暂停 work_A，明天再说。'],
    ['continue', 'Continue work_A when the review finishes.'],
    ['continue', 'Continue work_A tomorrow.'],
    ['continue', '继续 work_A，等审核完成后。'],
  ] as const) {
    expect(direct(content)).toBeNull();
    expect(
      validateHumanInputProposal(
        proposal(content, 'work_A', purpose),
        content,
        candidates,
        candidates[0],
      ),
    ).toMatchObject({ relation: 'unresolved', targetRootWorkCommandId: null });
  }
});
test('explicit immediate controls and supported business-detail suffixes remain admitted', () => {
  for (const [purpose, content] of [
    ['stop', 'Stop work_A now.'],
    ['pause', 'Pause work_A immediately.'],
    ['stop', '停止 work_A 立刻。'],
    ['continue', 'Continue work_A and summarize available results.'],
    ['continue', '继续 work_A，并汇总已有结果。'],
    ['continue', '我指的是 work_A。现在继续 work_A，把已经保存的结果汇总，不要另开工作。'],
  ] as const) {
    expect(direct(content)).toMatchObject({ purpose, targetRootWorkCommandId: 'work_A' });
    expect(
      validateHumanInputProposal(
        proposal(content, 'work_A', purpose),
        content,
        candidates,
        candidates[0],
      ),
    ).toMatchObject({ purpose, targetRootWorkCommandId: 'work_A' });
  }
});
test('existing selection never becomes independent work merely because transport uses run.start', () => {
  for (const kind of ['run.start', 'input.steer', 'input.follow_up'] as const) {
    expect(direct('先别做这个', kind)).toBeNull();
    expect(direct('处理上述剩余项', kind)).toBeNull();
  }
  expect(direct('新任务：完成 B')).toMatchObject({
    relation: 'independent_work',
    selectionEffect: 'select_work',
  });
  expect(direct('明确首次工作', 'run.start', null)).toMatchObject({ relation: 'independent_work' });
  expect(direct('请分析引用\n> 停止 work_A', 'run.start', null)).toBeNull();
});
test('ambiguous destructive controls stay unresolved even when a model supplies a real candidate', () => {
  for (const content of [
    '停止 work_A 还是 work_B？',
    '停止 work_A 或 work_B',
    '停止 work_A?',
    '停止 work_A 吗',
    'stop work_A or work_B',
    'stop which work_A',
    '停止这个',
    '先别做这个',
  ]) {
    expect(direct(content, 'input.steer')).toBeNull();
    expect(
      validateHumanInputProposal(proposal(content), content, candidates, candidates[0]),
    ).toMatchObject({ relation: 'unresolved', purpose: 'clarify', targetRootWorkCommandId: null });
  }
  const content = '先别做这个';
  expect(
    validateHumanInputProposal(
      {
        relation: 'independent_work',
        purpose: 'work',
        targetRootWorkCommandId: null,
        selectionEffect: 'select_work',
        basis: { kind: 'model_proposal', instruction: content },
      },
      content,
      candidates,
      candidates[0],
    ),
  ).toMatchObject({ relation: 'unresolved' });
});
test('an unclear control inquiry cannot become progress or new work through a model label', () => {
  for (const content of [
    '是不是应该停掉其中一个？',
    'Should we stop one of them?',
    'Should we stop it?',
    '是不是应该停掉一个？',
    '另外，要不要停掉其中一个？',
    '停止 work_A 还是 work_B？',
    '请问该暂停哪个？',
  ]) {
    expect(direct(content, 'run.start', candidates[1]!)).toBeNull();
    for (const classification of [
      {
        relation: 'same_work' as const,
        purpose: 'progress' as const,
        target: 'work_B',
        selection: 'keep' as const,
      },
      {
        relation: 'same_work' as const,
        purpose: 'work' as const,
        target: 'work_B',
        selection: 'keep' as const,
      },
      {
        relation: 'independent_work' as const,
        purpose: 'work' as const,
        target: null,
        selection: 'select_work' as const,
      },
    ]) {
      expect(
        validateHumanInputProposal(
          {
            relation: classification.relation,
            purpose: classification.purpose,
            targetRootWorkCommandId: classification.target,
            selectionEffect: classification.selection,
            basis: { kind: 'model_proposal', instruction: content },
          },
          content,
          candidates,
          candidates[1],
        ),
      ).toMatchObject({
        relation: 'unresolved',
        purpose: 'clarify',
        targetRootWorkCommandId: null,
      });
    }
  }
  const content = '新任务：分析是否应停止 work_A 或 work_B，暂不控制任何工作。';
  const independent: HumanInputProposal = {
    relation: 'independent_work',
    purpose: 'work',
    targetRootWorkCommandId: null,
    selectionEffect: 'select_work',
    basis: { kind: 'model_proposal', instruction: content },
  };
  expect(validateHumanInputProposal(independent, content, candidates, candidates[1])).toEqual(
    independent,
  );
  for (const content of [
    'work_A 已停止。请问 work_B 的进度怎样？',
    'work_A 已停止，work_B 的进度怎样？',
    'Keep the old stop receipt for work_A. What is the progress of work_B?',
  ]) {
    const observation: HumanInputProposal = {
      relation: 'same_work',
      purpose: 'progress',
      targetRootWorkCommandId: 'work_B',
      selectionEffect: 'keep',
      basis: { kind: 'model_proposal', instruction: content },
    };
    expect(validateHumanInputProposal(observation, content, candidates, candidates[1])).toEqual(
      observation,
    );
  }
});
test('control scope is the exact unquoted target or the actual selected current work', () => {
  expect(direct('停止 work_B')).toMatchObject({ targetRootWorkCommandId: 'work_B' });
  expect(direct('停止当前任务')).toMatchObject({ targetRootWorkCommandId: 'work_A' });
  expect(
    validateHumanInputProposal(
      proposal('停止当前任务', 'work_B'),
      '停止当前任务',
      candidates,
      candidates[0],
    ),
  ).toMatchObject({ relation: 'unresolved' });
  expect(
    validateHumanInputProposal(proposal('停止当前任务'), '停止当前任务', candidates, candidates[0]),
  ).toMatchObject({ purpose: 'stop', targetRootWorkCommandId: 'work_A' });
  expect(
    validateHumanInputProposal(
      proposal('停止 work_B', 'work_A'),
      '停止 work_B',
      candidates,
      candidates[0],
    ),
  ).toMatchObject({ relation: 'unresolved' });
  expect(
    validateHumanInputProposal(
      proposal('停止 work_B', 'work_B'),
      '停止 work_B',
      candidates,
      candidates[0],
    ),
  ).toMatchObject({ purpose: 'stop', targetRootWorkCommandId: 'work_B' });
  expect(
    validateHumanInputProposal(proposal('停止当前任务'), '停止当前任务', candidates),
  ).toMatchObject({ relation: 'unresolved' });
  expect(direct('停止当前任务 work_B')).toBeNull();
});
test('a progress proposal cannot replace the exact work in the current question with the kept selection', () => {
  const observation = (content: string, target: string): HumanInputProposal => ({
    relation: 'same_work',
    purpose: 'progress',
    targetRootWorkCommandId: target,
    selectionEffect: 'keep',
    basis: { kind: 'model_proposal', instruction: content },
  });
  for (const content of [
    '请问 work_A 的进度怎样？work_B 的安排保持。',
    'What is the progress of work_A? Keep work_B as selected.',
    'work_A 的新发现有哪些？\n> work_B 已经完成。',
  ]) {
    expect(
      validateHumanInputProposal(
        observation(content, 'work_B'),
        content,
        candidates,
        candidates[1],
      ),
    ).toMatchObject({ relation: 'unresolved', targetRootWorkCommandId: null });
    expect(
      validateHumanInputProposal(
        observation(content, 'work_A'),
        content,
        candidates,
        candidates[1],
      ),
    ).toMatchObject({
      relation: 'same_work',
      purpose: 'progress',
      targetRootWorkCommandId: 'work_A',
    });
  }
  for (const content of [
    'work_B 的进度怎样？work_A 是之前的工作。',
    'work_A 的进度已经记下。请问 work_B 的进度怎样？',
    'work_A 的状态只是背景；请问 work_B 有什么新发现？',
    'The progress of work_A is historical. What is the progress of work_B?',
    '当前进度怎样？\n> work_A 的进度怎样？',
    '当前进度怎样？\n```text\nwork_A 的进度怎样？\n```',
  ]) {
    expect(
      validateHumanInputProposal(
        observation(content, 'work_B'),
        content,
        candidates,
        candidates[1],
      ),
    ).toMatchObject({ relation: 'same_work', targetRootWorkCommandId: 'work_B' });
  }
  const content = '新任务：独立整理 work_B 的新资料，work_A 的记录只是背景。';
  const independent: HumanInputProposal = {
    relation: 'independent_work',
    purpose: 'work',
    targetRootWorkCommandId: null,
    selectionEffect: 'select_work',
    basis: { kind: 'model_proposal', instruction: content },
  };
  expect(validateHumanInputProposal(independent, content, candidates, candidates[0])).toEqual(
    independent,
  );
});
test('an explicit confirmation may put its exact scoped control after a separate clause', () => {
  for (const content of [
    '我指的是 work_A。现在继续 work_A，把已有结果汇总。',
    '更正：我指的是 work_A；现在继续 work_A。',
    'I mean work_A. Please resume work_A.',
    'To clarify, work_A. Please resume work_A.',
  ]) {
    expect(direct(content, 'run.start', candidates[1]!)).toMatchObject({
      purpose: 'continue',
      targetRootWorkCommandId: 'work_A',
      selectionEffect: 'select_work',
    });
    expect(
      validateHumanInputProposal(
        proposal(content, 'work_A', 'continue'),
        content,
        candidates,
        candidates[1],
      ),
    ).toMatchObject({
      purpose: 'continue',
      targetRootWorkCommandId: 'work_A',
    });
  }
  for (const content of [
    '我指的是 work_A。不要继续 work_A。',
    '我指的是 work_A。是否继续 work_A？',
    '我指的是 work_A。\n> 继续 work_A。',
    '我指的是 work_A。继续 work_B。',
    '我指的是 work_A。“继续 work_A。”',
    '我指的是 work_A。分析这段记录：继续 work_A。',
    '分析这段记录。继续 work_A。',
    '更正：请分析下面的记录。继续 work_A。',
    '我指的是下方示例：\n    继续 work_A。',
    '我指的不是 work_A。继续 work_A。',
    '我指的是 work_A。现在继续 work_A.extra。',
    '我指的是 work_A。下面请分析这段记录。继续 work_A。',
    '我指的是 work_A。继续 work_A.extra。work_A 是旧编号。',
    '我指的是 work_A。继续 work_A.extra，附注 work_A 是旧编号。',
    '我指的是 work_A。继续。附注：work_A 是分析资料。',
    '我指的是 work_A。现在继续 work_A。不要继续 work_A。',
    "I mean work_A. Please resume work_A. Don't resume work_A.",
  ]) {
    expect(direct(content, 'run.start', candidates[1]!)).toBeNull();
    expect(
      validateHumanInputProposal(
        proposal(content, 'work_A', 'continue'),
        content,
        candidates,
        candidates[1],
      ),
    ).toMatchObject({ relation: 'unresolved' });
  }
});
test('a later explicit denial of the same control keeps leading commands and confirmations unresolved', () => {
  for (const [content, purpose] of [
    ['停止 work_A。不要停止 work_A。', 'stop'],
    ['stop work_A. Do not stop work_A.', 'stop'],
    ['继续 work_A，不要继续 work_A。', 'continue'],
    ['我指的是 work_A。继续 work_A。我不是要求继续 work_A。', 'continue'],
    ['I mean work_A. Please resume work_A. I am not asking to resume work_A.', 'continue'],
  ] as const) {
    expect(direct(content)).toBeNull();
    expect(
      validateHumanInputProposal(
        proposal(content, 'work_A', purpose),
        content,
        candidates,
        candidates[0],
      ),
    ).toMatchObject({ relation: 'unresolved' });
  }
  expect(direct('我指的是 work_A。继续 work_A。不要停止 work_A。')).toMatchObject({
    purpose: 'continue',
    targetRootWorkCommandId: 'work_A',
  });
});

test('quoted target and instruction material cannot create a control scope', () => {
  for (const content of [
    '"停止 work_A"',
    '> 停止 work_A',
    '```\n停止 work_A\n```',
    '```\n停止 work_A',
    '停止 "work_A"',
  ]) {
    expect(direct(content, 'input.steer')).toBeNull();
    expect(
      validateHumanInputProposal(proposal(content), content, candidates, candidates[0]),
    ).toMatchObject({ relation: 'unresolved' });
  }
  expect(direct('停止 work_B\n> 停止 work_A')).toMatchObject({ targetRootWorkCommandId: 'work_B' });
  const colliding = [candidates[0]!, { ...candidates[1]!, rootWorkCommandId: 'work_A_extra' }];
  expect(
    directHumanInputProposal({
      kind: 'run.start',
      content: '停止 work_A_extra',
      selectedWork: candidates[0]!,
      candidates: colliding,
    }),
  ).toMatchObject({ targetRootWorkCommandId: 'work_A_extra' });
});

// First control scope remains exact when later business details mention another work.
const scopedCandidates = [
  ...candidates,
  { rootWorkCommandId: 'work.v2', rootWorkSeq: '3', content: 'dot' },
];
const scopeProposal = (content: string, target = 'work_A') => proposal(content, target, 'continue');
for (const content of [
  'Continue WORK_A.',
  'Continue Original WORK_A.',
  'Continue Work_A.',
  'Continue work.V2.',
  'Continue work_A or work_B.',
  'Continue work_A or unknown_work.',
  'Continue which task?',
  '是否继续 work_A？',
  '继续 work_A 还是 work_B？',
  'Continue work_A. Stop work_B.',
  'Continue work_A. Continue work_B.',
  'Continue work_A. Continue unknown_work.',
  'Continue work_A. Continue work_A.extra.',
  'Continue work_A.extra. work_A is historical.',
  'Continue work_A. Do not continue work_A.',
  "Continue work_A. Don't continue work_A.",
  '继续 work_A。不要继续 work_A。',
  'Continue work_A. Should we stop it?',
  'Continue work_A. Continue the same work or work_B.',
  'Continue work_A. Then stop work_B.',
  'Continue work_A. Do not stop work_B but continue work_B.',
  'Continue work_A. Continue work_A and stop unknown_work.',
  'Continue work_A and stop unknown_work.',
  'Continue work_A. Please resume work_a. work_A is historical.',
  'Continue work_A. Continue work.v2.',
  'Continue work_A. Continue current work_B.',
  'Continue "work_A".',
  '> Continue work_A',
  '```\nContinue work_A\n```',
])
  test(`scope negative ${content}`, () => {
    expect(
      directHumanInputProposal({
        content,
        kind: 'run.start',
        selectedWork: scopedCandidates[1]!,
        candidates: scopedCandidates,
      }),
    ).toBeNull();
    expect(
      validateHumanInputProposal(
        scopeProposal(content),
        content,
        scopedCandidates,
        scopedCandidates[1],
      ),
    ).toMatchObject({ relation: 'unresolved', targetRootWorkCommandId: null });
  });
for (const [content, target] of [
  ['Continue work_A. Do not spawn, write yourself, or control other collaborators.', 'work_A'],
  ['Continue work_B. The remaining work_A reads stay pending.', 'work_B'],
  ['继续 work_B。work_A 的原读取仍在等待。', 'work_B'],
  [
    'Continue work_B. Continue the original work_B task with its saved configuration. Keep work_A pending.',
    'work_B',
  ],
  ['Continue work_B. Continue the same original work and summarize available results.', 'work_B'],
  ['Continue work.v2. Keep work_A pending.', 'work.v2'],
  ['Continue work_A. Do not stop work_B.', 'work_A'],
  ['Continue.', 'work_B'],
  ['Continue. Reference: "work_A"', 'work_B'],
  ['Continue work_B. Reference: "work_A"', 'work_B'],
  ['Continue work_A.\n> Stop work_B?', 'work_A'],
  ['Continue work_A. "Stop work_B or work.v2?"', 'work_A'],
] as const)
  test(`scope positive ${content}`, () => {
    expect(
      directHumanInputProposal({
        content,
        kind: 'run.start',
        selectedWork: scopedCandidates[1]!,
        candidates: scopedCandidates,
      }),
    ).toMatchObject({ purpose: 'continue', targetRootWorkCommandId: target });
    expect(
      validateHumanInputProposal(
        scopeProposal(content, target),
        content,
        scopedCandidates,
        scopedCandidates[1],
      ),
    ).toMatchObject({ purpose: 'continue', targetRootWorkCommandId: target });
  });

for (const content of [
  'I mean work_A. Continue work_A. Maybe stop work_B?',
  'I mean work_A. Continue work_A. Then stop work_B.',
  'I mean work_A. Continue work_A and stop unknown_work.',
  'I mean work_A. Continue work_A. Continue current task missing.',
  'Continue work_A. Continue current task missing.',
  'Continue work_A. Continue the same original work unknown instead.',
  'Continue work_A. Continue current task WORK_A.',
  'Continue work_A. Continue 当前任务missing。',
  'Continue current task unknown_work.',
  'Continue work_A. Continue current task and unknown_work.',
  'I mean work_A. Continue work_A. Continue current task and unknown_work.',
  '继续 work_A。继续当前任务并unknown_work。',
  'Continue the same original work unknown_work.',
  '继续当前任务unknown_work。',
  'Continue work_A. Or work_B?',
  'I mean work_A. Continue work_A. Or work_B?',
  'Continue work_A. Or unknown_work?',
  'I mean work_A. Continue work_A. Or unknown_work?',
  '继续 work_A。或者 work_B？',
  '我指的是 work_A。继续 work_A。还是 work_B？',
  'I mean work_A. Continue work_A. Continue WORK_A.',
  'I mean work_A. Continue work_A. Do not continue work_A.',
])
  test(`independent scope negative ${content}`, () => {
    expect(direct(content, 'run.start', candidates[1]!)).toBeNull();
    expect(
      validateHumanInputProposal(
        proposal(content, 'work_A', 'continue'),
        content,
        candidates,
        candidates[1],
      ),
    ).toMatchObject({ relation: 'unresolved', targetRootWorkCommandId: null });
  });
for (const content of [
  'Continue work_A. Continue current task and summarize the real results.',
  'I mean work_A. Continue work_A. Continue current task and summarize the real results.',
  '我指的是 work_A。继续 work_A。继续同一个原任务，并汇总已有结果。',
  'Continue work_A. Do not spawn, write yourself, or control other collaborators.',
  'I mean work_A. Continue work_A. Keep work_B historical. Do not spawn, write yourself, or control other collaborators.',
])
  test(`independent scope positive ${content}`, () => {
    expect(direct(content, 'run.start', candidates[1]!)).toMatchObject({
      purpose: 'continue',
      targetRootWorkCommandId: 'work_A',
    });
    expect(
      validateHumanInputProposal(
        proposal(content, 'work_A', 'continue'),
        content,
        candidates,
        candidates[1],
      ),
    ).toMatchObject({ purpose: 'continue', targetRootWorkCommandId: 'work_A' });
  });

for (const [label, content, ids, target] of [
  [
    'actual-TUI-two-round',
    'Continue work_A. Continue the same original work and use follow_up_agent exactly once on the SAME original agent_id 12345678-1234-1234-1234-123456789abc, content "New assignment in the same collaborator: use write_user_file exactly once with path \\"/private/tmp/owned-target-C.txt\\", content \\"owned-marker-C\\", base null. This fresh target needs its own human approval. Report the complete exact content marker only after the real successful write. Respect denial, without retry, replacement or delegation.". Keep its saved history and original configuration. Wait for that new child round\'s actual result with finite wait_agent_events and report its complete actual content marker. Do not spawn, write yourself, replay prior writes, retry denials, or control other collaborators.',
    ['work_A', 'work_B'],
    'work_A',
  ],
  [
    'actual-I13-Continue-A',
    'Continue A. Preserve the original A assignments, configuration, and exact existing collaborators. Let the already queued original collaborator activate and finish its one original read. Briefly acknowledge only actual existing results and finish this parent turn normally, leaving the other original A reads pending.',
    ['A', 'B'],
    'A',
  ],
  [
    'actual-I13-Continue-B',
    "Continue B. Continue the original B boundary task after its three completed cross-work scope refusals. Target collaborator 12345678-1234-1234-1234-123456789abc has now completed its original A carrier and is truly idle. Preserve original B causality and configuration. Call follow_up_agent exactly once for that same agent_id with this exact new B instruction: New independent B assignment owned-requirement-B: use read_scope_material once with phase B and slot 4. Report its complete actual B fact and this requirement marker. Keep your saved history but do not repeat the old A read, delegate, send messages, or use control tools.. Wait for this new B round's actual result using finite wait_agent_events and report its exact B fact and requirement marker. The remaining original A reads stay pending.",
    ['A', 'B'],
    'B',
  ],
] as const)
  test(`actual fixture input ${label}`, () => {
    const actualCandidates = ids.map((rootWorkCommandId, index) => ({
      rootWorkCommandId,
      rootWorkSeq: String(index + 1),
      content: rootWorkCommandId,
    }));
    expect(
      directHumanInputProposal({
        content,
        kind: 'run.start',
        selectedWork: actualCandidates[1]!,
        candidates: actualCandidates,
      }),
    ).toMatchObject({ purpose: 'continue', targetRootWorkCommandId: target });
    expect(
      validateHumanInputProposal(
        proposal(content, target, 'continue'),
        content,
        actualCandidates,
        actualCandidates[1],
      ),
    ).toMatchObject({ purpose: 'continue', targetRootWorkCommandId: target });
  });

for (const [content, purpose] of [
  ['暂停当前任务 A。', 'pause'],
  ['停止当前任务 A。', 'stop'],
  [
    '继续当前任务 A。保留原有子任务，不创建新子任务，不延长原期限。已有结果只如实汇总，没有结果则确认等待并正常结束本轮。',
    'continue',
  ],
  ['继续当前任务 A。', 'continue'],
  ['Pause current task A.', 'pause'],
  ['Stop current task A.', 'stop'],
  ['Continue current task A.', 'continue'],
  ['Continue CURRENT TASK A.', 'continue'],
] as const)
  test(`selected named current original I14 ${content}`, () => {
    const choices = [
      { rootWorkCommandId: 'A', rootWorkSeq: '1', content: 'A' },
      { rootWorkCommandId: 'B', rootWorkSeq: '2', content: 'B' },
    ];
    expect(
      directHumanInputProposal({
        content,
        kind: 'run.start',
        selectedWork: choices[0]!,
        candidates: choices,
      }),
    ).toMatchObject({ purpose, targetRootWorkCommandId: 'A' });
    expect(
      validateHumanInputProposal(proposal(content, 'A', purpose), content, choices, choices[0]),
    ).toMatchObject({ purpose, targetRootWorkCommandId: 'A' });
    expect(
      directHumanInputProposal({
        content,
        kind: 'run.start',
        selectedWork: choices[1]!,
        candidates: choices,
      }),
    ).toBeNull();
    expect(
      validateHumanInputProposal(proposal(content, 'A', purpose), content, choices, choices[1]),
    ).toMatchObject({ relation: 'unresolved' });
  });
for (const content of [
  'Continue current task work_A.',
  'Continue the same original work work_A.',
  '继续当前任务 work_A。',
  '停止当前任务 work_A。',
  '暂停当前任务 work_A。',
])
  test(`selected exact current ID ${content}`, () => {
    const purpose = content.startsWith('停止')
      ? 'stop'
      : content.startsWith('暂停')
        ? 'pause'
        : 'continue';
    expect(direct(content)).toMatchObject({ purpose, targetRootWorkCommandId: 'work_A' });
    expect(
      validateHumanInputProposal(
        proposal(content, 'work_A', purpose),
        content,
        candidates,
        candidates[0],
      ),
    ).toMatchObject({ purpose, targetRootWorkCommandId: 'work_A' });
    expect(direct(content, 'run.start', candidates[1]!)).toBeNull();
    expect(
      validateHumanInputProposal(
        proposal(content, 'work_A', purpose),
        content,
        candidates,
        candidates[1],
      ),
    ).toMatchObject({ relation: 'unresolved' });
  });
for (const content of [
  'Continue current task unknown_work.',
  'Continue current task WORK_A.',
  'Continue current task work_A.extra.',
  'Continue current task work_Aand summarize results.',
  'Continue current task work_A_extra.',
  'Continue work_A. Continue current task work_Aand use a tool.',
  '暂停当前任务 unknown_work。',
  '停止当前任务 WORK_A。',
  '继续当前任务 work_A.extra。',
  'Continue work_A. Continue current task WORK_A.',
  'Continue work_A. Continue current task unknown_work.',
  'Continue work_A. Continue current task work_A.extra.',
  'Continue work_A. Continue current task work_B.',
  'I mean work_A. Continue work_A. Continue current task work_B.',
])
  test(`named current strict negative ${content}`, () => {
    const purpose = content.startsWith('停止')
      ? 'stop'
      : content.startsWith('暂停')
        ? 'pause'
        : 'continue';
    expect(direct(content)).toBeNull();
    expect(
      validateHumanInputProposal(
        proposal(content, 'work_A', purpose),
        content,
        candidates,
        candidates[0],
      ),
    ).toMatchObject({ relation: 'unresolved' });
  });
for (const content of [
  'Continue work_A. Continue current task work_A.',
  'Continue work_A. Continue the same original work work_A and summarize the real results.',
  'I mean work_A. Continue work_A. Continue current task work_A.',
  '继续 work_A。继续当前任务 work_A。',
])
  test(`later named current equals proven first scope ${content}`, () => {
    expect(direct(content, 'run.start', candidates[1]!)).toMatchObject({
      purpose: 'continue',
      targetRootWorkCommandId: 'work_A',
    });
    expect(
      validateHumanInputProposal(
        proposal(content, 'work_A', 'continue'),
        content,
        candidates,
        candidates[1],
      ),
    ).toMatchObject({ purpose: 'continue', targetRootWorkCommandId: 'work_A' });
  });

for (const content of ['Continue current work_A.', 'Continue the current work_A.'])
  test(`current prefix cannot name a different selected work: ${content}`, () => {
    expect(direct(content, 'run.start', candidates[1]!)).toBeNull();
    expect(
      validateHumanInputProposal(
        proposal(content, 'work_A', 'continue'),
        content,
        candidates,
        candidates[1],
      ),
    ).toMatchObject({ relation: 'unresolved', targetRootWorkCommandId: null });
    expect(direct(content, 'run.start', candidates[0]!)).toMatchObject({
      purpose: 'continue',
      targetRootWorkCommandId: 'work_A',
    });
    expect(
      validateHumanInputProposal(
        proposal(content, 'work_A', 'continue'),
        content,
        candidates,
        candidates[0],
      ),
    ).toMatchObject({ purpose: 'continue', targetRootWorkCommandId: 'work_A' });
  });
