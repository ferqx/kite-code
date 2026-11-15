import { isAbsolute, relative, resolve, sep } from 'node:path';
import { authorizationCheckContexts } from '../../authorization-check-input';
import { canonicalJson } from '../../json';
import type { Json } from '../types';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const object = (value: unknown): Record<string, Json> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : undefined;
const parse = (value: unknown) => {
  try {
    return object(JSON.parse(String(value)));
  } catch {
    return undefined;
  }
};
const identity = (value: unknown) => {
  const id = object(value);
  return id &&
    typeof id.device === 'string' &&
    /^\d+$/.test(id.device) &&
    typeof id.inode === 'string' &&
    /^\d+$/.test(id.inode)
    ? { device: id.device, inode: id.inode }
    : null;
};
function location(value: unknown, root: string, canonicalRoot: string): string | null {
  if (
    typeof value !== 'string' ||
    !value ||
    value.split(/[\\/]/).some((part) => part === '..' || part === '.')
  )
    return null;
  const inside = (base: string) => {
    const path = relative(base, resolve(base, value));
    return path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) ? path : null;
  };
  const path = inside(root) ?? (isAbsolute(value) ? inside(canonicalRoot) : null);
  return path ? resolve(canonicalRoot, path) : null;
}

/** Durable, earlier same-run write facts. Native identity is supplied only by the trusted Host. */
export function authorizationRecordedMutations(
  db: SqliteOperations,
  target: Row,
  request: Json,
  workspaceRoot: string,
): Record<string, Json> {
  if (
    target.kind !== 'tool' ||
    target.adapter_id !== 'files.read' ||
    target.definition_version !== '5' ||
    !target.run_id
  )
    return {};
  const observations = authorizationCheckContexts(request)
    .map((context) => object(context.currentFileTarget))
    .filter((value) => value !== undefined);
  const current = observations[0];
  if (
    !current ||
    observations.some((value) => canonicalJson(value) !== canonicalJson(current)) ||
    current.kind !== 'native_workspace_file_identity' ||
    typeof current.workspaceRoot !== 'string' ||
    !isAbsolute(current.workspaceRoot) ||
    typeof current.canonicalPath !== 'string' ||
    !identity(current.rootIdentity) ||
    !identity(current.parentIdentity)
  )
    return {};
  const fileIdentity = identity(current.fileIdentity);
  const input = parse(target.intent_json);
  if (
    !fileIdentity ||
    location(input?.path, workspaceRoot, current.workspaceRoot) !== current.canonicalPath ||
    location(current.path, workspaceRoot, current.workspaceRoot) !== current.canonicalPath
  )
    return {};
  const owner = db.row(
    'SELECT r.config_json,s.workspace_id FROM run r JOIN session s ON s.id=r.session_id WHERE r.id=? AND r.session_id=? AND r.origin_store_id=?',
    target.run_id,
    target.session_id!,
    target.origin_store_id!,
  );
  const tools = parse(owner?.config_json)?.tools;
  const builtin = (id: string, version: string) =>
    Array.isArray(tools) &&
    tools.some((entry) => {
      const tool = object(entry);
      return tool?.id === id && tool.version === version && tool.extensionId === 'builtin.files';
    });
  if (owner?.workspace_id !== current.workspaceId || !builtin('files.read', '5')) return {};
  const before = db.row(
    "SELECT cursor FROM change_event WHERE object_id=? AND scope_session_id=? AND type='execution.planned' ORDER BY cursor LIMIT 1",
    target.id!,
    target.session_id!,
  );
  if (!before) return {};
  for (const row of db.rows(
    "SELECT * FROM execution WHERE session_id=? AND run_id=? AND origin_store_id=? AND root_work_command_id=? AND root_work_seq=? AND kind='tool' AND adapter_id IN ('files.write','files.edit') AND state='succeeded' AND dispatched=1 AND cancel_requested=0 AND cancel_requested_at IS NULL AND completed_cursor IS NOT NULL AND completed_cursor<? ORDER BY completed_cursor DESC",
    target.session_id!,
    target.run_id,
    target.origin_store_id!,
    target.root_work_command_id!,
    target.root_work_seq!,
    before.cursor!,
  )) {
    if (
      row.id === target.id ||
      !(
        (row.adapter_id === 'files.write' && row.definition_version === '3') ||
        (row.adapter_id === 'files.edit' && row.definition_version === '2')
      ) ||
      !builtin(String(row.adapter_id), String(row.definition_version))
    )
      continue;
    const result = parse(row.result_json),
      value = parse(result?.content),
      baseline = object(value?.baseline);
    if (
      result?.outcome !== 'succeeded' ||
      value?.executionId !== row.id ||
      value?.runId !== row.run_id ||
      location(parse(row.intent_json)?.path, workspaceRoot, current.workspaceRoot) !==
        current.canonicalPath ||
      location(value?.path, workspaceRoot, current.workspaceRoot) !== current.canonicalPath ||
      canonicalJson(identity(baseline)) !== canonicalJson(fileIdentity)
    )
      continue;
    return {
      recordedFileMutations: [
        {
          kind: 'recorded_file_mutation',
          historical: true,
          currentVersionVerified: false,
          executionId: String(row.id),
          resultRevision: String(row.result_revision),
          runId: String(row.run_id),
          definitionId: String(row.adapter_id),
          definitionVersion: String(row.definition_version),
          canonicalPath: current.canonicalPath,
          fileIdentity,
          status: 'succeeded',
          dispatched: true,
          instruction:
            'This exact same-run file mutation completed before this operation was planned. Its saved native identity matched the current target at review preparation. This is historical evidence only: current bytes were not read or verified, and it grants no permission or exemption from current restrictions.',
        },
      ],
    };
  }
  return {};
}
