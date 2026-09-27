import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAgentNote, validateAgentNotes } from '../../../scripts/check-agent-notes';

describe('Agent Note format', () => {
  it('accepts an implemented decision with recorded alternatives', () => {
    expect(
      validateAgentNote(
        '# Agent Note: Scoped decision\n\nStatus: implemented\n\n## Problem\nA repeated choice needed a durable reason.\n\n## Decision\nUse one owner.\n\n## Alternatives considered\nA second owner would drift.\n\n## Consequences\nThe owner must be maintained.\n',
        'implemented',
      ),
    ).toEqual([]);
  });

  it('accepts an explicit absence of alternatives in a migrated historical note', () => {
    expect(
      validateAgentNote(
        '# Agent Note: Historical decision\n\nStatus: implemented\n\n## Problem\nThe old reason was not recorded.\n\n## Decision\nKeep the established boundary.\n\n<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->\n\n## Consequences\nThe original alternative remains unknown.\n',
        'implemented',
      ),
    ).toEqual([]);
  });

  it('rejects a proposed note without acceptance criteria or risks', () => {
    expect(
      validateAgentNote(
        '# Agent Note: Proposal\n\nStatus: proposed\n\n## Problem\nUnclear boundary.\n\n## Proposal\nChange it.\n\n## Alternatives considered\nKeep it.\n',
        'proposed',
      ),
    ).toEqual(['missing ## Acceptance criteria', 'missing ## Risks']);
  });

  it('rejects status that disagrees with the note directory', () => {
    expect(
      validateAgentNote(
        '# Agent Note: Moved decision\n\nStatus: rejected — invalid\n\n## Problem\nA choice was rejected.\n\n## Proposal\nRejected.\n\n## Alternatives considered\nAnother choice.\n',
        'implemented',
      ),
    ).toContain('third line must be Status: implemented');
  });

  it('requires archived metadata and rejects proposal sections in implemented Notes', () => {
    const source =
      '# Agent Note: Archived\n\nStatus: implemented\n\n## Problem\nPast choice.\n\n## Decision\nChoice.\n\n## Alternatives considered\nOther.\n\n## Proposal\nNew work.\n\n## Consequences\nCost.\n';
    expect(validateAgentNote(source, 'implemented', true)).toContain(
      'archived note must declare Archived: YYYY-MM-DD before ## Problem',
    );
    expect(validateAgentNote(source, 'implemented', true)).toContain(
      'implemented note must not contain ## Proposal',
    );
  });

  it('enforces required section order and a closed Note classification path', () => {
    const source =
      '# Agent Note: Choice\n\nStatus: implemented\n\n## Problem\nChoice.\n\n## Decision\nA.\n\n## Consequences\nCost.\n\n## Alternatives considered\nB.\n';
    expect(validateAgentNote(source, 'implemented')).toContain('## Consequences is out of order');
    const repository = mkdtempSync(join(tmpdir(), 'kite-agent-note-'));
    try {
      const directory = join(repository, '.agents/notes/implemented/unknown');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, '2026-01-01-choice.md'), source);
      expect(validateAgentNotes(repository)).toContain(
        '.agents/notes/implemented/unknown/2026-01-01-choice.md: expected .agents/notes/<state>/<class>/YYYY-MM-DD-slug.md',
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
