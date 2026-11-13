import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export type OfficeFixtureMessage = { role: string; content?: unknown; tool_call_id?: string };
const attachmentMarker =
  '\n\nAttached file references (user-provided data; paths do not grant permissions):\n';
function instruction(message: OfficeFixtureMessage) {
  if (message.role !== 'user' || typeof message.content !== 'string') return null;
  if (
    message.content === 'Generate an office report.' ||
    message.content === 'Modify the attached report.'
  )
    return { text: message.content, workingPath: undefined as string | undefined };
  const prefix = `Modify the attached report.${attachmentMarker}`;
  if (!message.content.startsWith(prefix)) return null;
  try {
    const files = JSON.parse(message.content.slice(prefix.length));
    if (
      !Array.isArray(files) ||
      files.length !== 1 ||
      files[0]?.name !== 'report.docx' ||
      typeof files[0]?.uri !== 'string' ||
      !files[0].uri.startsWith('file://') ||
      !files[0].uri.includes('/.kite-inputs/') ||
      !files[0].uri.endsWith('/input-report.docx') ||
      Object.keys(files[0]).sort().join(',') !== 'name,uri'
    )
      return null;
    const url = new URL(files[0].uri);
    const workingPath = fileURLToPath(url);
    if (
      url.search ||
      url.hash ||
      !workingPath.includes('/.kite-inputs/') ||
      !workingPath.endsWith('/input-report.docx')
    )
      return null;
    return { text: 'Modify the attached report.', workingPath };
  } catch {
    return null;
  }
}
/** Accept only exact observer inputs, including the production attachment envelope, never runtime facts. */
export function officeFixtureDecision(messages: readonly OfficeFixtureMessage[]) {
  const turns = messages.filter((message) => instruction(message) !== null);
  const user = turns.at(-1);
  if (!user) throw Error('exact_fixture_user_turn_required');
  const current = messages.slice(messages.lastIndexOf(user) + 1);
  const selected = instruction(user)!;
  const editing = selected.text === 'Modify the attached report.';
  if (editing && !selected.workingPath) throw Error('exact_working_input_required');
  return {
    toolId: `office-${createHash('sha256')
      .update(JSON.stringify([turns.length, selected.text]))
      .digest('hex')
      .slice(0, 16)}`,
    toolTurn: !current.some(
      (message) => message.role === 'tool' && message.tool_call_id?.startsWith('office-'),
    ),
    editing,
    workingPath: selected.workingPath,
  };
}
