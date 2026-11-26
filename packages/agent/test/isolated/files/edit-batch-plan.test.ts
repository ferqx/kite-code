import { expect, test } from 'bun:test';
import {
  consecutiveFileEditCandidates,
  fileEditBatchPlans,
} from '../../../src/file-edit-batch-plan';
import type { ToolCall } from '../../../src/storage/types';

const edit = (id: string, path = 'a.ts', replace = 'new'): ToolCall => ({
  id,
  name: 'files.edit',
  arguments: JSON.stringify({ path, find: id, replace }),
});
const target = async (_call: ToolCall, input: { path: string }) => ({
  slot: input.path === '/workspace/a.ts' ? 'a.ts' : input.path,
  baseline: 'sealed-original',
});

test('batch membership is ordered, exact, scope-bound, and retains unrelated positions', async () => {
  const calls = [
    edit('first'),
    { ...edit('middle'), name: 'shell.execute' },
    edit('second', '/workspace/a.ts'),
    edit('other', 'b.ts'),
  ];
  const [batch] = await fileEditBatchPlans('model-one', calls, target);
  expect(batch).toMatchObject({ slot: 'a.ts', baseline: 'sealed-original', interleaved: true });
  expect(batch?.members.map(({ id, ordinal }) => [id, ordinal])).toEqual([
    ['first', 0],
    ['second', 2],
  ]);
  expect(batch?.digest).toMatch(/^[a-f0-9]{64}$/);
  expect((await fileEditBatchPlans('model-one', calls, target))[0]?.digest).toBe(batch?.digest);
  expect((await fileEditBatchPlans('model-two', calls, target))[0]?.digest).not.toBe(batch?.digest);
  calls[2] = edit('second', '/workspace/a.ts', 'changed');
  expect((await fileEditBatchPlans('model-one', calls, target))[0]?.digest).not.toBe(batch?.digest);
});

test('invalid model arguments, an unproved target, inconsistent baselines or a truncated set cannot supply a group', async () => {
  const two = [edit('first'), edit('second')];
  await expect(
    fileEditBatchPlans('model', two, async (call, input) => ({
      ...(await target(call, input)),
      baseline: call.id,
    })),
  ).resolves.toEqual([]);
  await expect(
    fileEditBatchPlans('model', two, async (call, input) =>
      call.id === 'second' ? null : target(call, input),
    ),
  ).resolves.toEqual([]);
  await expect(
    fileEditBatchPlans(
      'model',
      [
        two[0]!,
        {
          ...two[1]!,
          model: {
            name: 'edit_file',
            error: 'invalid_tool_arguments',
          },
        },
      ],
      target,
    ),
  ).resolves.toEqual([]);
  await expect(fileEditBatchPlans('model', [two[0]!, two[0]!], target)).resolves.toEqual([]);
  await expect(
    fileEditBatchPlans(
      'model',
      Array.from({ length: 33 }, (_, n) => edit(String(n))),
      target,
    ),
  ).resolves.toEqual([]);
});

test('the dispatch shortlist does not move a later edit across another call', () => {
  const calls = [edit('first'), edit('second'), { ...edit('other'), name: 'shell.execute' }];
  expect(consecutiveFileEditCandidates(calls).map((group) => group.map((call) => call.id))).toEqual(
    [['first', 'second']],
  );
  expect(consecutiveFileEditCandidates([calls[0]!, calls[2]!, calls[1]!])).toEqual([]);
});
