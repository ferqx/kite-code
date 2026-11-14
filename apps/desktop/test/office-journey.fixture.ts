/** Deterministic E2E model, not a claim about real-model success. Never retries a tool receipt. */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OfficeFixtureMessage } from './office-model-decision.fixture';

const marker =
  '\n\nAttached file references (user-provided data; paths do not grant permissions):\n';
export const officeFormats = ['docx', 'xlsx', 'pptx'] as const;
export function validateOfficeFixtureRoot(root: string | undefined) {
  if (!root || !isAbsolute(root)) throw Error('explicit_owned_fixture_directory_required');
  if (root.startsWith('/workspace/shared/')) return; // Existing opt-in historical fixture.
  const actual = realpathSync(root);
  if (
    resolve(actual, '..') !== realpathSync(tmpdir()) ||
    !basename(actual).startsWith('kite-office-e2e-')
  )
    throw Error('owned_temporary_fixture_directory_required');
}
function instruction(message: OfficeFixtureMessage) {
  if (message.role !== 'user' || typeof message.content !== 'string') return null;
  const [text, encoded] = message.content.split(marker);
  const match = /^(Generate|Revise|Process) fixture (docx|xlsx|pptx)\.$/.exec(text!);
  if (!match) return null;
  let source: string | undefined;
  if (match[1] !== 'Generate') {
    const files = JSON.parse(encoded ?? 'null');
    if (
      !Array.isArray(files) ||
      files.length !== 1 ||
      Object.keys(files[0]).sort().join(',') !== 'name,uri'
    )
      throw Error('exact_fixture_attachment_required');
    const url = new URL(files[0].uri);
    if (
      url.protocol !== 'file:' ||
      url.search ||
      url.hash ||
      !files[0].name.endsWith(`.${match[2]}`)
    )
      throw Error('exact_fixture_attachment_required');
    source = fileURLToPath(url);
  }
  return { action: match[1]!, format: match[2]!, source };
}
export function officeJourneyDecision(
  messages: readonly OfficeFixtureMessage[],
  root: string,
  cli: string,
) {
  const turns = messages.filter((m) => instruction(m));
  const user = turns.at(-1);
  if (!user) throw Error('exact_fixture_user_turn_required');
  const selected = instruction(user)!;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  if (selected.source) {
    const path = relative(realpathSync(root), realpathSync(selected.source));
    if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))
      throw Error('fixture_source_outside_owned_root');
  }
  const editing = selected.action !== 'Generate';
  const name = `${selected.action === 'Generate' ? 'generated' : selected.action === 'Revise' ? 'revised' : 'processed'}.${selected.format}`;
  const target = `"$KITE_OUTPUT_DIR/${name}"`;
  const value = editing ? 'E2E revised value' : 'E2E original value';
  const create = selected.source
    ? `cp ${quote(selected.source)} ${target}`
    : `${cli} create ${target}`;
  const edit =
    selected.format === 'docx'
      ? `${cli} add ${target} /body --type paragraph --prop ${quote(`text=${value}`)}`
      : selected.format === 'xlsx'
        ? `${cli} set ${target} /Sheet1/A1 --prop ${quote(`value=${value}`)}`
        : `${editing ? '' : `${cli} add ${target} / --type slide && `}${cli} add ${target} '/slide[1]' --type textbox --prop ${quote(`text=${value}`)} --prop x=2cm --prop y=${editing ? 6 : 2}cm --prop width=18cm --prop height=3cm`;
  const toolId = `office-${createHash('sha256')
    .update(JSON.stringify([turns.length, selected]))
    .digest('hex')
    .slice(0, 16)}`;
  return {
    toolId,
    editing,
    workingPath: selected.source,
    toolTurn: !messages
      .slice(messages.lastIndexOf(user) + 1)
      .some((m) => m.role === 'tool' && m.tool_call_id?.startsWith('office-')),
    command: `${create} && ${edit}`,
  };
}

/** Per-open observation, never a product retry policy. Fail only after this target's fresh loading state. */
export function officePreviewObservation(input: {
  targetMatches: boolean;
  preparing: boolean;
  failed: boolean;
  sawPreparing: boolean;
  contentVisible: boolean;
  word: boolean;
  pagination: string | null;
}): { sawPreparing: boolean; outcome: 'waiting' | 'failed' | 'ready' | 'pagination-unavailable' } {
  if (!input.targetMatches) return { sawPreparing: false, outcome: 'waiting' };
  const sawPreparing = input.sawPreparing || input.preparing;
  if (sawPreparing && input.failed) return { sawPreparing, outcome: 'failed' };
  if (!input.contentVisible || input.preparing || input.failed)
    return { sawPreparing, outcome: 'waiting' };
  if (input.word && input.pagination === 'unavailable')
    return { sawPreparing, outcome: 'pagination-unavailable' };
  return {
    sawPreparing,
    outcome: input.word && input.pagination !== 'settled' ? 'waiting' : 'ready',
  };
}

/** Exact visible preview panel; never inspect a global error belonging to another tab. */
export async function readOfficePreviewHost(page: import('playwright').Page, name: string) {
  const panel = page.locator('.native-file-preview').filter({
    has: page.getByRole('group', { name: `${name} 预览工具栏`, exact: true }),
  });
  const targetMatches = (await panel.count()) === 1 && (await panel.isVisible());
  return {
    targetMatches,
    preparing:
      targetMatches && (await panel.getByText('正在准备预览…', { exact: true }).isVisible()),
    failed:
      targetMatches &&
      (await panel.getByText('文件已保存，暂时无法预览', { exact: true }).isVisible()),
  };
}
