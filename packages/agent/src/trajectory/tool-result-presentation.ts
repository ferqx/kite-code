import { type ToolResultPresentation, toolResultPresentationSchema } from '@kite-ai/trajectory';
import { canonicalJson } from '../json';
import { mcpToolResultContent } from '../mcp/result-feedback';
import type { Json } from '../storage/types';

const object = (value: Json | undefined): Record<string, Json> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
const pick = (
  value: Record<string, Json>,
  names: string[],
  type: 'string' | 'boolean' | 'number',
) =>
  Object.fromEntries(
    names.flatMap((key) => (typeof value[key] === type ? [[key, value[key]!]] : [])),
  );

/** Called by the original write transaction with the frozen registered definition.
 * Unknown versions and arbitrary detail objects keep their public text fallback.
 */
export function toolResultPresentation(input: {
  definitionId: string;
  definitionVersion: string;
  extensionId: string;
  executionId: string;
  input: Json;
  result: Json;
}): ToolResultPresentation | undefined {
  const result = object(input.result),
    args = object(input.input) ?? {};
  if (!result) return;
  const details = object(result.details) ?? {};
  let content: Record<string, Json> = {};
  try {
    content = object(JSON.parse(String(result.content)) as Json) ?? {};
  } catch {
    /* Plain public text remains unchanged. */
  }
  const id = input.definitionId,
    version = input.definitionVersion,
    extension = input.extensionId;
  let view: unknown;
  if (
    extension === 'builtin.files' &&
    ((id === 'files.read' && ['4', '5'].includes(version)) ||
      (id === 'files.write' && version === '3') ||
      (id === 'files.edit' && version === '2'))
  ) {
    if (typeof content.path !== 'string') return;
    if (content.executionId !== undefined && content.executionId !== input.executionId) return;
    const selection = object(content.selection) ?? {};
    view = {
      kind: 'file',
      operation: id.slice(6),
      path: content.path,
      ...(typeof content.content === 'string' ? { text: content.content } : {}),
      ...(typeof selection.fromLine === 'number' ? { startLine: selection.fromLine } : {}),
      ...(typeof selection.toLine === 'number' ? { endLine: selection.toLine } : {}),
      ...pick(content, ['truncated'], 'boolean'),
    };
  } else if (
    extension === 'builtin.shell' &&
    version === '1' &&
    ['shell.execute', 'shell.launch', 'shell.read', 'shell.wait', 'shell.stop'].includes(id)
  ) {
    // The native receipt must agree byte-for-byte with the public receipt.
    if (canonicalJson(content) !== canonicalJson(details)) return;
    const ref = object(details.ref),
      observed = object(details.execution),
      output = object(details.output);
    if (ref?.extensionId !== 'builtin.shell' || typeof ref.executionId !== 'string') return;
    if (observed && observed.id !== ref.executionId) return;
    const operationResult = object(observed?.result),
      operationDetails = object(operationResult?.details);
    const items = Array.isArray(output?.items)
      ? output.items.map((item) => {
          const row = object(item) ?? {};
          return {
            sequence: row.seq,
            throughSequence: row.throughSeq ?? row.seq,
            stream: row.stream,
            content: row.content,
            ...(typeof row.droppedBytes === 'string' ? { droppedBytes: row.droppedBytes } : {}),
          };
        })
      : undefined;
    view = {
      kind: 'shell',
      operation: id.slice(6),
      executionId: ref.executionId,
      ...(typeof ref.key === 'string' ? { shellId: ref.key } : {}),
      ...(typeof observed?.status === 'string' ? { status: observed.status } : {}),
      ...pick(
        details,
        ['accepted', 'cancelRequested', 'timedOut', 'truncated', 'terminal'],
        'boolean',
      ),
      ...pick(details, ['stdout', 'stderr', 'droppedBytes'], 'string'),
      ...(typeof operationDetails?.exitCode === 'number'
        ? { exitCode: operationDetails.exitCode }
        : {}),
      ...(typeof details.next_cursor === 'string' ? { nextCursor: details.next_cursor } : {}),
      ...(typeof details.caught_up === 'boolean' ? { caughtUp: details.caught_up } : {}),
      ...(items ? { output: items } : {}),
    };
  } else if (
    extension === 'builtin.web' &&
    id === 'web_fetch' &&
    version === '1' &&
    details.executionId === input.executionId
  ) {
    view = {
      kind: 'web',
      ...pick(details, ['title', 'contentType'], 'string'),
      ...pick(details, ['truncated'], 'boolean'),
      ...pick(details, ['characters'], 'number'),
      ...(typeof args.url === 'string' ? { url: args.url } : {}),
    };
  } else if (extension === 'builtin.browser' && version === '1' && id === 'browser.execute') {
    if (
      typeof details.output !== 'string' ||
      content.output !== details.output ||
      canonicalJson(content.operations ?? null) !== canonicalJson(details.operations ?? null)
    )
      return;
    // Interpreter output is already public text; do not guess observations from arbitrary returned JSON.
    view = { kind: 'browser', operation: 'execute', text: details.output };
  } else if (
    extension === 'builtin.browser' &&
    version === '1' &&
    [
      'open',
      'snapshot',
      'click',
      'fill',
      'scroll',
      'press',
      'hover',
      'select',
      'wait',
      'back',
      'forward',
      'reload',
      'close',
      'capture',
      'image',
      'view',
      'request_human',
    ].some((name) => id === `browser.${name}`)
  ) {
    if (canonicalJson(content) !== canonicalJson(details)) return;
    view = {
      kind: 'browser',
      operation: id.slice(8),
      ...pick(details, ['url', 'title', 'text', 'state'], 'string'),
      ...(typeof details.snapshot === 'string' ? { text: details.snapshot } : {}),
      ...(typeof details.seq === 'string' ? { sequence: details.seq } : {}),
      ...(Array.isArray(details.elements)
        ? {
            elements: details.elements.flatMap((item) => {
              const row = object(item);
              return row && typeof row.role === 'string'
                ? [pick(row, ['role', 'name'], 'string')]
                : [];
            }),
          }
        : {}),
    };
  } else if (
    extension === 'builtin.task' &&
    version === '1' &&
    ['spawn', 'follow_up', 'message', 'events', 'list', 'interrupt'].some(
      (name) => id === `task.${name}`,
    )
  ) {
    if (canonicalJson(content) !== canonicalJson(details)) return;
    view = {
      kind: 'task',
      operation: id.slice(5),
      ...(typeof details.agent_id === 'string' ? { agentId: details.agent_id } : {}),
      ...(typeof details.state === 'string' ? { status: details.state } : {}),
      ...pick(details, ['accepted'], 'boolean'),
      ...pick(details, ['delivery'], 'string'),
    };
  } else if (
    extension === 'builtin.planning' &&
    version === '1' &&
    ['read', 'write', 'update', 'review'].some((name) => id === `planning.${name}`)
  ) {
    const plan = object(details.plan) ?? details;
    view = {
      kind: 'plan',
      operation: id.slice(9),
      ...pick(plan, ['planId', 'status', 'title'], 'string'),
      ...(typeof plan.body === 'string' ? { text: plan.body } : {}),
      ...(Array.isArray(plan.steps)
        ? {
            steps: plan.steps.map((item) =>
              pick(object(item) ?? {}, ['id', 'title', 'status'], 'string'),
            ),
          }
        : {}),
      ...(typeof plan.version === 'number' || typeof plan.version === 'string'
        ? { version: plan.version }
        : {}),
    };
  } else if (extension === 'builtin.shell' && version === '1' && id === 'git.worktree') {
    view = {
      kind: 'worktree',
      operation: typeof details.action === 'string' ? details.action : 'unknown',
      ...pick(details, ['path', 'mutation', 'code'], 'string'),
      ...pick(details, ['cwdChanged', 'replayed'], 'boolean'),
    };
  } else if (
    extension === 'builtin.skills' &&
    version === '1' &&
    ['skills.load', 'skills.resource'].includes(id)
  ) {
    view = {
      kind: 'skill',
      operation: id.slice(7),
      ...pick(details, ['version'], 'string'),
      ...(typeof args.id === 'string' ? { name: args.id } : {}),
      ...(typeof result.content === 'string' ? { text: result.content } : {}),
    };
  } else if (extension === 'builtin.ask-user' && version === '1' && id === 'ask_user') {
    const answers = object(details.answers);
    if (answers && Array.isArray(args.questions))
      view = {
        kind: 'question',
        answers: args.questions.flatMap((item) => {
          const question = object(item),
            answer = question && typeof question.id === 'string' ? answers[question.id] : undefined;
          return question && typeof question.question === 'string' && typeof answer === 'string'
            ? [{ question: question.question, answer }]
            : [];
        }),
      };
  } else if (
    extension.startsWith('builtin.mcp.remote.') &&
    id.startsWith(`mcp.${extension.slice('builtin.mcp.remote.'.length)}.`) &&
    /^mcp\..+\.[a-f0-9]{32}$/.test(id) &&
    /^[a-f0-9]{64}$/.test(version) &&
    Array.isArray(details.content) &&
    result.content === mcpToolResultContent(details as { content: unknown; isError?: boolean })
  ) {
    view = {
      kind: 'mcp',
      isError: details.isError === true,
      text: details.content.flatMap((item) => {
        const row = object(item);
        return row?.type === 'text' && typeof row.text === 'string' ? [row.text] : [];
      }),
      ...(details.structuredContent === undefined
        ? {}
        : { structuredContent: details.structuredContent }),
    };
  }
  const parsed = toolResultPresentationSchema.safeParse(view);
  return parsed.success ? parsed.data : undefined;
}
