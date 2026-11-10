import {
  type ToolResultPresentation,
  type TrajectoryDisplay,
  trajectoryDisplaySchema,
} from '@kite-ai/trajectory';
import { canonicalJson } from '../../json';
import { readModelIdentifier } from '../../model-identifier';
import { toolTrajectoryDisplay } from '../../trajectory/display';
import type { Json } from '../types';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const object = (value: unknown): Record<string, Json> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : undefined;
const parsed = (value: unknown): Json =>
  typeof value === 'string' ? (JSON.parse(value) as Json) : null;

/** Match the original deciding Model's frozen binding, never today's registry. */
export function trajectoryToolDefinition(
  db: SqliteOperations,
  row: Row,
): Record<string, Json> | undefined {
  if (row.kind !== 'tool' || !row.run_id) return;
  const config = object(
    parsed(
      db.row('SELECT config_json FROM run WHERE id=? AND session_id=?', row.run_id, row.session_id!)
        ?.config_json,
    ),
  );
  const decision = object(parsed(row.decision_source_json));
  const model =
    typeof decision?.modelExecutionId === 'string'
      ? db.row(
          "SELECT * FROM execution WHERE id=? AND session_id=? AND run_id=? AND origin_store_id=? AND kind='model'",
          decision.modelExecutionId,
          row.session_id!,
          row.run_id,
          row.origin_store_id!,
        )
      : null;
  const source = model ? object(parsed(model.decision_source_json)) : undefined;
  const definitions =
    source?.kind === 'model_request' &&
    source.requestId === model?.id &&
    Array.isArray(source.toolBindings)
      ? source.toolBindings
      : config?.tools;
  return Array.isArray(definitions)
    ? definitions
        .map(object)
        .find(
          (item) => item && item.id === row.adapter_id && item.version === row.definition_version,
        )
    : undefined;
}

function ownedShellTarget(
  db: SqliteOperations,
  row: Row,
  ref: Record<string, Json>,
  targetId: string,
) {
  const target = db.row(
    'SELECT * FROM execution WHERE id=? AND session_id=? AND origin_store_id=?',
    targetId,
    row.session_id!,
    row.origin_store_id!,
  );
  if (
    target?.kind !== 'job' ||
    target.adapter_id !== 'shell.command' ||
    target.definition_version !== '1' ||
    ref.extensionId !== 'builtin.shell' ||
    ref.executionId !== target.id ||
    ref.originStoreId !== target.origin_store_id ||
    ref.sessionId !== target.session_id ||
    ref.commandId !== target.origin_command_id ||
    !target.parent_execution_id
  )
    return;
  const starter = db.row(
    'SELECT * FROM execution WHERE id=? AND session_id=? AND origin_store_id=?',
    target.parent_execution_id,
    row.session_id!,
    row.origin_store_id!,
  );
  if (
    !starter ||
    !['shell.execute', 'shell.launch'].includes(String(starter.adapter_id)) ||
    starter.definition_version !== '1' ||
    trajectoryToolDefinition(db, starter)?.extensionId !== 'builtin.shell'
  )
    return;
  if (['shell.execute', 'shell.launch'].includes(String(row.adapter_id))) {
    if (starter.id !== row.id) return;
  } else if (object(parsed(row.intent_json))?.shellId !== ref.key) return;
  return target;
}

function ownedAgentTarget(db: SqliteOperations, row: Row, id: string, agentId?: Json) {
  const target = db.row(
    "SELECT e.* FROM execution e JOIN command c ON c.id=e.origin_command_id JOIN session child ON child.id=e.child_session_id WHERE e.id=? AND e.session_id=? AND e.origin_store_id=? AND e.kind='job' AND c.kind='operation.agent' AND c.extension_id='builtin.task' AND c.origin_store_id=e.origin_store_id AND child.parent_id=e.session_id",
    id,
    row.session_id!,
    row.origin_store_id!,
  );
  if (!target || (typeof agentId === 'string' && target.child_session_id !== agentId)) return;
  return target;
}

function childRunId(db: SqliteOperations, target: Row): string | undefined {
  const runId = object(parsed(target.reference_json))?.runId;
  if (typeof runId !== 'string') return;
  const run = db.row(
    'SELECT id FROM run WHERE id=? AND session_id=? AND origin_store_id=? AND origin_command_id=? AND root_work_command_id=? AND root_work_seq=?',
    runId,
    target.child_session_id!,
    target.origin_store_id!,
    `child-start-${target.id}`,
    target.root_work_command_id!,
    target.root_work_seq!,
  );
  return run ? String(run.id) : undefined;
}

/** Public target observations are sealed only after the original owner identity is verified. */
export function trajectoryToolDisplay(
  db: SqliteOperations,
  row: Row,
  definition: Record<string, Json> | undefined,
  result: Json,
  presentation?: ToolResultPresentation,
): TrajectoryDisplay | undefined {
  if (typeof definition?.extensionId !== 'string') return;
  const display = toolTrajectoryDisplay({
    definitionId: String(row.adapter_id),
    definitionVersion: String(row.definition_version),
    extensionId: definition.extensionId,
    input: parsed(row.intent_json),
  });
  if (!display) return;
  const body = object(result),
    details = object(body?.details),
    args = object(parsed(row.intent_json)) ?? {};
  if (display.kind === 'shell' && presentation?.kind === 'shell' && details) {
    const ref = object(details.ref);
    const target = ref && ownedShellTarget(db, row, ref, presentation.executionId ?? '');
    if (target) {
      display.targetExecutionId = String(target.id);
      display.targetExecutionOriginStoreId = String(target.origin_store_id);
      display.targetSessionId = String(target.session_id);
      if (target.run_id) display.targetRunId = String(target.run_id);
      const observed = trajectoryDisplaySchema.shape.observedStatus.safeParse(presentation.status);
      if (observed.success && observed.data) display.observedStatus = observed.data;
      for (const key of ['accepted', 'terminal', 'cancelRequested', 'timedOut'] as const)
        if (typeof presentation[key] === 'boolean') display[key] = presentation[key];
      if (Number.isSafeInteger(presentation.exitCode)) display.exitCode = presentation.exitCode;
    }
  }
  if (
    display.kind === 'task' &&
    details &&
    typeof body?.content === 'string' &&
    body.content === canonicalJson(details)
  ) {
    let id: string | undefined;
    const work =
      typeof details.work_ref === 'string'
        ? details.work_ref
        : Array.isArray(args.workRefs) && args.workRefs.length === 1
          ? args.workRefs[0]
          : args.workRef;
    try {
      if (typeof work === 'string' && work.startsWith('aw_'))
        id = readModelIdentifier(work.slice(3));
    } catch {
      /* Unverified references remain plain observations. */
    }
    const target = id ? ownedAgentTarget(db, row, id, details.agent_id ?? args.agentId) : undefined;
    if (target) {
      display.targetExecutionId = String(target.id);
      display.targetExecutionOriginStoreId = String(target.origin_store_id);
      display.targetSessionId = String(target.child_session_id);
      const runId = childRunId(db, target);
      if (runId) display.targetRunId = runId;
      if (typeof details.accepted === 'boolean') display.accepted = details.accepted;
      // Admission state is not an execution terminal and never becomes observedStatus.
    } else if (
      typeof args.agentId === 'string' &&
      db.row('SELECT id FROM session WHERE id=? AND parent_id=?', args.agentId, row.session_id!)
    )
      display.targetSessionId = args.agentId;
  }
  return trajectoryDisplaySchema.parse(display);
}

export function trajectoryJobDisplay(
  db: SqliteOperations,
  row: Row,
): TrajectoryDisplay | undefined {
  const command = db.row(
    'SELECT kind,extension_id,origin_store_id FROM command WHERE id=? AND session_id=?',
    row.origin_command_id!,
    row.session_id!,
  );
  if (!command || command.origin_store_id !== row.origin_store_id) return;
  if (
    command.kind === 'operation.job' &&
    command.extension_id === 'builtin.shell' &&
    row.adapter_id === 'shell.command' &&
    row.definition_version === '1'
  )
    return {
      kind: 'shell',
      operation: 'execute',
      title: 'Shell 命令',
      targetExecutionId: String(row.id),
      targetExecutionOriginStoreId: String(row.origin_store_id),
      targetSessionId: String(row.session_id),
    };
  if (
    command.kind === 'operation.agent' &&
    command.extension_id === 'builtin.task' &&
    row.child_session_id &&
    ownedAgentTarget(db, row, String(row.id))
  ) {
    const runId = childRunId(db, row);
    return {
      kind: 'task',
      operation: 'spawn',
      title: '子 Agent 工作',
      targetExecutionId: String(row.id),
      targetExecutionOriginStoreId: String(row.origin_store_id),
      targetSessionId: String(row.child_session_id),
      ...(runId ? { targetRunId: runId } : {}),
    };
  }
  return;
}
