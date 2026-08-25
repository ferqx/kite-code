import { expect, test } from 'bun:test';
import { testBuiltinToolCatalog } from '../../helpers/runtime-model';

test('full mode allows ask_user across planning and building phases', () => {
  const entry = testBuiltinToolCatalog().entries.find(
    (candidate) => candidate.visibility === 'model' && candidate.name === 'ask_user',
  );
  if (entry?.visibility !== 'model') throw new Error('ask_user Builtin entry missing');
  for (const sandboxAvailable of [true, false]) {
    for (const phase of ['planning', 'building'] as const) {
      expect(
        entry.compilePolicy(
          {
            questions: [
              {
                question: 'Continue?',
                options: [
                  { label: 'Yes', description: 'Continue.', recommended: true },
                  { label: 'No', description: 'Stop.', recommended: false },
                ],
              },
            ],
          },
          { workspace: '/tmp/prompt-contract', phase },
        ),
      ).toMatchObject({ decision: 'allow', allowed: true, requiresApproval: false });
      // Sandbox availability is a Host/Kernel admission fact, not a Builtin
      // ask_user policy input; keep the loop to document both host states.
      expect(sandboxAvailable).toBeTypeOf('boolean');
    }
  }
});
