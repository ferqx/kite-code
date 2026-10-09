import { createHash } from 'node:crypto';
import { AgentError, type AgentRuntime } from '@kite-ai/agent';
import { ConfigurationError, type McpSourceReadSet, mcpCanonical } from '@kite-ai/agent/config';
import type {
  ActionContext,
  ActionDefinition,
  Json,
  QueryDefinition,
} from '@kite-ai/agent/extensions';
import { McpAdapterError } from '@kite-ai/agent/mcp';
import type { CommandRecord, ExecutionRecord, JsonSchema } from '@kite-ai/agent/storage';
import { decodeMcpOAuthLauncherEvidence, type McpAuthBinding } from './mcp-oauth-launcher-evidence';
import { type createMcpOAuthSession, McpOAuthSessionError } from './mcp-oauth-session';
import { validMcpSourceReadSet } from './mcp-source-result';

const extensionId = 'builtin.mcp.sources';
const actions = [
  'mcp.auth.login',
  'mcp.auth.refresh',
  'mcp.auth.clear',
  'mcp.auth.revoke',
] as const;
type AuthAction = (typeof actions)[number];
const object = (value: unknown): Record<string, Json> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
const hash = (value: unknown) => createHash('sha256').update(mcpCanonical(value)).digest('hex');
const equal = (a: unknown, b: unknown) => mcpCanonical(a) === mcpCanonical(b);
const closed = (value: Record<string, Json>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const finite = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(value);
type Host = Pick<AgentRuntime, 'getMetadata' | 'getSession' | 'getCommand' | 'getExecution'>;
type Binding = McpAuthBinding;
export interface McpOAuthTarget {
  workspaceId: string;
  loginAllowed: boolean;
  /** Same actual Workspace coordinator used by connection resume and source removal. */
  acquire(signal: AbortSignal): Promise<() => void>;
  assertFresh(signal: AbortSignal): void;
  session(
    signal: AbortSignal,
  ): Omit<ReturnType<typeof createMcpOAuthSession>, 'readLauncherEvidence'> &
    Partial<Pick<ReturnType<typeof createMcpOAuthSession>, 'readLauncherEvidence'>>;
  status(signal: AbortSignal): Promise<{
    policy: 'oauth' | 'auto';
    status: 'available' | 'locked' | 'unavailable';
    credentialPresent: boolean;
  }>;
}
function request(command: CommandRecord) {
  const value = object(command.request),
    input = object(value.input);
  if (
    command.kind !== 'extension.invoke' ||
    !closed(value, ['kind', 'extensionId', 'actionId', 'definitionVersion', 'input']) ||
    value.kind !== 'extension.invoke' ||
    value.extensionId !== extensionId ||
    value.definitionVersion !== '1' ||
    !actions.includes(value.actionId as AuthAction) ||
    !closed(input, ['serverId', 'expectedReadSet']) ||
    typeof input.serverId !== 'string' ||
    !/^mcp-[a-f0-9]{64}$/.test(input.serverId) ||
    !validMcpSourceReadSet(input.expectedReadSet) ||
    hash(command.request) !== command.requestDigest
  )
    return null;
  return {
    action: value.actionId as AuthAction,
    input,
    serverId: input.serverId,
    readSet: input.expectedReadSet as unknown as McpSourceReadSet,
  };
}
function executionMatches(command: CommandRecord, execution: ExecutionRecord, action: AuthAction) {
  return (
    execution.originCommandId === command.id &&
    execution.originStoreId === command.originStoreId &&
    execution.sessionId === command.sessionId &&
    execution.kind === 'job' &&
    execution.runId === null &&
    execution.parentExecutionId === null &&
    execution.definitionId === `${extensionId}/${action}` &&
    execution.definitionVersion === '1' &&
    execution.rootWorkCommandId === command.rootWorkCommandId &&
    execution.rootWorkSeq === command.rootWorkSeq &&
    equal(execution.input, object(command.request).input)
  );
}
function binding(
  command: CommandRecord,
  execution: ExecutionRecord,
  workspaceId: string,
  action: AuthAction,
  serverId: string,
): Binding {
  return {
    version: 1,
    executionId: execution.id,
    originCommandId: command.id,
    originalStoreId: command.originStoreId,
    sessionId: command.sessionId,
    workspaceId,
    actionId: action,
    serverId,
    inputDigest: hash(execution.input),
  };
}
function display(contentType: string, payload: Record<string, Json>) {
  const value = [
    {
      extensionId,
      contentType,
      contentVersion: 1,
      summary: 'MCP authentication; connection and Tool permission remain separate',
      payload,
      artifactRefs: [],
      actions: [],
    },
  ];
  if (Buffer.byteLength(JSON.stringify(value)) > 16384)
    throw new AgentError('mcp_auth_result_limit');
  return value;
}

/** Ordinary Actions own the effect; their original C/E is the durable intent and historical receipt. */
export function createMcpOAuthActions(options: {
  runtime(): Host;
  observerSubjectId?: string;
  readSetSchema: JsonSchema;
  resolve(sessionId: string, serverId: string, readSet: McpSourceReadSet): Promise<McpOAuthTarget>;
}): { actions: ActionDefinition[]; queries: QueryDefinition[] } {
  async function execute(action: AuthAction, input: Json, context: ActionContext) {
    let identity: Binding | null = null,
      effectAttempted = false;
    let release: (() => void) | undefined;
    let loginSession: ReturnType<McpOAuthTarget['session']> | undefined;
    const launcherDetails = (): Record<string, Json> => {
      if (!loginSession?.readLauncherEvidence || !identity) return {};
      try {
        const observation = loginSession.readLauncherEvidence();
        if (observation === undefined) return {};
        const evidence = decodeMcpOAuthLauncherEvidence(
          { ...observation, binding: identity },
          identity,
          process.pid,
        );
        if (evidence) return { ownedLauncher: evidence as unknown as Json };
      } catch {
        /* Observation cannot change the original OAuth outcome. */
      }
      return { ownedLauncherUnavailable: 'mcp_oauth_launcher_evidence_unavailable' };
    };
    const result = (
      outcome: 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown',
      code: string,
      authStatus: string,
    ) => ({
      outcome,
      content: code,
      details: {
        binding: identity as unknown as Json,
        code,
        authStatus,
        effectAttempted,
        connectionAttempted: false,
        modelAttempted: false,
        ...launcherDetails(),
      },
    });
    const perform = async () => {
      try {
        const host = options.runtime(),
          metadata = await host.getMetadata(),
          own = await host.getExecution(context.executionId);
        const command = own && (await host.getCommand(own.originCommandId)),
          original = command && request(command);
        const current = await host.getSession(context.sessionId);
        if (
          !options.observerSubjectId ||
          !current ||
          current.deletedAt !== null ||
          !own ||
          !command ||
          !original ||
          original.action !== action ||
          command.subjectId !== options.observerSubjectId ||
          command.originStoreId !== metadata.storeId ||
          command.sessionId !== context.sessionId ||
          object(command.receipt).executionId !== own.id ||
          !executionMatches(command, own, action) ||
          !['dispatching', 'running'].includes(own.status) ||
          !equal(input, own.input)
        )
          return result('failed', 'operation_unverifiable', 'unknown');
        identity = binding(command, own, current.workspaceId, action, original.serverId);
        context.signal.throwIfAborted();
        const target = await options.resolve(
          context.sessionId,
          original.serverId,
          original.readSet,
        );
        if (target.workspaceId !== current.workspaceId)
          throw new AgentError('mcp_source_scope_invalid');
        release = await target.acquire(context.signal);
        target.assertFresh(context.signal);
        const freshExecution = await host.getExecution(own.id),
          freshCommand = await host.getCommand(command.id),
          freshSession = await host.getSession(current.id);
        if (
          !freshExecution ||
          !freshCommand ||
          !freshSession ||
          freshSession.deletedAt !== null ||
          freshSession.workspaceId !== current.workspaceId ||
          !request(freshCommand) ||
          !executionMatches(freshCommand, freshExecution, action) ||
          !equal(freshCommand.request, command.request) ||
          freshCommand.subjectId !== options.observerSubjectId ||
          object(freshCommand.receipt).executionId !== own.id ||
          !['dispatching', 'running'].includes(freshExecution.status) ||
          freshExecution.cancelRequestedAt !== null ||
          freshCommand.cancelRequestedAt !== null
        )
          throw new AgentError('operation_unverifiable');
        target.assertFresh(context.signal);
        if (action === 'mcp.auth.login' && !target.loginAllowed)
          throw new McpOAuthSessionError('mcp_oauth_login_unavailable');
        const session = target.session(context.signal);
        effectAttempted = true;
        if (action === 'mcp.auth.login') {
          loginSession = session;
          await session.login();
        } else if (action === 'mcp.auth.refresh') await session.refresh();
        else if (action === 'mcp.auth.clear') await session.clear();
        else if ((await session.revoke()) === 'not_supported')
          return result('succeeded', 'mcp_oauth_revocation_not_supported', 'not_supported');
        target.assertFresh(context.signal);
        return result(
          'succeeded',
          action === 'mcp.auth.login' || action === 'mcp.auth.refresh'
            ? 'mcp_oauth_authenticated'
            : 'mcp_oauth_credentials_cleared',
          action === 'mcp.auth.login' || action === 'mcp.auth.refresh'
            ? 'authenticated'
            : 'revoked',
        );
      } catch (error) {
        const code =
          error instanceof McpOAuthSessionError ||
          error instanceof AgentError ||
          error instanceof McpAdapterError ||
          error instanceof ConfigurationError
            ? finite(error.code)
              ? error.code
              : 'mcp_oauth_unavailable'
            : context.signal.aborted
              ? 'mcp_oauth_cancelled'
              : 'mcp_oauth_unavailable';
        const unknown = code.endsWith('_unknown');
        return result(
          unknown
            ? 'outcome_unknown'
            : context.signal.aborted || code === 'mcp_oauth_cancelled'
              ? 'cancelled'
              : 'failed',
          code,
          unknown
            ? 'unknown'
            : code === 'mcp_oauth_reauth_required'
              ? 'reauth_required'
              : code === 'mcp_oauth_cancelled'
                ? 'cancelled'
                : 'error',
        );
      }
    };
    let response: ReturnType<typeof result>;
    let cleanupFailed = false;
    try {
      response = await perform();
    } finally {
      try {
        release?.();
      } catch {
        cleanupFailed = true;
      }
    }
    return cleanupFailed
      ? result('outcome_unknown', 'mcp_oauth_cleanup_unknown', 'unknown')
      : response;
  }
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['serverId', 'expectedReadSet'],
    properties: {
      serverId: { type: 'string', pattern: '^mcp-[a-f0-9]{64}$' },
      expectedReadSet: options.readSetSchema,
    },
  };
  return {
    actions: actions.map(
      (action): ActionDefinition => ({
        id: action,
        version: '1',
        description: {
          'mcp.auth.login':
            'Explicit OAuth login; browser and callback are scoped to this Execution',
          'mcp.auth.refresh':
            'Refresh existing owned OAuth credentials without browser or registration',
          'mcp.auth.clear': 'Clear only the exact locally owned OAuth credentials',
          'mcp.auth.revoke': 'Explicit remote OAuth revoke when supported, followed by local clear',
        }[action],
        inputSchema: schema,
        prepare: async (input) => structuredClone(input),
        execute: (input, context) => execute(action, input, context),
      }),
    ),
    queries: [
      {
        id: 'mcp.auth.status',
        version: '1',
        description: 'Read safe authentication status independently from connection health',
        inputSchema: schema,
        outputSchema: { type: 'array' },
        async execute(input, context) {
          if (!options.observerSubjectId) throw new AgentError('mcp_auth_observer_unavailable');
          const value = object(input);
          const target = await options.resolve(
            context.sessionId,
            String(value.serverId),
            value.expectedReadSet as unknown as McpSourceReadSet,
          );
          const signal = new AbortController().signal;
          return display('builtin.mcp.auth.status', {
            serverId: value.serverId!,
            workspaceId: target.workspaceId,
            loginAllowed: target.loginAllowed,
            ...(await target.status(signal)),
          });
        },
      },
      {
        id: 'mcp.auth.result',
        version: '1',
        description:
          'Read the original authentication Execution receipt without vault, source, transport or browser',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['commandId'],
          properties: { commandId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } },
        },
        outputSchema: { type: 'array' },
        async execute(input, context) {
          if (!context.readExecutionGroupSafety)
            throw new AgentError('mcp_auth_observer_unavailable');
          const admission = await context.readExecutionGroupSafety(),
            host = options.runtime(),
            metadata = await host.getMetadata();
          if (admission.originStoreId !== metadata.storeId)
            throw new AgentError('operation_unverifiable');
          const payload: Record<string, Json> = {
            storeId: metadata.storeId,
            sessionId: context.sessionId,
            command: null,
            execution: null,
            binding: null,
            phase: 'outcome_unknown',
            authStatus: 'unknown',
            effectAttempted: null,
            reason: 'original_proof_unavailable',
          };
          const output = () => display('builtin.mcp.auth.result', payload);
          if (!options.observerSubjectId) return output();
          const command = await host.getCommand(String(object(input).commandId));
          if (
            !command ||
            command.originStoreId !== metadata.storeId ||
            command.sessionId !== context.sessionId ||
            command.subjectId !== options.observerSubjectId
          )
            return output();
          const original = request(command),
            receipt = object(command.receipt);
          if (!original) throw new AgentError('operation_unverifiable');
          payload.command = {
            id: command.id,
            originStoreId: command.originStoreId,
            sessionId: command.sessionId,
            subjectId: command.subjectId,
            requestDigest: command.requestDigest,
            status: command.status,
            executionId: typeof receipt.executionId === 'string' ? receipt.executionId : null,
          };
          if (typeof receipt.executionId !== 'string') {
            if (command.status === 'accepted') {
              payload.phase = 'pending';
              payload.reason = null;
            }
            return output();
          }
          const own = await host.getExecution(receipt.executionId),
            session = await host.getSession(context.sessionId);
          if (!own || !session || !executionMatches(command, own, original.action)) return output();
          payload.execution = {
            id: own.id,
            originStoreId: own.originStoreId,
            sessionId: own.sessionId,
            originCommandId: own.originCommandId,
            parentExecutionId: null,
            kind: 'job',
            definitionId: own.definitionId,
            definitionVersion: own.definitionVersion,
            inputDigest: hash(own.input),
            status: own.status,
          };
          const expected = binding(
            command,
            own,
            session.workspaceId,
            original.action,
            original.serverId,
          );
          payload.binding = expected as unknown as Json;
          if (['planned', 'dispatching', 'running'].includes(own.status)) {
            payload.phase = 'pending';
            payload.reason = null;
            return output();
          }
          if (
            command.status !== 'applied' ||
            receipt.status !== own.status ||
            receipt.preparingNextAttempt === true ||
            receipt.finalizationDigest !==
              hash({
                status: own.status,
                preparingNextAttempt: false,
                result: own.result,
                writes: [],
                message: null,
              })
          )
            return output();
          const result = object(own.result),
            details = object(result.details);
          if (
            !closed(result, ['outcome', 'content', 'details']) ||
            !closed(details, [
              ...(Object.hasOwn(details, 'ownedLauncher') ? ['ownedLauncher'] : []),
              ...(Object.hasOwn(details, 'ownedLauncherUnavailable')
                ? ['ownedLauncherUnavailable']
                : []),
              'binding',
              'code',
              'authStatus',
              'effectAttempted',
              'connectionAttempted',
              'modelAttempted',
            ]) ||
            !equal(details.binding, expected) ||
            !finite(details.code) ||
            result.content !== details.code ||
            result.outcome !== own.status ||
            typeof details.effectAttempted !== 'boolean' ||
            details.connectionAttempted !== false ||
            details.modelAttempted !== false ||
            ![
              'authenticated',
              'revoked',
              'not_supported',
              'reauth_required',
              'error',
              'cancelled',
              'unknown',
            ].includes(String(details.authStatus))
          )
            return output();
          if (
            Object.hasOwn(details, 'ownedLauncher') ||
            Object.hasOwn(details, 'ownedLauncherUnavailable')
          ) {
            if (
              original.action !== 'mcp.auth.login' ||
              (Object.hasOwn(details, 'ownedLauncher') &&
                Object.hasOwn(details, 'ownedLauncherUnavailable'))
            )
              return output();
            if (Object.hasOwn(details, 'ownedLauncher')) {
              const evidence = decodeMcpOAuthLauncherEvidence(details.ownedLauncher, expected);
              if (!evidence) return output();
            } else {
              if (details.ownedLauncherUnavailable !== 'mcp_oauth_launcher_evidence_unavailable')
                return output();
            }
          }
          const succeeded =
            own.status === 'succeeded' &&
            details.effectAttempted === true &&
            (['mcp.auth.login', 'mcp.auth.refresh'].includes(original.action)
              ? details.code === 'mcp_oauth_authenticated' && details.authStatus === 'authenticated'
              : (details.code === 'mcp_oauth_credentials_cleared' &&
                  details.authStatus === 'revoked') ||
                (original.action === 'mcp.auth.revoke' &&
                  details.code === 'mcp_oauth_revocation_not_supported' &&
                  details.authStatus === 'not_supported'));
          if (own.status === 'succeeded' && !succeeded) return output();
          payload.phase = succeeded
            ? 'completed'
            : ['failed', 'cancelled'].includes(own.status)
              ? own.status
              : 'outcome_unknown';
          payload.authStatus = details.authStatus!;
          payload.effectAttempted = details.effectAttempted;
          payload.reason = details.code;
          return output();
        },
      },
    ],
  };
}
