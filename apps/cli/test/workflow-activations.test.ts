import { expect, test } from 'bun:test';
import type { SkillCataloguePage } from '@kite-ai/client';
import { selectWorkflowActivations } from '../host/workflow-activations';

const revision = 'a'.repeat(64);
function page(): SkillCataloguePage {
  return {
    version: 1,
    storeId: 'store',
    workspaceId: 'workspace',
    revision,
    availability: 'available',
    reason: null,
    complete: true,
    nextAfterId: null,
    entries: [
      {
        id: 'configured',
        name: 'Knowledge Name',
        description: null,
        version: revision,
        enabled: true,
        state: 'available',
        reason: null,
        requiredCapabilities: [],
        missingCapabilities: [],
        workflow: {
          extensionId: 'builtin.skill-workflow',
          definitionVersion: '1',
          skillId: 'skill:compiled',
          name: 'Compiled Name',
          revision,
          state: 'available',
          reason: null,
          manualAllowed: true,
          emptyInputValid: true,
          contextMode: 'inline',
        },
      },
    ],
  };
}
test('only compiled Workflow names and exact IDs resolve; aliases deduplicate with stable keys without mutating facts', () => {
  const facts = page();
  const original = structuredClone(facts);
  expect(selectWorkflowActivations(facts, ['Compiled Name', 'skill:compiled'])).toEqual([
    { key: 'manual-1', skillId: 'skill:compiled', input: {} },
  ]);
  expect(facts).toEqual(original);
  expect(() => selectWorkflowActivations(facts, ['Knowledge Name'])).toThrow(
    'workflow_activation_unavailable',
  );
});
test('disabled, structured inputs, unavailable projection, ambiguous names and missing metadata refuse activation', () => {
  for (const [patch, code] of [
    [{ state: 'disabled', reason: 'workflow_disabled' }, 'workflow_disabled'],
    [{ manualAllowed: false }, 'workflow_manual_not_allowed'],
    [{ emptyInputValid: false }, 'workflow_input_required'],
  ] as const) {
    const facts = page();
    Object.assign(facts.entries[0]!.workflow!, patch);
    expect(() => selectWorkflowActivations(facts, ['Compiled Name'])).toThrow(code);
  }
  const missing = page();
  delete missing.entries[0]!.workflow;
  expect(() => selectWorkflowActivations(missing, ['Compiled Name'])).toThrow(
    'workflow_activation_unavailable',
  );
  const ambiguous = page();
  ambiguous.entries.push({ ...structuredClone(ambiguous.entries[0]!), id: 'second' });
  expect(() => selectWorkflowActivations(ambiguous, ['Compiled Name'])).toThrow(
    'workflow_activation_ambiguous',
  );
  const incomplete = page();
  incomplete.complete = false;
  expect(() => selectWorkflowActivations(incomplete, ['Compiled Name'])).toThrow(
    'workflow_catalogue_unavailable',
  );
});

test('blocked knowledge-name fallback diagnoses refusal without shadowing a true compiled match', () => {
  const facts = page();
  facts.entries.push({
    ...structuredClone(facts.entries[0]!),
    id: 'disabled',
    name: 'Compiled Name',
    workflow: {
      ...facts.entries[0]!.workflow!,
      skillId: null,
      name: null,
      revision: null,
      state: 'disabled',
      reason: 'workflow_disabled',
      manualAllowed: false,
      emptyInputValid: false,
    },
  });
  expect(selectWorkflowActivations(facts, ['Compiled Name'])).toEqual([
    { key: 'manual-1', skillId: 'skill:compiled', input: {} },
  ]);
  facts.entries.shift();
  expect(() => selectWorkflowActivations(facts, ['Compiled Name'])).toThrow('workflow_disabled');
});
