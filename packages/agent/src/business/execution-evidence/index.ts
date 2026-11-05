import type { Extension, Json, PublicExecution, ToolContext, ToolResult } from '../../extensions';
import { AgentError } from '../../storage/types';

export interface ExecutionEvidenceReadRequest {
  readonly sessionId: string;
  readonly runId: string;
  readonly callerExecutionId: string;
  readonly executionId?: string;
  readonly cursor?: string;
  readonly limit: number;
  readonly signal: AbortSignal;
}
export interface ExecutionEvidenceRecord {
  readonly execution: PublicExecution;
  /** Host-verified original Tool Run or Job ancestor Run, never inferred from result text. */
  readonly taskRunId: string;
  /** Recorded targets only; their presence does not prove publication or exclusive ownership. */
  readonly paths?: readonly {
    readonly path: string;
    readonly source: 'files_input' | 'files_checkpoint';
  }[];
  readonly shellId?: string;
  readonly checkpoint?: { readonly id: string; readonly state: string };
}
export interface ExecutionEvidencePage {
  readonly items: readonly ExecutionEvidenceRecord[];
  /** Host-owned scoped keyset cursor. Null is the only end-of-list assertion. */
  readonly nextCursor: string | null;
}
export interface ExecutionEvidenceOptions {
  /** Must read the current Session/Run only, with real scoped pagination and no Model bodies. */
  read(request: ExecutionEvidenceReadRequest, context: ToolContext): Promise<ExecutionEvidencePage>;
}

export const executionEvidenceToolId = 'execution_evidence.read';
const extensionId = 'builtin.execution-evidence';
function failure(code: string, message: string): ToolResult {
  return { outcome: 'failed', content: message, details: { code } };
}
const object = (value: Json): Record<string, Json> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
const identifier = (value: unknown, max: number) =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/** Read existing execution evidence on demand; owns no ledger and grants no execution authority. */
export function createExecutionEvidenceExtension(options: ExecutionEvidenceOptions): Extension {
  return {
    id: extensionId,
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: executionEvidenceToolId,
        version: '1',
        model: { name: 'read_execution_evidence', snakeCase: true },
        description:
          'Read recorded Tool/Job evidence from this current task after compaction or when an outcome is unclear. Omit execution_id to list a page of exact receipt IDs, statuses, recorded target paths and original Shell IDs; pass next_cursor as cursor for the next page. Pass an exact execution_id for its complete public result. Targets do not prove a successful file change. Shell history has no complete per-file change capture. Current files and git diff cannot establish who changed them. This read never reruns an operation, reads private Model bodies, or grants permission.',
        inputSchema: {
          type: 'object',
          properties: {
            executionId: { type: 'string', minLength: 1, maxLength: 256 },
            cursor: { type: 'string', minLength: 1, maxLength: 4096 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
        async execute(input, context) {
          const value = object(input);
          if (
            !value ||
            Object.keys(value).some((key) => !['executionId', 'cursor', 'limit'].includes(key)) ||
            (value.executionId !== undefined && !identifier(value.executionId, 256)) ||
            (value.cursor !== undefined && !identifier(value.cursor, 4096)) ||
            (value.executionId !== undefined && value.cursor !== undefined) ||
            (value.limit !== undefined &&
              (typeof value.limit !== 'number' ||
                !Number.isSafeInteger(value.limit) ||
                value.limit < 1 ||
                value.limit > 100))
          )
            return failure(
              'execution_evidence_input_invalid',
              'Use execution_id for one recorded operation, or cursor and limit to list this task. These arguments cannot select another task or agent. This read did not rerun any operation.',
            );
          if (!context.runId)
            return failure(
              'execution_evidence_scope_unavailable',
              'The current task scope is unavailable. No execution history was read and no operation was rerun.',
            );
          context.signal.throwIfAborted();
          const request: ExecutionEvidenceReadRequest = {
            sessionId: context.sessionId,
            runId: context.runId,
            callerExecutionId: context.executionId,
            ...(typeof value.executionId === 'string' ? { executionId: value.executionId } : {}),
            ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
            limit:
              typeof value.executionId === 'string'
                ? 1
                : ((value.limit as number | undefined) ?? 20),
            signal: context.signal,
          };
          let page: ExecutionEvidencePage;
          try {
            page = await options.read(request, context);
          } catch (error) {
            context.signal.throwIfAborted();
            if (error instanceof AgentError && error.code === 'execution_evidence_cursor_invalid')
              return failure(
                error.code,
                'This cursor is not valid for the current task or original page range. Start a new evidence list without cursor; stay within the current task and do not rerun the original operation.',
              );
            if (error instanceof AgentError && error.code === 'execution_evidence_scope_denied')
              return failure(
                error.code,
                "The requested evidence is outside this reader's current task scope. List available records without execution_id to recover an allowed reference. For collaborator work, compare its already available result and source evidence. No unrelated history was returned and no operation was rerun.",
              );
            throw error;
          }
          context.signal.throwIfAborted();
          const seen = new Set<string>();
          if (
            !page ||
            !Array.isArray(page.items) ||
            page.items.length > request.limit ||
            (page.nextCursor !== null && !identifier(page.nextCursor, 4096)) ||
            (page.nextCursor !== null && page.nextCursor === request.cursor) ||
            (request.executionId !== undefined && page.nextCursor !== null) ||
            page.items.some((item: ExecutionEvidenceRecord) => {
              const execution = item?.execution;
              if (
                !execution ||
                !identifier(execution.id, 256) ||
                seen.has(execution.id) ||
                execution.id === context.executionId ||
                execution.definitionId === executionEvidenceToolId ||
                execution.kind === 'model' ||
                !['tool', 'job'].includes(execution.kind) ||
                execution.sessionId !== request.sessionId ||
                item.taskRunId !== request.runId ||
                (execution.runId !== null && execution.runId !== request.runId) ||
                (execution.kind === 'tool' && execution.runId !== request.runId) ||
                (request.executionId !== undefined && execution.id !== request.executionId)
              )
                return true;
              seen.add(execution.id);
              return false;
            })
          )
            return failure(
              'execution_evidence_scope_denied',
              "The original operation could not be verified within this reader's current task scope. List available records without execution_id, or compare an already available collaborator result. No unrelated history was returned. Do not invent an ID or rerun the original operation to recover its result.",
            );
          if (request.executionId && page.items.length === 0)
            return failure(
              'execution_evidence_not_found',
              'That execution was not found in this current task. List this task evidence to recover an actual receipt ID; do not rerun an operation merely to recover its result.',
            );
          const items = page.items.map((item: ExecutionEvidenceRecord) => {
            const execution = item.execution;
            return {
              execution_id: execution.id,
              session_id: execution.sessionId,
              run_id: execution.runId,
              task_run_id: item.taskRunId,
              origin_store_id: execution.originStoreId ?? null,
              kind: execution.kind,
              definition_id: execution.definitionId ?? null,
              definition_version: execution.definitionVersion ?? null,
              status: execution.status,
              receipt: {
                execution_id: execution.id,
                attempt: execution.attempt ?? null,
                input_digest: execution.inputDigest ?? null,
                result_revision: execution.resultRevision,
              },
              paths: (item.paths ?? []).map((path) => ({ path: path.path, source: path.source })),
              shell_id: item.shellId ?? null,
              checkpoint: item.checkpoint
                ? { id: item.checkpoint.id, state: item.checkpoint.state }
                : null,
              ...(request.executionId !== undefined ? { result: execution.result } : {}),
            };
          });
          return {
            outcome: 'succeeded',
            content: JSON.stringify({
              current_task: { session_id: request.sessionId, run_id: request.runId },
              items,
              next_cursor: page.nextCursor,
              complete: page.nextCursor === null,
              meaning:
                "Recorded execution evidence, not a new execution receipt or authorization. Paths are recorded operation targets, not proof of successful publication or exclusive change ownership. Shell and external edits have no complete per-file change capture here. Pre-existing dirty files and other Agents' changes are not attributed to this Agent. Unknown outcomes remain unknown; inspect original evidence before any further mutation.",
            }),
          };
        },
      },
    ],
  };
}
