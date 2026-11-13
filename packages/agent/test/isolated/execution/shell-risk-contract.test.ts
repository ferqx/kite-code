import { expect, test } from '#kite-test';
import { authorizationCheckInput } from '../../../src/authorization-check-input';
import {
  authorizationCheckAnswer,
  authorizationCheckOutput,
} from '../../../src/authorization-check-output';
import {
  isShellRiskRequest,
  shellRiskAnswer,
  shellRiskDecision,
} from '../../../src/shell-risk-review';

test('Shell owner maps strict raw risk output to a generic answer without accepting decision or extra fields', () => {
  for (const [risk, decision] of [
    ['ordinary', 'approve_once'],
    ['high', 'ask_user'],
    ['critical', 'reject'],
  ] as const) {
    const raw = { risk, reason: 'Exact effects.' };
    const parsed = shellRiskAnswer(raw)!;
    expect(shellRiskDecision(parsed)).toEqual({ decision, reason: raw.reason });
    expect(authorizationCheckAnswer(raw)).toBeNull();
    expect(shellRiskAnswer({ ...raw, decision })).toBeNull();
  }
  expect(shellRiskAnswer({ decision: 'approve_once', reason: 'Wrong contract' })).toBeNull();
  for (const risk of [null, 1, true, { toString: () => 'ordinary' }])
    expect(shellRiskAnswer({ risk, reason: 'Invalid risk type.' })).toBeNull();
});

test('unified receipts require the exact behavior, target and complete output hashes; previous formats fail', () => {
  const receipt = {
    kind: 'authorization_check_output',
    version: 1,
    modelExecutionId: 'check',
    behavior: {
      capability: { kind: 'tool', definitionId: 'custom.operation', definitionVersion: '1' },
      contractRef: 'custom.review',
      configurationDigest: 'a'.repeat(64),
    },
    target: { executionId: 'target', attempt: 1, inputDigest: 'b'.repeat(64) },
    checkInputDigest: 'c'.repeat(64),
    sealedInputHash: 'd'.repeat(64),
    modelOutputDigest: 'e'.repeat(64),
    contentHash: 'f'.repeat(64),
    answer: { decision: 'reject', reason: 'Credential upload.' },
    evidence: { risk: 'critical' },
  } as const;
  expect(authorizationCheckOutput(receipt)).toEqual(receipt);
  for (const value of [
    { ...receipt, version: 2 },
    {
      kind: 'authorization_review_output',
      version: 1,
      modelExecutionId: receipt.modelExecutionId,
      modelOutputDigest: receipt.modelOutputDigest,
      contentHash: receipt.contentHash,
      answer: receipt.answer,
    },
    {
      kind: 'authorization_check_output',
      version: 1,
      modelExecutionId: receipt.modelExecutionId,
      modelOutputDigest: receipt.modelOutputDigest,
      contentHash: receipt.contentHash,
      answer: receipt.answer,
    },
    { ...receipt, answer: undefined },
    { ...receipt, behavior: undefined },
    { ...receipt, target: { ...receipt.target, inputDigest: 'bad' } },
    { ...receipt, reviewPurpose: 'shell_risk' },
    { ...receipt, contentHash: undefined },
  ])
    expect(authorizationCheckOutput(value)).toBeNull();
});

test('the generic model projection preserves owner material and cannot substitute business or quoted domain markers', () => {
  const material = {
    purpose: 'custom-risk-shape',
    operation: {
      input: { command: './unknown', description: 'Owner decides whether this is review material' },
    },
    material: { cwd: '/owned', coverage: 'incomplete' },
  };
  const payload = {
    purpose: 'authorization_check',
    review: {
      instructions: 'Original owner guidance',
      fingerprint: 'a'.repeat(64),
      reusable: false,
      material,
    },
    target: {
      kind: 'tool',
      definitionId: 'unrecognized.operation',
      definitionVersion: '9',
      input: { command: './unknown', private: 'PRIVATE_INPUT' },
    },
    decisionContext: { messages: ['PRIVATE_HISTORY'] },
    rootWorkRequest: 'PRIVATE_TASK',
    authorizationContext: { taskInputs: ['PRIVATE_TASK'] },
    request: { reviewPurpose: 'shell_risk' },
  };
  const original = structuredClone(payload);
  const projected = authorizationCheckInput(payload);
  expect(projected).toEqual(material);
  expect(JSON.stringify(projected)).not.toContain('PRIVATE');
  expect(payload).toEqual(original);
  expect(projected.operation).toHaveProperty('input.description');
});

test('Shell review accepts current permission AND requests and rejects the retired Planning ceiling envelope', () => {
  const request = { reviewPurpose: 'shell_risk' };
  expect(isShellRiskRequest(request)).toBe(true);
  expect(
    isShellRiskRequest({
      kind: 'parent_child_permission_intersection',
      policies: [
        { scope: 'parent', revision: 'original', request },
        { scope: 'child', revision: 'current', request },
      ],
    }),
  ).toBe(true);
  expect(
    isShellRiskRequest({
      kind: 'planning_mode_ceiling',
      policies: [{ scope: 'current', revision: 'original', request }],
    }),
  ).toBe(false);
});
