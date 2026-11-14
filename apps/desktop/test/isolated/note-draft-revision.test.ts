import { expect, test } from 'bun:test';
import { reconciledNoteRevision } from '../../src/note-draft-revision';

test('receipt after a read of consumed revision does not advance it twice', () => {
  expect(
    reconciledNoteRevision(3, 'accepted', {
      revision: 3,
      consumedFrom: { commandId: 'accepted', revision: 2 },
    }),
  ).toBe(3);
});
test('only proven host consumption advances CAS; acceptance alone does not', () => {
  expect(reconciledNoteRevision(2, 'accepted', { revision: 2 })).toBe(2);
  expect(
    reconciledNoteRevision(2, 'accepted', {
      revision: 3,
      consumedFrom: { commandId: 'accepted', revision: 2 },
    }),
  ).toBe(3);
  expect(() => reconciledNoteRevision(2, 'accepted', { revision: 3 })).toThrow();
  expect(() =>
    reconciledNoteRevision(2, 'accepted', {
      revision: 3,
      consumedFrom: { commandId: 'other', revision: 2 },
    }),
  ).toThrow();
  expect(() =>
    reconciledNoteRevision(2, 'accepted', {
      revision: 4,
      consumedFrom: { commandId: 'accepted', revision: 2 },
    }),
  ).toThrow();
});
