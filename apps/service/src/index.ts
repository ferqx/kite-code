import { AgentError, type AgentRuntime } from '@kite-ai/agent';
import { Hono } from 'hono';
import type { z } from 'zod';
import type { ConfigurationManagementPort } from './configuration-management';
import { type HostStatusSource, unavailableHostStatus } from './host-status';
import {
  apiSchemas,
  CommandRequestSchema,
  ForkSessionResponseSchema,
  IncludeResultResponseSchema,
  JobReconcileCommandSchema,
  PendingInputPageSchema,
  RecoverSessionResponseSchema,
  ResumeJobReportResponseSchema,
  ResumeRunResponseSchema,
  SelectContextResponseSchema,
  SelectedContextPageSchema,
  SessionMutationResponseSchema,
  SessionViewSchema,
  schemas,
} from './http/schema';
import { FileCheckpointListQuerySchema } from './http/schema/file-checkpoints';
import { HostStatusQuerySchema, HostStatusSchema } from './http/schema/host-status';
import { SessionLogPageSchema, SessionLogQuerySchema } from './http/schema/session-logs';
import { SkillCataloguePageSchema, SkillCatalogueQuerySchema } from './http/schema/skill-catalogue';
import { createHttpLifecycle } from './lifecycle';
import { executionResponse, messageResponses } from './message-response';
import { modelInputResponse, modelOutputResponse } from './model-input-response';
import {
  nativeFileCheckpointResponse,
  supportsFileRecovery,
} from './native-file-checkpoint-response';
import type { PermissionManagementPort } from './permission-management';
import type { SessionLogsSource } from './session-logs';
import { type SkillCatalogueSource, unavailableSkillCatalogue } from './skill-catalogue';

export interface ServiceOptions {
  /** Missing only when the explicit host could not open its Store. */
  runtime?: AgentRuntime;
  /** Trusted host cleanup after HTTP admission seals, before Runtime resources close. */
  beforeResourceClose?: () => Promise<void>;
  /** Trusted host release after confirmed Runtime/resource drain, before the listener closes. */
  afterResourceClose?: () => Promise<void>;
  configurationManagement?: ConfigurationManagementPort;
  permissionManagement?: PermissionManagementPort;
  diagnosticSource?: HostStatusSource;
  skillCatalogue?: SkillCatalogueSource;
  sessionLogs?: SessionLogsSource;
  profile: { dataRoot: string; name: string; accessKey: string };
  buildId: string;
  token?: string;
  instanceId?: string;
  capabilities?: string[];
  subjectId?: string;
  maxBodyBytes?: number;
  sseMaxBufferedBytes?: number;
}

class HttpFailure extends Error {
  readonly code: string;
  readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 503;
  constructor(code: string, status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 503) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** Public history and POST receipts use the same projection; internal recovery fences stay private. */
function publicCommand(command: NonNullable<Awaited<ReturnType<AgentRuntime['getCommand']>>>) {
  if (command.kind !== 'session.recover') return schemas.Command.parse(command);
  const report = command.receipt;
  if (
    !report ||
    typeof report !== 'object' ||
    Array.isArray(report) ||
    report.sessionId !== command.sessionId ||
    report.storeId !== command.originStoreId
  )
    throw new HttpFailure('recovery_receipt_invalid', 503);
  return RecoverSessionResponseSchema.parse({
    ...command,
    receipt: {
      kind: 'session_interrupted',
      sessionId: report.sessionId,
      storeId: report.storeId,
      interruptedRunIds: report.interruptedRunIds,
      settledExecutionIds: report.settledExecutionIds,
      unknownExecutionIds: report.unknownExecutionIds,
      cancelledExecutionIds: report.cancelledExecutionIds,
      partialMessageIds: report.partialMessageIds,
      snapshotCursor: report.snapshotCursor,
    },
  });
}

function sequence(value: string | undefined): string {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9223372036854775807n)
    throw new HttpFailure('invalid_cursor', 400);
  return value;
}

function sessionExportQuery<T>(queries: Record<string, string[]>, schema: z.ZodType<T>): T {
  const raw: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(queries)) {
    if (values.length !== 1) throw new HttpFailure('invalid_request', 400);
    const value = values[0]!;
    if (key === 'manifest') {
      if (new TextEncoder().encode(value).byteLength > 32768)
        throw new HttpFailure('request_too_large', 413);
      try {
        raw[key] = JSON.parse(value);
      } catch {
        throw new HttpFailure('invalid_request', 400);
      }
    } else raw[key] = ['limit', 'byteLimit', 'limitBytes'].includes(key) ? Number(value) : value;
  }
  const checked = schema.safeParse(raw);
  if (!checked.success) throw new HttpFailure('invalid_request', 400);
  return checked.data;
}

async function readBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes: number,
  options: {
    requireStoreId?: boolean;
    readers?: Set<ReadableStreamDefaultReader<Uint8Array>>;
  } = {},
): Promise<T> {
  const contentLength = request.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes)
    throw new HttpFailure('request_too_large', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new HttpFailure('invalid_request', 400);
  options.readers?.add(reader);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new HttpFailure('request_too_large', 413);
      }
      chunks.push(chunk.value);
    }
  } finally {
    options.readers?.delete(reader);
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new HttpFailure('invalid_request', 400);
  }
  if (
    options.requireStoreId !== false &&
    json &&
    typeof json === 'object' &&
    !('expectedStoreId' in json)
  )
    throw new HttpFailure('expected_store_id_required', 400);
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new HttpFailure('invalid_request', 400);
  return parsed.data;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Thin HTTP projection of the public Agent API. No execution loop lives here. */
export async function startService(options: ServiceOptions) {
  // Authenticated business routes are rejected by middleware in diagnostic mode.
  const runtime = options.runtime as AgentRuntime;
  const token = options.token ?? `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const subjectId = options.subjectId ?? 'local-user';
  const sessionLogs = options.sessionLogs;
  const instanceId = options.instanceId ?? crypto.randomUUID();
  const app = new Hono();
  let endpoint = '';
  let closing = false;
  const lifecycle = createHttpLifecycle(options.runtime, options.beforeResourceClose);
  const bodyReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const cancelKinds = ['command.cancel', 'run.cancel', 'execution.cancel', 'session.cancel'];
  const readBusinessBody = async <T>(
    request: Request,
    schema: z.ZodType<T>,
    maxBytes: number,
    allowCancel = false,
  ): Promise<T> => {
    const input = await readBody(request, schema, maxBytes, { readers: bodyReaders });
    if (
      lifecycle.sealed ||
      (closing && !(allowCancel && cancelKinds.includes((input as { kind: string }).kind)))
    )
      throw new HttpFailure('service_draining', 503);
    return input;
  };
  const subscribers = new Set<AbortController>();
  const streaming = new Set<Promise<void>>();
  const capabilities = (
    options.capabilities ?? [
      'service_lifecycle',
      'sessions',
      'commands',
      'events',
      'history',
      'interactions',
      'inputs',
      'context',
      'model_inputs',
      'model_outputs',
      'extensions_actions',
      'extension_queries',
      'public_views',
      'session_exports',
      ...(options.configurationManagement ? ['configuration_management'] : []),
      ...(options.permissionManagement ? ['permission_controls', 'permission_grants'] : []),
    ]
  ).filter(
    (capability) =>
      ![
        'host_status',
        'skill_catalogue',
        'skill_workflow_catalogue',
        'run_skill_selection',
        'run_extension_inputs',
        'job_report_resume',
        'job_reconcile',
        'run_resume',
        'session_recovery',
        'session_logs',
        'file_recovery',
      ].includes(capability),
  );
  if (options.runtime && typeof options.runtime.resumeJobReport === 'function')
    capabilities.push('job_report_resume');
  if (options.runtime && typeof options.runtime.reconcileJob === 'function')
    capabilities.push('job_reconcile');
  if (options.runtime && typeof options.runtime.resumeRun === 'function')
    capabilities.push('run_resume');
  if (options.runtime && typeof options.runtime.recoverSession === 'function')
    capabilities.push('session_recovery');
  if (options.runtime?.supportsSelectedSkills) capabilities.push('run_skill_selection');
  if (options.runtime?.supportsExtensionInputs) capabilities.push('run_extension_inputs');
  if (options.diagnosticSource) capabilities.push('host_status');
  if (options.skillCatalogue) capabilities.push('skill_catalogue');
  if (options.skillCatalogue?.supportsWorkflow) capabilities.push('skill_workflow_catalogue');
  if (sessionLogs) capabilities.push('session_logs');
  if (supportsFileRecovery(options.runtime)) capabilities.push('file_recovery');
  schemas.ServerInfo.parse({
    instanceId,
    buildId: options.buildId,
    apiMajor: 1,
    capabilities,
    profile: options.profile,
    dataAvailability: 'unavailable',
  });
  const serverInfo = async () => {
    const base = {
      instanceId,
      subjectId,
      buildId: options.buildId,
      apiMajor: 1,
      capabilities,
      profile: options.profile,
    };
    if (!options.runtime)
      return schemas.ServerInfo.parse({ ...base, dataAvailability: 'unavailable' });
    try {
      return schemas.ServerInfo.parse({
        ...base,
        dataAvailability: 'available',
        storeId: (await runtime.getMetadata()).storeId,
      });
    } catch {
      return schemas.ServerInfo.parse({ ...base, dataAvailability: 'unavailable' });
    }
  };
  app.use('*', async (context, next) => {
    if (
      /^\/v1\/(?:sessions\/[^/]+\/(?:logs|file-checkpoints(?:\/[^/]+(?:\/recovery-boundary|\/restores\/[^/]+)?)?|permission-(?:mode|grants)|export\/(?:manifest|records|text|verify))|workspaces\/[^/]+\/trust|permissions\/mutations\/[^/]+)$/.test(
        context.req.path,
      )
    ) {
      context.header('cache-control', 'no-store');
      context.header('x-content-type-options', 'nosniff');
    }
    if (context.req.header('host') !== new URL(endpoint).host)
      throw new HttpFailure('invalid_host', 403);
    const origin = context.req.header('origin');
    if (origin && origin !== endpoint) throw new HttpFailure('invalid_origin', 403);
    if (
      context.req.path !== '/health/live' &&
      context.req.header('authorization') !== `Bearer ${token}`
    )
      throw new HttpFailure('unauthorized', 401);
    if (context.req.path.startsWith('/v1/lifecycle')) {
      context.header('cache-control', 'no-store');
      if (origin !== undefined) throw new HttpFailure('invalid_origin', 403);
      if (Object.keys(context.req.queries()).length) throw new HttpFailure('invalid_request', 400);
    }
    if (
      closing &&
      context.req.method !== 'GET' &&
      context.req.path !== '/v1/lifecycle/shutdown' &&
      !(context.req.method === 'POST' && /^\/v1\/sessions\/[^/]+\/commands$/.test(context.req.path))
    )
      throw new HttpFailure('service_draining', 503);
    if (
      !options.runtime &&
      ![
        '/health/live',
        '/v1/server',
        '/v1/diagnostics/host-status',
        '/v1/lifecycle',
        '/v1/lifecycle/shutdown',
      ].includes(context.req.path) &&
      !(
        options.configurationManagement &&
        context.req.method === 'GET' &&
        context.req.path === '/v1/config/user'
      )
    )
      throw new HttpFailure('data_unavailable', 503);
    const independent = ['/health/live', '/v1/lifecycle', '/v1/lifecycle/shutdown'].includes(
      context.req.path,
    );
    const finish = independent
      ? () => {}
      : (() => {
          try {
            return lifecycle.enter(context.req.method !== 'GET');
          } catch {
            throw new HttpFailure('service_draining', 503);
          }
        })();
    try {
      await next();
    } finally {
      finish();
    }
  });
  app.onError((error, context) => {
    const code =
      error instanceof HttpFailure || error instanceof AgentError
        ? error.code
        : 'service_unavailable';
    const status =
      error instanceof HttpFailure
        ? error.status
        : code === 'interaction_too_large'
          ? 413
          : code === 'interaction_limit'
            ? 429
            : [
                  'permission_denied',
                  'host_mutation_scope_denied',
                  'host_control_scope_denied',
                  'permission_authority_external',
                  'artifact_scope_denied',
                  'interaction_scope_denied',
                  'group_root_required',
                  'context_scope_denied',
                  'context_result_scope_denied',
                  'model_input_scope_denied',
                  'directory_scope_denied',
                  'export_scope_denied',
                  'session_log_scope_denied',
                  'execution_group_scope_denied',
                ].includes(code)
              ? 403
              : [
                    'invalid_cursor',
                    'invalid_page',
                    'artifact_scope_invalid',
                    'invalid_configuration_scope',
                    'invalid_jsonc',
                    'invalid_configuration',
                    'invalid_host_mutation',
                    'invalid_host_control',
                    'invalid_permission_revision',
                    'invalid_permission_request',
                    'permission_control_invalid',
                    'invalid_credential',
                    'unsupported_configuration_field',
                    'credential_reference_required',
                    'configuration_repair_not_required',
                    'model_settings_default_disable_denied',
                    'model_settings_model_missing',
                    'model_settings_model_unconfigured',
                    'model_settings_model_disabled',
                    'model_settings_default_unconfigured',
                    'model_settings_override',
                    'invalid_query_arguments',
                    'invalid_action_arguments',
                    'invalid_public_view',
                    'interaction_answer_invalid',
                    'interaction_filter_invalid',
                    'invalid_revision',
                    'invalid_input_request',
                    'invalid_input_cursor',
                    'invalid_context_cursor',
                    'invalid_model_input_cursor',
                    'context_boundary_invalid',
                    'context_boundary_unpaired',
                    'invalid_fork',
                    'invalid_compression_request',
                    'invalid_session_revision',
                    'invalid_session_title',
                    'export_invalid_page',
                    'invalid_page_bounds',
                  ].includes(code)
                ? 400
                : code === 'context_item_too_large' ||
                    code === 'export_record_too_large' ||
                    code === 'session_log_page_too_large'
                  ? 413
                  : code === 'cursor_expired'
                    ? 410
                    : code.endsWith('_not_found') ||
                        code === 'definition_missing' ||
                        code === 'workspace_missing'
                      ? 404
                      : [
                            'cursor_ahead',
                            'directory_changed',
                            'directory_identity_conflict',
                            'configuration_conflict',
                            'configuration_read_set_conflict',
                            'host_mutation_conflict',
                            'host_control_conflict',
                            'permission_control_changed',
                            'workspace_identity_changed',
                            'workspace_scope_changed',
                            'host_mutation_terminal_conflict',
                            'configuration_busy',
                            'mutation_incomplete',
                            'store_mismatch',
                            'store_identity_mismatch',
                            'command_conflict',
                            'session_revision_changed',
                            'session_deleted',
                            'session_busy',
                            'owner_busy',
                            'owner_changed',
                            'run_resume_busy',
                            'run_not_active',
                            'run_resume_checkpoint_unavailable',
                            'resume_checkpoint_unavailable',
                            'run_resume_checkpoint_changed',
                            'run_resume_cancelled',
                            'run_configuration_changed',
                            'run_configuration_mismatch',
                            'run_initialization_incomplete',
                            'run_initialization_state_changed',
                            'run_recovery_binding_unavailable',
                            'cancelled_before_dispatch',
                            'job_reconciliation_busy',
                            'job_reconciliation_unavailable',
                            'result_revision_conflict',
                            'recovery_required',
                            'recovery_manifest_changed',
                            'recovery_lease_changed',
                            'report_recovery_busy',
                            'report_configuration_mismatch',
                            'recovery_configuration_changed',
                            'report_recovery_unavailable',
                            'report_unverifiable',
                            'context_refresh_required',
                            'extension_record_format_unavailable',
                            'operation_definition_unavailable',
                            'interaction_answer_conflict',
                            'interaction_revision_conflict',
                            'interaction_not_active',
                            'interaction_binding_changed',
                            'input_pending',
                            'input_not_ready',
                            'input_target_stopped',
                            'input_target_changed',
                            'context_selection_changed',
                            'context_execution_unsettled',
                            'context_selection_too_complex',
                            'context_source_unverifiable',
                            'context_receipt_invalid',
                            'compression_conflict',
                            'compression_changed',
                            'compression_reset_unsafe',
                            'result_revision_conflict',
                            'input_busy',
                            'context_rewound',
                            'result_not_pending',
                            'result_delivery_cancelled',
                            'export_changed',
                          ].includes(code)
                        ? 409
                        : 503;
    return context.json(
      schemas.Problem.parse({
        code,
        message: code,
        scope: 'request',
        requestId: crypto.randomUUID(),
        retryable: error instanceof AgentError && error.retryable,
      }),
      status,
    );
  });
  app.get('/v1/sessions/:id/export/manifest', async (context) => {
    const { storeId } = sessionExportQuery(
      context.req.queries(),
      apiSchemas.BeginSessionExportQuery,
    );
    return context.json(
      apiSchemas.SessionExportManifest.parse(
        await runtime.beginSessionExport({
          expectedStoreId: storeId,
          sessionId: context.req.param('id'),
          subjectId,
        }),
      ),
    );
  });
  app.get('/v1/sessions/:id/export/records', async (context) => {
    const { storeId, ...input } = sessionExportQuery(
      context.req.queries(),
      apiSchemas.SessionExportPageQuery,
    );
    return context.json(
      apiSchemas.SessionExportPage.parse(
        await runtime.readSessionExportPage({
          ...input,
          expectedStoreId: storeId,
          sessionId: context.req.param('id'),
          subjectId,
        }),
      ),
    );
  });
  app.get('/v1/sessions/:id/export/text', async (context) => {
    const { storeId, ...input } = sessionExportQuery(
      context.req.queries(),
      apiSchemas.SessionExportTextQuery,
    );
    return context.json(
      apiSchemas.SessionExportTextPage.parse(
        await runtime.readSessionExportText({
          ...input,
          expectedStoreId: storeId,
          sessionId: context.req.param('id'),
          subjectId,
        }),
      ),
    );
  });
  app.get('/v1/sessions/:id/export/verify', async (context) => {
    const { storeId, ...input } = sessionExportQuery(
      context.req.queries(),
      apiSchemas.VerifySessionExportQuery,
    );
    return context.json(
      apiSchemas.SessionExportCompletion.parse(
        await runtime.verifySessionExport({
          ...input,
          expectedStoreId: storeId,
          sessionId: context.req.param('id'),
          subjectId,
        }),
      ),
    );
  });
  const management = () => {
    if (!options.configurationManagement) throw new HttpFailure('configuration_unavailable', 503);
    return options.configurationManagement;
  };
  const permissionManagement = () => {
    if (!options.permissionManagement)
      throw new HttpFailure('permission_controls_unavailable', 503);
    return options.permissionManagement;
  };
  const permissionQuery = (queries: Record<string, string[]>) => {
    const parsed = schemas.PermissionControlQuery.safeParse(
      Object.fromEntries(
        Object.entries(queries).map(([key, values]) => [
          key,
          values.length === 1 ? values[0] : values,
        ]),
      ),
    );
    if (!parsed.success) throw new HttpFailure('invalid_request', 400);
    return parsed.data.storeId;
  };
  const permissionScopeId = (value: string) => {
    if (!schemas.Session.shape.id.safeParse(value).success)
      throw new HttpFailure('invalid_request', 400);
    return value;
  };
  app.get('/v1/sessions/:id/permission-mode', async (context) =>
    context.json(
      schemas.PermissionModeState.parse(
        await permissionManagement().readMode({
          expectedStoreId: permissionQuery(context.req.queries()),
          subjectId,
          sessionId: permissionScopeId(context.req.param('id')),
        }),
      ),
    ),
  );
  app.post('/v1/sessions/:id/permission-mode', async (context) => {
    const input = await readBusinessBody(context.req.raw, schemas.SetPermissionModeRequest, 4096);
    return context.json(
      schemas.PermissionMutation.parse(
        await permissionManagement().setMode({
          ...input,
          subjectId,
          sessionId: permissionScopeId(context.req.param('id')),
        }),
      ),
    );
  });
  app.get('/v1/sessions/:id/permission-grants', async (context) => {
    const raw = context.req.queries();
    const parsed = schemas.PermissionGrantQuery.safeParse(
      Object.fromEntries(
        Object.entries(raw).map(([key, values]) => [
          key,
          values.length !== 1 ? values : key === 'limit' ? Number(values[0]) : values[0],
        ]),
      ),
    );
    if (!parsed.success) throw new HttpFailure('invalid_request', 400);
    const { storeId, ...page } = parsed.data;
    return context.json(
      schemas.PermissionGrantPage.parse(
        await permissionManagement().readGrants({
          expectedStoreId: storeId,
          subjectId,
          sessionId: permissionScopeId(context.req.param('id')),
          ...page,
        }),
      ),
    );
  });
  app.post('/v1/sessions/:id/permission-grants', async (context) => {
    const input = await readBusinessBody(
      context.req.raw,
      schemas.ClearPermissionGrantsRequest,
      4096,
    );
    return context.json(
      schemas.PermissionMutation.parse(
        await permissionManagement().clearGrants({
          ...input,
          subjectId,
          sessionId: permissionScopeId(context.req.param('id')),
        }),
      ),
    );
  });
  app.get('/v1/workspaces/:id/trust', async (context) =>
    context.json(
      schemas.WorkspaceTrustState.parse(
        await permissionManagement().readTrust({
          expectedStoreId: permissionQuery(context.req.queries()),
          subjectId,
          workspaceId: permissionScopeId(context.req.param('id')),
        }),
      ),
    ),
  );
  app.post('/v1/workspaces/:id/trust', async (context) => {
    const input = await readBusinessBody(context.req.raw, schemas.SetWorkspaceTrustRequest, 4096);
    return context.json(
      schemas.PermissionMutation.parse(
        await permissionManagement().setTrust({
          ...input,
          subjectId,
          workspaceId: permissionScopeId(context.req.param('id')),
        }),
      ),
    );
  });
  app.get('/v1/permissions/mutations/:id', async (context) => {
    const result = await permissionManagement().getMutation({
      expectedStoreId: permissionQuery(context.req.queries()),
      subjectId,
      commandId: permissionScopeId(context.req.param('id')),
    });
    if (!result) throw new HttpFailure('permission_mutation_not_found', 404);
    return context.json(schemas.PermissionMutation.parse(result));
  });
  const location = (scope: string, workspaceId?: string) => {
    if (scope !== 'user' && scope !== 'workspace')
      throw new HttpFailure('invalid_configuration_scope', 400);
    return { scope, ...(workspaceId === undefined ? {} : { workspaceId }) } as const;
  };
  app.get('/v1/sessions/:id/logs', async (context) => {
    if (!sessionLogs) throw new HttpFailure('capability_unavailable', 503);
    const query = SessionLogQuerySchema.safeParse(
      Object.fromEntries(
        Object.entries(context.req.queries()).map(([key, values]) => [
          key,
          values.length !== 1 ? values : key === 'limit' ? Number(values[0]) : values[0],
        ]),
      ),
    );
    if (!query.success) throw new HttpFailure('invalid_request', 400);
    const { storeId, ...pagination } = query.data;
    const signal = context.req.raw.signal;
    signal.throwIfAborted();
    const page = await sessionLogs(
      {
        expectedStoreId: storeId,
        sessionId: context.req.param('id'),
        subjectId,
        ...pagination,
      },
      { signal },
    );
    signal.throwIfAborted();
    const result = SessionLogPageSchema.parse(page);
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 512 * 1024)
      throw new HttpFailure('session_log_page_too_large', 413);
    context.header('cache-control', 'no-store');
    context.header('x-content-type-options', 'nosniff');
    return context.json(result);
  });
  app.get('/v1/sessions/:id/model-inputs', async (context) => {
    const raw = context.req.queries();
    const query = schemas.ModelInputQuery.safeParse(
      Object.fromEntries(
        Object.entries(raw).map(([key, values]) => [
          key,
          values.length !== 1 ? values : key === 'limit' ? Number(values[0]) : values[0],
        ]),
      ),
    );
    if (!query.success) throw new HttpFailure('invalid_request', 400);
    const { storeId, ...pagination } = query.data;
    const page = await runtime.listModelInputs({
      expectedStoreId: storeId,
      sessionId: context.req.param('id'),
      subjectId,
      ...pagination,
    });
    return context.json(schemas.ModelInputPage.parse(page));
  });
  app.get('/v1/sessions/:id/executions/:executionId/model-input', async (context) => {
    const raw = context.req.queries();
    const query = schemas.ModelInputQuery.pick({ storeId: true }).safeParse(
      Object.fromEntries(
        Object.entries(raw).map(([key, values]) => [key, values.length === 1 ? values[0] : values]),
      ),
    );
    if (!query.success) throw new HttpFailure('invalid_request', 400);
    const snapshot = await runtime.readModelInput({
      expectedStoreId: query.data.storeId,
      sessionId: context.req.param('id'),
      executionId: context.req.param('executionId'),
      subjectId,
      signal: context.req.raw.signal,
    });
    return modelInputResponse(snapshot, context.req.raw.signal);
  });
  app.get('/v1/sessions/:id/executions/:executionId/model-output', async (context) => {
    const query = schemas.ModelOutputQuery.safeParse(
      Object.fromEntries(
        Object.entries(context.req.queries()).map(([key, values]) => [
          key,
          values.length === 1 ? values[0] : values,
        ]),
      ),
    );
    if (!query.success) throw new HttpFailure('invalid_request', 400);
    const snapshot = await runtime.readModelOutput({
      expectedStoreId: query.data.storeId,
      sessionId: context.req.param('id'),
      executionId: context.req.param('executionId'),
      subjectId,
      signal: context.req.raw.signal,
    });
    return modelOutputResponse(snapshot, context.req.raw.signal);
  });
  app.get('/v1/sessions/:id/interactions', async (context) => {
    const raw = context.req.queries();
    if (Object.values(raw).some((values) => values.length !== 1))
      throw new HttpFailure('invalid_request', 400);
    const query = schemas.InteractionListQuery.safeParse(
      Object.fromEntries(
        Object.entries(raw).map(([key, values]) => [
          key,
          key === 'limit' ? Number(values[0]) : values[0],
        ]),
      ),
    );
    if (!query.success) throw new HttpFailure('invalid_request', 400);
    const { storeId, ...pagination } = query.data;
    const page = await runtime.listInteractions({
      expectedStoreId: storeId,
      sessionId: context.req.param('id'),
      ...pagination,
    });
    return context.json(schemas.InteractionPage.parse(page));
  });
  app.get('/v1/sessions/:id/interactions/:interactionId', async (context) => {
    const raw = context.req.queries();
    const query = schemas.InteractionListQuery.pick({ storeId: true }).safeParse(
      Object.fromEntries(
        Object.entries(raw).map(([key, values]) => [key, values.length === 1 ? values[0] : values]),
      ),
    );
    if (!query.success) throw new HttpFailure('invalid_request', 400);
    const result = await runtime.getInteraction({
      expectedStoreId: query.data.storeId,
      sessionId: context.req.param('id'),
      interactionId: context.req.param('interactionId'),
    });
    if (!result) throw new HttpFailure('interaction_not_found', 404);
    return context.json(schemas.Interaction.parse(result));
  });
  app.post('/v1/sessions/:id/interactions/:interactionId/answer', async (context) => {
    const input = await readBusinessBody(
      context.req.raw,
      schemas.AnswerInteractionRequest,
      Math.min(options.maxBodyBytes ?? 1024 * 1024, 65536),
    );
    const receipt = await runtime.answerInteraction({
      ...input,
      presentationSessionId: context.req.param('id'),
      interactionId: context.req.param('interactionId'),
      subjectId,
    });
    return context.json(schemas.Command.parse(receipt), 202);
  });
  app.get('/v1/sessions/:id/artifacts/:refId', async (context) => {
    const query = context.req.queries();
    if (
      Object.keys(query).some((key) => !['storeId', 'scopeKind', 'scopeId'].includes(key)) ||
      Object.values(query).some((values) => values.length !== 1)
    )
      throw new HttpFailure('artifact_scope_invalid', 400);
    const input = schemas.ArtifactRef.shape.scope
      .unwrap()
      .safeParse({ kind: context.req.query('scopeKind'), id: context.req.query('scopeId') });
    const expectedStoreId = context.req.query('storeId');
    if (!input.success || !expectedStoreId) throw new HttpFailure('artifact_scope_invalid', 400);
    const { reference, content } = await runtime.readArtifact({
      expectedStoreId,
      sessionId: context.req.param('id'),
      refId: context.req.param('refId'),
      subjectId,
      scope: input.data,
    });
    return new Response(Uint8Array.from(content), {
      headers: {
        'content-type': reference.mediaType,
        'content-length': reference.size,
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${reference.id}"`,
        'x-artifact-id': reference.id,
        'x-artifact-store-id': reference.storeId,
        'x-artifact-hash': reference.hash,
        'x-artifact-size': reference.size,
        'x-content-type-options': 'nosniff',
      },
    });
  });
  app.get('/v1/config/user/providers', async (context) => {
    const raw = context.req.queries();
    const query = schemas.HostMutationQuery.safeParse(
      Object.fromEntries(
        Object.entries(raw).map(([key, values]) => [key, values.length === 1 ? values[0] : values]),
      ),
    );
    if (!query.success) throw new HttpFailure('invalid_request', 400);
    return context.json(
      schemas.ProviderSettingsView.parse(
        await management().readProviders({ expectedStoreId: query.data.storeId }),
      ),
    );
  });
  app.post('/v1/config/user/providers', async (context) => {
    const input = await readBusinessBody(
      context.req.raw,
      schemas.ProviderSettingsRequest,
      options.maxBodyBytes ?? 1048576,
    );
    return context.json(
      schemas.HostMutation.parse(await management().updateProviders({ ...input, subjectId })),
    );
  });
  app.get('/v1/config/:scope/models', async (context) => {
    const raw = context.req.queries();
    const query = schemas.ConfigurationReadQuery.safeParse(
      Object.fromEntries(
        Object.entries(raw).map(([key, values]) => [key, values.length === 1 ? values[0] : values]),
      ),
    );
    if (!query.success || !query.data.storeId) throw new HttpFailure('invalid_request', 400);
    return context.json(
      schemas.ModelSettingsView.parse(
        await management().readModels({
          ...location(context.req.param('scope'), query.data.workspaceId),
          expectedStoreId: query.data.storeId,
        }),
      ),
    );
  });
  app.post('/v1/config/:scope/models', async (context) => {
    const input = await readBusinessBody(context.req.raw, schemas.ModelSettingsRequest, 4096);
    return context.json(
      schemas.HostMutation.parse(
        await management().updateModels({
          ...input,
          ...location(context.req.param('scope'), input.workspaceId),
          subjectId,
        }),
      ),
    );
  });
  app.get('/v1/config/:scope', async (context) => {
    const raw = context.req.queries();
    const query = schemas.ConfigurationReadQuery.safeParse(
      Object.fromEntries(
        Object.entries(raw).map(([key, values]) => [key, values.length === 1 ? values[0] : values]),
      ),
    );
    if (!query.success) throw new HttpFailure('invalid_request', 400);
    return context.json(
      schemas.ConfigurationView.parse(
        await management().read({
          ...location(context.req.param('scope'), query.data.workspaceId),
          expectedStoreId: query.data.storeId,
        }),
      ),
    );
  });
  app.patch('/v1/config/:scope', async (context) => {
    const input = await readBusinessBody(
      context.req.raw,
      schemas.ConfigurationPatchRequest,
      options.maxBodyBytes ?? 1024 * 1024,
    );
    const result = await management().patch({
      ...input,
      ...location(context.req.param('scope'), input.workspaceId),
      subjectId,
    });
    return context.json(schemas.HostMutation.parse(result));
  });
  app.post('/v1/config/:scope/repair', async (context) => {
    const input = await readBusinessBody(
      context.req.raw,
      schemas.ConfigurationRepairRequest,
      options.maxBodyBytes ?? 1024 * 1024,
    );
    return context.json(
      schemas.HostMutation.parse(
        await management().repair({
          ...input,
          ...location(context.req.param('scope'), input.workspaceId),
          subjectId,
        }),
      ),
    );
  });
  app.post('/v1/credentials', async (context) => {
    const input = await readBusinessBody(
      context.req.raw,
      schemas.CredentialPutRequest,
      options.maxBodyBytes ?? 1024 * 1024,
    );
    return context.json(
      schemas.HostMutation.parse(await management().putCredential({ ...input, subjectId })),
    );
  });
  app.post('/v1/credentials/:opaqueRef/revoke', async (context) => {
    const input = await readBusinessBody(
      context.req.raw,
      schemas.CredentialRevokeRequest,
      options.maxBodyBytes ?? 1024 * 1024,
    );
    const ref = context.req.param('opaqueRef');
    if (!/^credential:[0-9a-f-]{36}$/.test(ref)) throw new HttpFailure('invalid_request', 400);
    return context.json(
      schemas.HostMutation.parse(
        await management().revokeCredential({ ...input, opaqueRef: ref, subjectId }),
      ),
    );
  });
  app.get('/v1/host-mutations/:id', async (context) => {
    const raw = context.req.queries();
    const query = schemas.HostMutationQuery.safeParse(
      Object.fromEntries(
        Object.entries(raw).map(([key, values]) => [key, values.length === 1 ? values[0] : values]),
      ),
    );
    if (!query.success) throw new HttpFailure('invalid_request', 400);
    const result = await management().getMutation({
      expectedStoreId: query.data.storeId,
      commandId: permissionScopeId(context.req.param('id')),
      subjectId,
    });
    if (!result) throw new HttpFailure('host_mutation_not_found', 404);
    return context.json(schemas.HostMutation.parse(result));
  });
  app.notFound((context) =>
    context.json(
      {
        code: 'not_found',
        message: 'not_found',
        scope: 'request',
        requestId: crypto.randomUUID(),
        retryable: false,
      },
      404,
    ),
  );
  const lifecycleView = async () => {
    const observed = await serverInfo();
    return schemas.ServiceLifecycle.parse({
      lifecycleVersion: 1,
      profile: options.profile,
      instanceId,
      buildId: options.buildId,
      apiMajor: 1,
      capabilities,
      dataAvailability: observed.dataAvailability,
      ...lifecycle.state(),
    });
  };
  const beginShutdown = (mode: 'if_idle' | 'cancel') =>
    lifecycle.begin(
      mode,
      () => {
        closing = true;
        for (const subscriber of subscribers) subscriber.abort();
        for (const reader of bodyReaders) void reader.cancel().catch(() => {});
      },
      async () => {
        await Promise.allSettled(streaming);
        for (const reader of bodyReaders) void reader.cancel().catch(() => {});
        await options.afterResourceClose?.();
        await server.stop(false);
      },
    );
  app.get('/v1/lifecycle', async (context) => context.json(await lifecycleView()));
  app.post('/v1/lifecycle/shutdown', async (context) => {
    const input = await readBody(context.req.raw, schemas.ShutdownServiceRequest, 16384, {
      requireStoreId: false,
      readers: bodyReaders,
    });
    if (
      input.expectedInstanceId !== instanceId ||
      Object.keys(options.profile).some(
        (key) =>
          input.expectedProfile[key as keyof typeof input.expectedProfile] !==
          options.profile[key as keyof typeof options.profile],
      )
    )
      throw new HttpFailure('lifecycle_identity_mismatch', 409);
    const result = beginShutdown(input.mode);
    if (!result.accepted) throw new HttpFailure('lifecycle_busy', 409);
    return context.json(
      schemas.ShutdownServiceResponse.parse({
        lifecycleVersion: 1,
        accepted: true,
        lifecycle: await lifecycleView(),
      }),
      202,
    );
  });
  app.get('/health/live', (context) => context.json({ status: closing ? 'draining' : 'live' }));
  app.get('/v1/server', async (context) => context.json(await serverInfo()));
  app.get('/v1/workspaces/:id/skills', async (context) => {
    context.header('cache-control', 'no-store');
    const query = sessionExportQuery(context.req.queries(), SkillCatalogueQuerySchema);
    if (query.workflow && !options.skillCatalogue?.supportsWorkflow)
      throw new HttpFailure('skill_workflow_catalogue_unavailable', 404);
    const workspaceId = context.req.param('id');
    const target = schemas.Workspace.shape.id.safeParse(workspaceId);
    if (!target.success) throw new HttpFailure('invalid_request', 400);
    if ((await runtime.getMetadata()).storeId !== query.storeId)
      throw new HttpFailure('store_identity_mismatch', 409);
    if (query.afterId && !query.revision)
      throw new HttpFailure('invalid_skill_catalogue_query', 400);
    if (!(await runtime.getWorkspace(workspaceId)))
      throw new HttpFailure('workspace_not_found', 404);
    const readPage = async () =>
      options.skillCatalogue
        ? options.skillCatalogue.list({
            ...query,
            workspaceId,
            subjectId,
            runtime,
            permissions: options.permissionManagement,
          })
        : unavailableSkillCatalogue(
            { ...query, workspaceId },
            'skill_catalogue_source_unavailable',
          );
    const page = await readPage().catch((error: unknown) => {
      const code = error instanceof AgentError ? error.code : '';
      if (code === 'workspace_untrusted' || code === 'permission_controls_unavailable')
        throw new HttpFailure(code, 403);
      if (code === 'workspace_not_found') throw new HttpFailure(code, 404);
      if (code === 'skill_catalogue_changed') throw new HttpFailure(code, 409);
      if (code === 'invalid_skill_catalogue_query') throw new HttpFailure(code, 400);
      if (code === 'skill_catalogue_page_too_small') throw new HttpFailure(code, 413);
      throw error;
    });
    if (page.storeId !== query.storeId || page.workspaceId !== workspaceId)
      throw new HttpFailure('skill_catalogue_identity_mismatch', 409);
    if (query.revision && page.revision !== query.revision)
      throw new HttpFailure('skill_catalogue_changed', 409);
    // Existing clients consume a closed knowledge DTO. The richer projection is explicit opt-in.
    const response = query.workflow
      ? page
      : {
          ...page,
          entries: page.entries.map(({ workflow: _workflow, ...entry }) => entry),
        };
    return context.json(SkillCataloguePageSchema.parse(response));
  });
  app.get('/v1/diagnostics/host-status', async (context) => {
    context.header('cache-control', 'no-store');
    context.header('x-content-type-options', 'nosniff');
    const query = sessionExportQuery(context.req.queries(), HostStatusQuerySchema);
    const info = await serverInfo();
    if (info.dataAvailability === 'available') {
      if (query.workspaceId && !(await runtime.getWorkspace(query.workspaceId)))
        throw new HttpFailure('workspace_not_found', 404);
      if (query.sessionId) {
        const selected = await runtime.getSession(query.sessionId);
        if (!selected || selected.deletedAt !== null)
          throw new HttpFailure('session_not_found', 404);
        if (query.workspaceId && selected.workspaceId !== query.workspaceId)
          throw new HttpFailure('diagnostic_scope_mismatch', 409);
      }
    }
    const facts = options.diagnosticSource
      ? await options.diagnosticSource.snapshot({
          runtime: options.runtime,
          permissions: options.permissionManagement,
          subjectId,
          storeId: info.storeId ?? null,
          ...query,
        })
      : unavailableHostStatus();
    return context.json(
      HostStatusSchema.parse({
        version: 1,
        identity: {
          instanceId: info.instanceId,
          buildId: info.buildId,
          apiMajor: info.apiMajor,
          profileAccessKey: info.profile.accessKey,
          dataAvailability: info.dataAvailability,
          storeId: info.storeId ?? null,
        },
        scope: { workspaceId: query.workspaceId ?? null, sessionId: query.sessionId ?? null },
        ...facts,
      }),
    );
  });
  const checkpointRoutes = [
    ['/v1/sessions/:id/file-checkpoints', 'list'],
    ['/v1/sessions/:id/file-checkpoints/:pointId', 'detail'],
    ['/v1/sessions/:id/file-checkpoints/:pointId/restores/:restoreId', 'status'],
    ['/v1/sessions/:id/file-checkpoints/:pointId/recovery-boundary', 'boundary'],
  ] as const;
  for (const [path, operation] of checkpointRoutes)
    app.get(path, async (context) => {
      const sessionId = context.req.param('id'),
        pointId = context.req.param('pointId'),
        restoreId = context.req.param('restoreId');
      if (
        !schemas.Session.shape.id.safeParse(sessionId).success ||
        (operation !== 'list' && !/^[a-f0-9]{64}$/.test(pointId ?? '')) ||
        (operation === 'status' && !schemas.Session.shape.id.safeParse(restoreId).success)
      )
        throw new HttpFailure('invalid_scope', 400);
      const query =
        operation === 'list'
          ? sessionExportQuery(context.req.queries(), FileCheckpointListQuerySchema)
          : (() => {
              if (Object.keys(context.req.queries()).length)
                throw new HttpFailure('invalid_request', 400);
              return {};
            })();
      const input =
        operation === 'list'
          ? query
          : operation === 'status'
            ? { checkpointId: pointId!, restoreId: restoreId! }
            : { pointId: pointId! };
      return context.json(
        await nativeFileCheckpointResponse(
          runtime,
          subjectId,
          sessionId,
          operation,
          input,
          context.req.raw.signal,
        ),
      );
    });
  app.get('/v1/extensions', (context) =>
    context.json(apiSchemas.ExtensionList.parse(runtime.getExtensionCatalogue())),
  );
  app.get('/v1/sessions/:id/extensions/:extensionId/queries/:queryId', async (context) => {
    const sessionId = context.req.param('id');
    const extensionId = context.req.param('extensionId');
    const queryId = context.req.param('queryId');
    if (
      !schemas.Session.shape.id.safeParse(sessionId).success ||
      !apiSchemas.ExtensionCatalogue.shape.extensionId.safeParse(extensionId).success ||
      !apiSchemas.ExtensionCatalogue.shape.queries.element.shape.id.safeParse(queryId).success
    )
      throw new HttpFailure('invalid_scope', 400);
    let rawInputs: string[];
    try {
      rawInputs = new URL(context.req.url).search
        .slice(1)
        .split('&')
        .filter((part) => decodeURIComponent(part.split('=')[0]!.replaceAll('+', ' ')) === 'input')
        .map((part) => part.slice(part.indexOf('=') + 1));
    } catch {
      throw new HttpFailure('invalid_query_arguments', 400);
    }
    if (rawInputs.length > 1 || (rawInputs[0]?.length ?? 0) > 8192)
      throw new HttpFailure('invalid_query_arguments', 400);
    let input: unknown;
    try {
      input = JSON.parse(context.req.query('input') ?? '{}');
    } catch {
      throw new HttpFailure('invalid_query_arguments', 400);
    }
    const parsed = schemas.ExtensionCommandRequest.shape.input.safeParse(input);
    if (!parsed.success) throw new HttpFailure('invalid_query_arguments', 400);
    return context.json(
      apiSchemas.QueryResponse.parse(
        await runtime.queryExtension({
          sessionId,
          extensionId,
          queryId,
          subjectId,
          input: parsed.data,
        }),
      ),
    );
  });
  app.post('/v1/workspaces', async (context) => {
    const request = await readBusinessBody(
      context.req.raw,
      schemas.CreateWorkspaceRequest,
      options.maxBodyBytes ?? 1024 * 1024,
    );
    return context.json(schemas.Workspace.parse(await runtime.createWorkspace(request)), 201);
  });
  app.get('/v1/background-executions', async (context) => {
    const parsed = apiSchemas.BackgroundExecutionQuery.safeParse(
      Object.fromEntries(
        Object.entries(context.req.queries()).map(([key, values]) => [
          key,
          values.length === 1 ? values[0] : values,
        ]),
      ),
    );
    if (!parsed.success) throw new HttpFailure('invalid_request', 400);
    const { storeId, ...page } = parsed.data;
    return context.json(
      apiSchemas.BackgroundExecutionPage.parse(
        await runtime.listBackgroundExecutions({ expectedStoreId: storeId, subjectId, ...page }),
      ),
    );
  });
  app.get('/v1/workspace-directory', async (context) => {
    const parsed = apiSchemas.WorkspaceDirectoryQuery.safeParse(
      Object.fromEntries(
        Object.entries(context.req.queries()).map(([key, values]) => [
          key,
          values.length === 1 ? values[0] : values,
        ]),
      ),
    );
    if (!parsed.success) throw new HttpFailure('invalid_request', 400);
    const { storeId, ...page } = parsed.data;
    return context.json(
      apiSchemas.WorkspaceDirectoryPage.parse(
        await runtime.listWorkspaceDirectory({ expectedStoreId: storeId, ...page }),
      ),
    );
  });
  app.get('/v1/session-directory', async (context) => {
    const parsed = apiSchemas.SessionDirectoryQuery.safeParse(
      Object.fromEntries(
        Object.entries(context.req.queries()).map(([key, values]) => [
          key,
          values.length === 1 ? values[0] : values,
        ]),
      ),
    );
    if (!parsed.success) throw new HttpFailure('invalid_request', 400);
    const { storeId, ...page } = parsed.data;
    return context.json(
      apiSchemas.SessionDirectoryPage.parse(
        await runtime.listSessionDirectory({ expectedStoreId: storeId, subjectId, ...page }),
      ),
    );
  });
  app.get('/v1/workspaces', async (context) =>
    context.json(
      (await runtime.listWorkspaces()).map((workspace) => schemas.Workspace.parse(workspace)),
    ),
  );
  app.get('/v1/workspaces/:id', async (context) => {
    const result = await runtime.getWorkspace(context.req.param('id'));
    if (!result) throw new HttpFailure('workspace_not_found', 404);
    return context.json(schemas.Workspace.parse(result));
  });
  app.post('/v1/sessions', async (context) => {
    const request = await readBusinessBody(
      context.req.raw,
      schemas.CreateSessionRequest,
      options.maxBodyBytes ?? 1024 * 1024,
    );
    return context.json(
      schemas.Session.parse(await runtime.createSession({ ...request, subjectId })),
      201,
    );
  });
  app.get('/v1/sessions', async (context) =>
    context.json((await runtime.listSessions()).map((session) => schemas.Session.parse(session))),
  );
  app.get('/v1/sessions/:id/view', async (context) => {
    const view = await runtime.getView(context.req.param('id'));
    return context.json(
      SessionViewSchema.parse({
        ...view,
        messages: await messageResponses(runtime, view.messages, view.storeId, subjectId),
        executions: view.executions.map(executionResponse),
      }),
    );
  });
  app.get('/v1/sessions/:id/messages', async (context) => {
    const limit = Number(context.req.query('limit') ?? '100');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new HttpFailure('invalid_page', 400);
    const afterSeq = sequence(context.req.query('afterSeq') ?? '0');
    const upper = context.req.query('upperSeq');
    const messages = await runtime.listMessages(context.req.param('id'), {
      limit,
      afterSeq,
      ...(upper ? { upperSeq: sequence(upper) } : {}),
    });
    return context.json(
      (
        await messageResponses(runtime, messages, (await runtime.getMetadata()).storeId, subjectId)
      ).map((message) => schemas.Message.parse(message)),
    );
  });
  app.get('/v1/sessions/:id/context', async (context) => {
    const raw = context.req.queries();
    if (Object.values(raw).some((values) => values.length !== 1))
      throw new HttpFailure('invalid_request', 400);
    const numeric = ['messageLimit', 'sourceLimit', 'byteLimit'];
    const query = schemas.ContextQuery.safeParse(
      Object.fromEntries(
        Object.entries(raw).map(([key, values]) => [
          key,
          numeric.includes(key) ? Number(values[0]) : values[0],
        ]),
      ),
    );
    if (!query.success) throw new HttpFailure('invalid_request', 400);
    const { storeId, ...pagination } = query.data;
    const page = await runtime.getSelectedContext({
      expectedStoreId: storeId,
      sessionId: context.req.param('id'),
      ...pagination,
    });
    return context.json(
      SelectedContextPageSchema.parse({
        ...page,
        messages: await messageResponses(runtime, page.messages, storeId, subjectId),
      }),
    );
  });
  app.post('/v1/sessions/:id/context/select', async (context) => {
    if (closing) throw new HttpFailure('service_draining', 503);
    const request = await readBusinessBody(
      context.req.raw,
      schemas.SelectContextRequest,
      options.maxBodyBytes ?? 1024 * 1024,
    );
    return context.json(
      SelectContextResponseSchema.parse(
        await runtime.selectContext({
          ...request,
          sessionId: context.req.param('id'),
          subjectId,
        }),
      ),
    );
  });
  for (const operation of ['compress', 'reset'] as const)
    app.post(
      operation === 'compress'
        ? '/v1/sessions/:id/context/compress'
        : '/v1/sessions/:id/context/compression/reset',
      async (context) => {
        context.header('cache-control', 'no-store');
        if (closing) throw new HttpFailure('service_draining', 503);
        const result =
          operation === 'compress'
            ? await runtime.compressContext({
                ...(await readBusinessBody(
                  context.req.raw,
                  schemas.CompressContextRequest,
                  options.maxBodyBytes ?? 1024 * 1024,
                )),
                sessionId: context.req.param('id'),
                subjectId,
              })
            : await runtime.resetCompressionContext({
                ...(await readBusinessBody(context.req.raw, schemas.ResetCompressionRequest, 4096)),
                sessionId: context.req.param('id'),
                subjectId,
              });
        return context.json(schemas.Command.parse(result), 202);
      },
    );
  app.post('/v1/sessions/:id/results/:executionId/include', async (context) => {
    if (closing) throw new HttpFailure('service_draining', 503);
    const request = await readBusinessBody(
      context.req.raw,
      schemas.IncludeResultRequest,
      options.maxBodyBytes ?? 1024 * 1024,
    );
    return context.json(
      IncludeResultResponseSchema.parse(
        await runtime.includeResult({
          ...request,
          sessionId: context.req.param('id'),
          executionId: context.req.param('executionId'),
          subjectId,
        }),
      ),
    );
  });
  app.post('/v1/sessions/:id/fork', async (context) => {
    context.header('cache-control', 'no-store');
    context.header('x-content-type-options', 'nosniff');
    if (closing) throw new HttpFailure('service_draining', 503);
    const request = await readBusinessBody(context.req.raw, schemas.ForkSessionRequest, 4096);
    return context.json(
      ForkSessionResponseSchema.parse(
        await runtime.forkSession({
          ...request,
          sourceSessionId: context.req.param('id'),
          subjectId,
        }),
      ),
    );
  });
  for (const operation of ['rename', 'delete'] as const)
    app.post(`/v1/sessions/:id/${operation}`, async (context) => {
      context.header('cache-control', 'no-store');
      context.header('x-content-type-options', 'nosniff');
      if (closing) throw new HttpFailure('service_draining', 503);
      const result =
        operation === 'rename'
          ? await runtime.renameSession({
              ...(await readBusinessBody(context.req.raw, schemas.RenameSessionRequest, 8192)),
              sessionId: context.req.param('id'),
              subjectId,
            })
          : await runtime.deleteSession({
              ...(await readBusinessBody(context.req.raw, schemas.DeleteSessionRequest, 4096)),
              sessionId: context.req.param('id'),
              subjectId,
            });
      return context.json(SessionMutationResponseSchema.parse(result));
    });
  app.get('/v1/sessions/:id/inputs', async (context) => {
    const raw = context.req.queries();
    if (Object.values(raw).some((values) => values.length !== 1))
      throw new HttpFailure('invalid_request', 400);
    const query = schemas.InputListQuery.safeParse(
      Object.fromEntries(
        Object.entries(raw).map(([key, values]) => [
          key,
          key === 'limit' ? Number(values[0]) : values[0],
        ]),
      ),
    );
    if (!query.success) throw new HttpFailure('invalid_request', 400);
    const { storeId, ...pagination } = query.data;
    return context.json(
      PendingInputPageSchema.parse(
        await runtime.listPendingInputs({
          expectedStoreId: storeId,
          sessionId: context.req.param('id'),
          ...pagination,
        }),
      ),
    );
  });
  app.post('/v1/sessions/:id/job-reports/:reportCommandId/resume', async (context) => {
    const target = schemas.ResumeJobReportTarget.safeParse({
      sessionId: context.req.param('id'),
      reportCommandId: context.req.param('reportCommandId'),
    });
    if (!target.success) throw new HttpFailure('invalid_request', 400);
    const request = await readBusinessBody(context.req.raw, schemas.ResumeJobReportRequest, 4096);
    if (closing) throw new HttpFailure('service_draining', 503);
    const command = await runtime.resumeJobReport({ ...request, ...target.data, subjectId });
    return context.json(ResumeJobReportResponseSchema.parse(command), 202);
  });
  app.post('/v1/sessions/:id/commands', async (context): Promise<Response> => {
    const request = await readBusinessBody(
      context.req.raw,
      CommandRequestSchema,
      options.maxBodyBytes ?? 8 * 1024 * 1024,
      true,
    );
    if (
      closing &&
      !['command.cancel', 'run.cancel', 'execution.cancel', 'session.cancel'].includes(request.kind)
    )
      throw new HttpFailure('service_draining', 503);
    const identity = {
      expectedStoreId: request.expectedStoreId,
      commandId: request.commandId,
      sessionId: context.req.param('id'),
      subjectId,
    };
    let command: Awaited<ReturnType<typeof runtime.submitCommand>>;
    switch (request.kind) {
      case 'input.steer':
        command = await runtime.submitCommand({
          ...identity,
          request: {
            kind: request.kind,
            content: request.content,
            targetRunId: request.targetRunId,
            contextSelectionId: request.contextSelectionId,
          },
        });
        break;
      case 'input.follow_up':
        command = await runtime.submitCommand({
          ...identity,
          request: {
            kind: request.kind,
            content: request.content,
            afterRunId: request.afterRunId,
            contextSelectionId: request.contextSelectionId,
            ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
            ...(request.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: request.reasoningEffort }),
            ...(request.selectedSkills === undefined
              ? {}
              : { selectedSkills: request.selectedSkills }),
            ...(request.extensionInputs === undefined
              ? {}
              : { extensionInputs: request.extensionInputs }),
          },
        });
        break;
      case 'command.cancel':
        command = await runtime.cancelCommand({
          ...identity,
          targetCommandId: request.targetCommandId,
        });
        break;
      case 'run.cancel':
        command = await runtime.cancelRun({ ...identity, runId: request.runId });
        break;
      case 'run.resume': {
        const target = schemas.ResumeRunTarget.safeParse({ sessionId: identity.sessionId });
        if (!target.success) throw new HttpFailure('invalid_request', 400);
        const prior = await runtime.getCommand(identity.commandId);
        const session = await runtime.getSession(identity.sessionId);
        if (!session) throw new HttpFailure('session_not_found', 404);
        // Preserve the original internal fence when replaying the same public intent.
        const priorRequest = prior?.request;
        const expectedOwnerGeneration =
          prior?.kind === 'run.resume' &&
          priorRequest !== null &&
          typeof priorRequest === 'object' &&
          !Array.isArray(priorRequest) &&
          typeof priorRequest.expectedOwnerGeneration === 'string'
            ? priorRequest.expectedOwnerGeneration
            : session.ownerGeneration;
        command = await runtime
          .resumeRun({
            ...identity,
            runId: request.runId,
            expectedOwnerGeneration,
          })
          .catch((error: unknown) => {
            if (
              error instanceof AgentError &&
              ['operation_unverifiable', 'model_source_invalid'].includes(error.code)
            )
              throw new HttpFailure(error.code, 409);
            throw error;
          });
        return context.json(ResumeRunResponseSchema.parse(command), 202);
      }
      case 'session.recover': {
        const target = schemas.RecoverSessionTarget.safeParse({ sessionId: identity.sessionId });
        if (!target.success) throw new HttpFailure('invalid_request', 400);
        const prior = await runtime.getCommand(identity.commandId);
        const session = await runtime.getSession(identity.sessionId);
        if (!session) throw new HttpFailure('session_not_found', 404);
        const original = prior?.request;
        const expectedOwnerGeneration =
          prior?.kind === 'session.recover' &&
          original !== null &&
          typeof original === 'object' &&
          !Array.isArray(original) &&
          typeof original.expectedOwnerGeneration === 'string'
            ? original.expectedOwnerGeneration
            : session.ownerGeneration;
        await runtime.recoverSession({
          ...identity,
          expectedOwnerGeneration,
          decision: request.decision,
        });
        const recovered = await runtime.getCommand(identity.commandId);
        if (!recovered) throw new HttpFailure('command_not_found', 404);
        return context.json(publicCommand(recovered), 202);
      }
      case 'job.reconcile': {
        const target = schemas.ReconcileJobTarget.safeParse({ sessionId: identity.sessionId });
        if (!target.success) throw new HttpFailure('invalid_request', 400);
        command = await runtime.reconcileJob({
          ...identity,
          executionId: request.executionId,
          expectedResultRevision: request.expectedResultRevision,
        });
        return context.json(JobReconcileCommandSchema.parse(command), 202);
      }
      case 'execution.cancel':
        command = await runtime.cancelExecution({ ...identity, executionId: request.executionId });
        break;
      case 'session.cancel':
        command = await runtime.cancelSession({
          ...identity,
          includeBackground: request.includeBackground,
        });
        break;
      case 'extension.invoke':
        command = await runtime.submitCommand({
          ...identity,
          request: {
            kind: request.kind,
            extensionId: request.extensionId,
            actionId: request.actionId,
            definitionVersion: request.definitionVersion,
            input: request.input,
          },
        });
        break;
      case 'run.start':
        command = await runtime.submitCommand({
          ...identity,
          request: {
            kind: request.kind,
            content: request.content,
            ...(request.modelId ? { modelId: request.modelId } : {}),
            ...(request.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: request.reasoningEffort }),
            ...(request.selectedSkills === undefined
              ? {}
              : { selectedSkills: request.selectedSkills }),
            ...(request.extensionInputs === undefined
              ? {}
              : { extensionInputs: request.extensionInputs }),
          },
        });
        break;
    }
    return context.json(schemas.Command.parse(command), 202);
  });
  app.get('/v1/commands/:id', async (context) => {
    const result = await runtime.getCommand(context.req.param('id'));
    if (!result) throw new HttpFailure('command_not_found', 404);
    return context.json(publicCommand(result));
  });
  app.get('/v1/runs/:id', async (context) => {
    const result = await runtime.getRun(context.req.param('id'));
    if (!result) throw new HttpFailure('run_not_found', 404);
    return context.json(schemas.Run.parse(result));
  });
  app.get('/v1/executions/:id', async (context) => {
    const result = await runtime.getExecution(context.req.param('id'));
    if (!result) throw new HttpFailure('execution_not_found', 404);
    return context.json(schemas.Execution.parse(executionResponse(result)));
  });
  app.get('/v1/executions/:id/output', async (context) => {
    const executionId = context.req.param('id');
    const limitText = context.req.query('limit') ?? '100';
    if (!/^[1-9][0-9]*$/.test(limitText) || Number(limitText) > 200)
      throw new HttpFailure('invalid_page', 400);
    const afterSeq = sequence(context.req.query('afterSeq') ?? '0');
    const upper = context.req.query('upperSeq');
    const upperSeq = upper === undefined ? undefined : sequence(upper);
    if (upperSeq !== undefined && BigInt(upperSeq) < BigInt(afterSeq))
      throw new HttpFailure('invalid_page', 400);
    if (!(await runtime.getExecution(executionId)))
      throw new HttpFailure('execution_not_found', 404);
    return context.json(
      schemas.ExecutionOutputPage.parse(
        await runtime.listExecutionOutput({
          executionId,
          afterSeq,
          limit: Number(limitText),
          ...(upperSeq === undefined ? {} : { upperSeq }),
        }),
      ),
    );
  });
  app.get('/v1/events', async (context) => {
    if (closing) throw new HttpFailure('service_draining', 503);
    const storeId = context.req.query('storeId');
    if (!storeId) throw new HttpFailure('store_id_required', 400);
    let scanCursor = sequence(context.req.query('after') ?? '0');
    const sessionIds = context.req.queries('sessionId');
    if (
      sessionIds &&
      (sessionIds.length > 32 ||
        sessionIds.some((id) => !schemas.Session.shape.id.safeParse(id).success))
    )
      throw new HttpFailure('invalid_scope', 400);
    const scope = sessionIds ? { sessionIds } : {};
    const baseline = await runtime.getChanges({ after: scanCursor, limit: 100, ...scope });
    if (baseline.metadata.storeId !== storeId) throw new HttpFailure('store_changed', 410);
    server.timeout(context.req.raw, 0);
    const abort = new AbortController();
    subscribers.add(abort);
    const onDisconnect = () => abort.abort();
    context.req.raw.signal.addEventListener('abort', onDisconnect, { once: true });
    const budget = options.sseMaxBufferedBytes ?? 256 * 1024;
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          const send = (event: string, data: unknown, id?: string) => {
            const frame = new TextEncoder().encode(
              `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            );
            if (frame.byteLength > budget || (controller.desiredSize ?? 0) < frame.byteLength) {
              abort.abort();
              return false;
            }
            controller.enqueue(frame);
            return true;
          };
          const task = (async () => {
            try {
              if (
                !send(
                  'ready',
                  schemas.StreamReady.parse({
                    storeId,
                    replayFloor: baseline.metadata.replayFloor,
                    highWaterCursor: baseline.metadata.lastChangeCursor,
                  }),
                )
              )
                return;
              let page = baseline;
              let heartbeatAt = Date.now();
              while (!abort.signal.aborted) {
                if (page.metadata.storeId !== storeId) {
                  send('reset', { code: 'store_changed' });
                  break;
                }
                for (const change of page.events) {
                  if (
                    abort.signal.aborted ||
                    !send('change', schemas.Change.parse(change), change.cursor)
                  )
                    break;
                  scanCursor = change.cursor;
                }
                if (abort.signal.aborted) break;
                if (Date.now() - heartbeatAt >= 15_000) {
                  if (!send('heartbeat', {})) break;
                  heartbeatAt = Date.now();
                }
                if (page.events.length < 100) {
                  if (scanCursor !== page.metadata.lastChangeCursor) {
                    if (
                      !send(
                        'checkpoint',
                        schemas.StreamCheckpoint.parse({
                          storeId,
                          cursor: page.metadata.lastChangeCursor,
                        }),
                        page.metadata.lastChangeCursor,
                      )
                    )
                      break;
                    scanCursor = page.metadata.lastChangeCursor;
                  }
                  await delay(25, abort.signal);
                }
                if (!abort.signal.aborted)
                  page = await runtime.getChanges({ after: scanCursor, limit: 100, ...scope });
              }
            } catch (error) {
              if (!abort.signal.aborted)
                send('reset', {
                  code: error instanceof AgentError ? error.code : 'events_unavailable',
                });
            } finally {
              subscribers.delete(abort);
              context.req.raw.signal.removeEventListener('abort', onDisconnect);
              try {
                controller.close();
              } catch {
                /* Consumer already cancelled. */
              }
            }
          })();
          streaming.add(task);
          void task.finally(() => streaming.delete(task));
        },
        cancel() {
          abort.abort();
        },
      },
      { highWaterMark: budget, size: (chunk) => chunk?.byteLength ?? 0 },
    );
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
      },
    });
  });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
  endpoint = `http://127.0.0.1:${server.port}`;
  const info = await serverInfo().catch(async (error) => {
    await server.stop(true);
    throw error;
  });
  const bootstrap = { endpoint, token, ...info };
  return {
    endpoint,
    bootstrap,
    closedPromise: lifecycle.closedPromise,
    close() {
      const result = beginShutdown('cancel');
      if (!result.accepted) throw Error('lifecycle_busy');
      return result.completion;
    },
  };
}
