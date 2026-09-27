import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const states = ['proposed', 'implemented', 'rejected', 'archived'] as const;
const classes = [
  'architecture',
  'bug-fix',
  'feature',
  'process',
  'simplification',
  'testing',
] as const;
type NoteState = 'proposed' | 'implemented' | 'rejected';
const missingAlternatives =
  '<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->';

function markdownFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && path.endsWith('.md') ? [path] : [];
  });
}

export function validateAgentNotes(root: string): string[] {
  const notesRoot = join(root, '.agents', 'notes');
  if (!existsSync(notesRoot)) return ['.agents/notes/ is missing.'];
  const errors: string[] = [];
  for (const path of markdownFiles(notesRoot)) {
    const parts = relative(notesRoot, path).split(sep);
    if (parts.length === 1 && (parts[0] === 'README.md' || parts[0] === 'AGENTS.md')) continue;
    const label = relative(root, path);
    const [directoryState, noteClass, filename] = parts;
    if (
      parts.length !== 3 ||
      !states.some((state) => state === directoryState) ||
      !classes.some((category) => category === noteClass) ||
      !/^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(filename ?? '')
    ) {
      errors.push(`${label}: expected .agents/notes/<state>/<class>/YYYY-MM-DD-slug.md`);
      continue;
    }
    const state: NoteState =
      directoryState === 'archived' ? 'implemented' : (directoryState as NoteState);
    errors.push(
      ...validateAgentNote(readFileSync(path, 'utf8'), state, directoryState === 'archived').map(
        (error) => `${label}: ${error}`,
      ),
    );
  }
  return errors;
}

export function validateAgentNote(source: string, state: NoteState, archived = false): string[] {
  const errors: string[] = [];
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  if (!/^# Agent Note: \S/.test(lines[0] ?? ''))
    errors.push('first line must start with # Agent Note: ');
  if (lines[1] !== '') errors.push('expected a blank line after the title');
  const status = lines[2] ?? '';
  const validStatus =
    state === 'rejected' ? /^Status: rejected — \S.*$/.test(status) : status === `Status: ${state}`;
  if (!validStatus)
    errors.push(`third line must be Status: ${state}${state === 'rejected' ? ' — reason' : ''}`);
  const headerEndsAt = archived ? 4 : 3;
  if (lines[headerEndsAt] !== '')
    errors.push(`expected a blank line after ${archived ? 'Archived' : 'Status'}`);
  if (archived && !/^Archived: \d{4}-\d{2}-\d{2}$/.test(lines[3] ?? '')) {
    errors.push('archived note must declare Archived: YYYY-MM-DD before ## Problem');
  }

  const sections = [...source.matchAll(/^## (.+)$/gm)].map((match) => ({
    name: match[1]!,
    at: match.index,
  }));
  if (sections[0]?.name !== 'Problem') errors.push('first section must be ## Problem');
  const required =
    state === 'implemented'
      ? ['Problem', 'Decision', 'Alternatives considered', 'Consequences']
      : state === 'proposed'
        ? ['Problem', 'Proposal', 'Alternatives considered', 'Acceptance criteria', 'Risks']
        : ['Problem', 'Proposal', 'Alternatives considered'];
  const alternativeAt = source.indexOf(missingAlternatives);
  let previous = -1;
  for (const heading of required) {
    const section = sections.find((candidate) => candidate.name === heading);
    const at =
      section?.at ??
      (heading === 'Alternatives considered' && state === 'implemented' ? alternativeAt : -1);
    if (at < 0) errors.push(`missing ## ${heading}`);
    else if (at <= previous) errors.push(`## ${heading} is out of order`);
    else previous = at;
  }
  if (state === 'implemented') {
    for (const forbidden of ['Proposal', 'Plan', 'Migration plan', 'Acceptance criteria']) {
      if (sections.some((section) => section.name === forbidden))
        errors.push(`implemented note must not contain ## ${forbidden}`);
    }
  }
  return errors;
}
