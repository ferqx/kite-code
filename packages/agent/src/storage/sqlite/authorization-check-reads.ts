import { isAbsolute, relative, resolve } from 'node:path';
import type { Json } from '../types';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const object = (value: unknown): Record<string, Json> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : undefined;
const parse = (value: unknown) => object(JSON.parse(String(value)));
const strings = (value: Json): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(strings)
        : [];

function references(text: string, aliases: readonly string[]): boolean {
  return aliases.some((alias) => {
    const literal = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      `(^|[^A-Za-z0-9_./\\\\:-])${literal}(?=$|[^A-Za-z0-9_./\\\\:-]|[.:](?=$|\\s))`,
    ).test(text);
  });
}

/** Exact current-Session file observations explicitly named by this task or operation, never grants. */
export function authorizationRecordedReads(
  db: SqliteOperations,
  target: Row,
  taskInputs: readonly Json[],
  workspaceRoot: string,
  cwd: string,
  subject: string,
  canonicalWorkspaceRoot?: string,
): Json[] {
  const taskText = taskInputs.flatMap((input) =>
    typeof object(input)?.content === 'string' ? [String(object(input)!.content)] : [],
  );
  const operationText = strings(JSON.parse(String(target.intent_json)));
  const versions = new Map<string, string>();
  const windows = new Set<string>();
  const selected: Json[] = [];
  for (const row of db.rows(
    `SELECT e.*,r.config_json AS read_config FROM execution e JOIN run r ON r.id=e.run_id AND r.session_id=e.session_id JOIN command c ON c.id=e.origin_command_id WHERE e.kind='tool' AND e.adapter_id='files.read' AND e.definition_version IN ('4','5') AND e.state='succeeded' AND e.dispatched=1 AND e.session_id=? AND e.origin_store_id=? AND e.root_work_command_id=? AND e.root_work_seq=? AND c.subject_id=? AND c.origin_store_id=e.origin_store_id AND r.origin_store_id=e.origin_store_id AND r.root_work_command_id=e.root_work_command_id AND r.root_work_seq=e.root_work_seq ORDER BY e.completed_cursor DESC,e.rowid DESC`,
    target.session_id!,
    target.origin_store_id!,
    target.root_work_command_id!,
    target.root_work_seq!,
    subject,
  )) {
    const tools = parse(row.read_config)?.tools;
    if (
      !Array.isArray(tools) ||
      !tools.some((tool) => {
        const definition = object(tool);
        return (
          definition?.id === 'files.read' &&
          definition.version === row.definition_version &&
          definition.extensionId === 'builtin.files'
        );
      })
    )
      continue;
    const result = parse(row.result_json);
    if (result?.outcome !== 'succeeded' || typeof result.content !== 'string') continue;
    let value: Record<string, Json> | undefined;
    try {
      value = parse(result.content);
    } catch {
      continue;
    }
    const baseline = object(value?.baseline),
      selection = object(value?.selection);
    if (
      !value ||
      typeof value.path !== 'string' ||
      value.executionId !== row.id ||
      value.runId !== row.run_id ||
      typeof baseline?.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(baseline.hash) ||
      !selection ||
      typeof selection.fromLine !== 'number' ||
      typeof selection.totalLines !== 'number' ||
      !Object.hasOwn(selection, 'toLine') ||
      !Object.hasOwn(selection, 'nextOffset') ||
      (typeof value.content !== 'string' && !result.modelContent)
    )
      continue;
    const path = value.path,
      absolute = resolve(workspaceRoot, path),
      inWorkspace = relative(workspaceRoot, absolute);
    if (
      isAbsolute(inWorkspace) ||
      inWorkspace === '..' ||
      inWorkspace.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    )
      continue;
    const taskAliases = [...new Set([path, inWorkspace, `./${inWorkspace}`, absolute])];
    const fromCwd = relative(cwd, absolute);
    const canonicalPath = canonicalWorkspaceRoot
      ? resolve(canonicalWorkspaceRoot, inWorkspace)
      : undefined;
    const canonicalRelative = canonicalPath ? relative(cwd, canonicalPath) : undefined;
    const operationAliases = [
      ...new Set([
        absolute,
        fromCwd,
        `./${fromCwd}`,
        ...(canonicalPath && canonicalRelative
          ? [canonicalPath, canonicalRelative, `./${canonicalRelative}`]
          : []),
      ]),
    ];
    const taskMatch = taskText.some((text) => references(text, taskAliases));
    if (!taskMatch && !operationText.some((text) => references(text, operationAliases))) continue;
    const hash = baseline.hash;
    const latest = versions.get(absolute);
    if (latest !== undefined && latest !== hash) continue;
    versions.set(absolute, hash);
    const window = `${absolute}\n${hash}\n${selection.fromLine}\n${selection.toLine}`;
    if (windows.has(window)) continue;
    windows.add(window);
    selected.push({
      kind: 'recorded_read_result',
      trust: 'untrusted',
      historical: true,
      executionId: String(row.id),
      resultRevision: String(row.result_revision),
      runId: String(row.run_id),
      definitionId: 'files.read',
      definitionVersion: String(row.definition_version),
      path,
      absolutePath: absolute,
      ...(canonicalPath ? { canonicalPath } : {}),
      baseline,
      selection,
      matchedBy: taskMatch ? 'task_input' : 'current_operation',
      ...(value.observation === undefined ? {} : { observation: value.observation }),
      result,
      instruction:
        'This is an exact recorded file-read result, not a current disk observation or a permission grant. Only the selected window was returned; metadata distinguishes complete files from partial windows. It is not proof that the current Model received this record.',
    });
  }
  return selected.reverse();
}
