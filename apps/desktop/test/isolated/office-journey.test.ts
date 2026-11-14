import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { officeJourneyDecision, validateOfficeFixtureRoot } from '../office-journey.fixture';

const marker =
  '\n\nAttached file references (user-provided data; paths do not grant permissions):\n';

test('each format emits one exact command and never retries success, failure or unknown', () => {
  for (const format of ['docx', 'xlsx', 'pptx']) {
    const user = { role: 'user', content: `Generate fixture ${format}.` };
    const first = officeJourneyDecision([user], '/unused', 'officecli');
    expect(first.command).toContain(`generated.${format}`);
    expect(first.toolTurn).toBe(true);
    for (const receipt of ['ok', 'error', 'outcome_unknown']) {
      const done = officeJourneyDecision(
        [
          user,
          { role: 'tool', tool_call_id: first.toolId, content: receipt },
          { role: 'user', content: 'Runtime reports unknown. Do not restart.' },
        ],
        '/unused',
        'officecli',
      );
      expect(done.toolTurn).toBe(false);
      expect(done.toolId).toBe(first.toolId);
    }
  }
});

test('local references select exact escaped path, preserve original, and reject outside files', () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-office-e2e-'));
  const outside = mkdtempSync(join(tmpdir(), 'kite-office-other-'));
  try {
    const source = join(root, "中文 ' # %.docx");
    writeFileSync(source, 'synthetic');
    const user = (path: string) => ({
      role: 'user',
      content: `Process fixture docx.${marker}${JSON.stringify([{ name: 'input.docx', uri: pathToFileURL(path).href }])}`,
    });
    const decision = officeJourneyDecision([user(source)], root, 'officecli');
    expect(decision.workingPath).toBe(source);
    expect(decision.command).toStartWith('cp ');
    expect(decision.command).toContain('processed.docx');
    expect(decision.command).toContain("'\\''");
    const other = join(outside, 'other.docx');
    writeFileSync(other, 'outside');
    expect(() => officeJourneyDecision([user(other)], root, 'officecli')).toThrow(
      'fixture_source_outside_owned_root',
    );
    expect(() =>
      officeJourneyDecision(
        [{ role: 'user', content: 'Process fixture docx.' }],
        root,
        'officecli',
      ),
    ).toThrow();
    expect(() =>
      officeJourneyDecision([{ role: 'user', content: 'Do something' }], root, 'officecli'),
    ).toThrow();
    expect(() => validateOfficeFixtureRoot(root)).not.toThrow();
    expect(() => validateOfficeFixtureRoot(outside)).toThrow();
    expect(() => validateOfficeFixtureRoot('/')).toThrow();
    expect(() => validateOfficeFixtureRoot('relative')).toThrow();
  } finally {
    rmSync(root, { recursive: true });
    rmSync(outside, { recursive: true });
  }
});
