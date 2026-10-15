import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type AgentClient,
  type Command,
  decodeMcpToolsPage,
  decodeMcpToolsSnapshots,
  type Execution,
  readMcpToolDescriptor,
} from '@kite-ai/client';
import {
  decodeTuiMcpLabels,
  decodeTuiMcpSnapshot,
  type TuiMcpIntent,
  type TuiMcpOutcome,
  type TuiMcpPort,
  type TuiMcpReadDirectory,
  type TuiMcpSnapshot,
} from '@kite-ai/ui/tui';
import type { McpConnectionJournal } from './mcp-connection-journal';
import type { McpReconnectionJournal } from './mcp-reconnection-journal';
import {
  createMcpSelectionRecord,
  mcpCanonical,
  mcpRecordIdentity,
  parseMcpIntent,
} from './mcp-selection-intents';
import type { McpSelectionJournal } from './mcp-selection-journal';
import type { McpSourceApprovalJournal } from './mcp-source-approval-journal';
import type { McpSourceMutationJournal } from './mcp-source-mutation-journal';
import { createTuiMcpConnectionPort } from './tui-mcp-connection';
import { createTuiMcpReconnectionPort } from './tui-mcp-reconnection';
import { createTuiMcpSourceApprovalPort } from './tui-mcp-source-approval';
import { createTuiMcpSourceMutationPort } from './tui-mcp-source-mutation';

const obj = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
// Only this fixed request is hashed. Identity envelope fields are not persisted request bytes.
const digest = (value: unknown): string => {
  const canonical = (part: unknown): unknown => {
    if (Array.isArray(part)) return part.map(canonical);
    const row = obj(part);
    return row
      ? Object.fromEntries(
          Object.keys(row)
            .sort()
            .map((key) => [key, canonical(row[key])]),
        )
      : part;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
};
export function createTuiMcpPort(
  client: Pick<
    AgentClient,
    | 'queryExtension'
    | 'invokeExtension'
    | 'getCommand'
    | 'getExecution'
    | 'getHostMutation'
    | 'serverInfo'
    | 'getView'
    | 'listWorkspaces'
  > &
    Partial<Pick<AgentClient, 'readArtifact' | 'listAllWorkspaces'>>,
  storeId: string,
  journal?: McpSelectionJournal,
  connectionJournal?: McpConnectionJournal,
  sourceJournal?: McpSourceApprovalJournal,
  reconnectionJournal?: McpReconnectionJournal,
  sourceMutationJournal?: McpSourceMutationJournal,
): TuiMcpPort {
  const currentSubject = () => client.serverInfo?.subjectId;
  function toolsAdmission(sessionId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!sessionId || !currentSubject() || client.serverInfo?.storeId !== storeId)
      throw Error('mcp_tools_scope_mismatch');
  }
  async function stored(intent: TuiMcpIntent, signal?: AbortSignal) {
    const parsed = parseMcpIntent(intent);
    const subjectId = currentSubject();
    if (
      !journal ||
      !subjectId ||
      parsed.request.expectedStoreId !== storeId ||
      client.serverInfo?.storeId !== storeId
    )
      throw Error('mcp_selection_scope_unavailable');
    const candidate = createMcpSelectionRecord(parsed, subjectId);
    const record = journal
      .list()
      .find((row) => row.intent.request.commandId === parsed.request.commandId);
    if (!record || mcpRecordIdentity(record) !== mcpRecordIdentity(candidate))
      throw Error('mcp_selection_original_unavailable');
    signal?.throwIfAborted();
    return record;
  }
  async function scope(intent: TuiMcpIntent, signal?: AbortSignal) {
    if (
      intent.request.expectedStoreId !== storeId ||
      !currentSubject() ||
      client.serverInfo?.storeId !== storeId
    )
      throw Error('mcp_selection_scope_unavailable');
    const view = await client.getView(intent.sessionId, { signal });
    if (
      view.storeId !== storeId ||
      view.session.id !== intent.sessionId ||
      view.session.workspaceId !== intent.workspaceId ||
      view.session.deletedAt !== null
    )
      throw Error('mcp_selection_scope_unavailable');
    const workspace = (await client.listWorkspaces({ signal })).find(
      (row) => row.id === intent.workspaceId,
    );
    if (!workspace) throw Error('mcp_selection_scope_unavailable');
    const uri = new URL(workspace.rootUri);
    if (
      workspace.id !== intent.workspaceId ||
      uri.protocol !== 'file:' ||
      (uri.hostname && uri.hostname !== 'localhost')
    )
      throw Error('mcp_selection_scope_unavailable');
    const lexical = fileURLToPath(uri),
      stat = lstatSync(lexical, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      mcpCanonical({
        root: realpathSync(lexical),
        dev: String(stat.dev),
        ino: String(stat.ino),
      }) !== intent.workspaceIdentity
    )
      throw Error('mcp_selection_workspace_changed');
  }
  function original(intent: TuiMcpIntent, command: Command) {
    const subjectId = currentSubject();
    const { commandId: _commandId, expectedStoreId: _storeId, ...request } = intent.request;
    if (
      intent.request.expectedStoreId !== storeId ||
      !subjectId ||
      command.id !== intent.request.commandId ||
      command.originStoreId !== storeId ||
      command.sessionId !== intent.sessionId ||
      command.kind !== 'extension.invoke' ||
      command.subjectId !== subjectId ||
      command.requestDigest !== digest(request)
    )
      throw Error('mcp_original_command_mismatch');
  }
  async function outcome(intent: TuiMcpIntent, signal?: AbortSignal): Promise<TuiMcpOutcome> {
    await stored(intent, signal);
    const command = await client.getCommand(intent.request.commandId, { signal });
    original(intent, command);
    if (command.status === 'rejected') return { intent, phase: 'failed', command };
    const receipt = obj(command.receipt);
    if (command.status !== 'applied') return { intent, phase: 'pending', command };
    if (!receipt || typeof receipt.executionId !== 'string' || !receipt.executionId)
      throw Error('mcp_original_execution_unavailable');
    const execution: Execution = await client.getExecution(receipt.executionId, { signal });
    if (
      execution.id !== receipt.executionId ||
      execution.originStoreId !== storeId ||
      execution.sessionId !== intent.sessionId ||
      execution.kind !== 'job' ||
      execution.runId !== null ||
      execution.definitionId !== 'builtin.mcp.management/mcp.server.select' ||
      execution.definitionVersion !== '1'
    )
      throw Error('mcp_original_execution_mismatch');
    const result = obj(execution.result),
      details = obj(result?.details);
    if (['planned', 'dispatching', 'running'].includes(execution.status))
      return { intent, phase: 'pending', command, execution };
    if (
      ['failed', 'cancelled'].includes(execution.status) &&
      ['failed', 'cancelled'].includes(String(result?.outcome)) &&
      details?.effectAttempted === false
    )
      return { intent, phase: 'failed', command, execution };
    const binding = obj(details?.binding),
      mutation = obj(details?.mutation),
      input = intent.request.input;
    const expectedMutationDigest = digest({
      executionId: execution.id,
      inputDigest: digest(input),
      ...input,
    });
    const savedReceipt = obj(mutation?.receipt),
      safe = obj(mutation?.safeRequest);
    if (
      execution.status !== 'succeeded' ||
      result?.outcome !== 'succeeded' ||
      binding?.executionId !== execution.id ||
      binding?.originCommandId !== command.id ||
      binding?.originalStoreId !== storeId ||
      binding?.sessionId !== intent.sessionId ||
      binding?.serverId !== input.serverId ||
      binding?.enabled !== input.enabled ||
      binding?.scope !== input.scope ||
      mutation?.id !== `mcp-select-${execution.id}` ||
      mutation.originStoreId !== storeId ||
      mutation.subjectId !== currentSubject() ||
      mutation.requestDigest !== expectedMutationDigest ||
      mutation.kind !== (input.scope === 'user' ? 'config.user.write' : 'config.workspace.write') ||
      mutation.scope !== (input.scope === 'user' ? 'user' : intent.workspaceId) ||
      mutation.state !== 'applied' ||
      savedReceipt?.status !== 'applied' ||
      typeof savedReceipt.etag !== 'string' ||
      !/^[a-f0-9]{64}$/.test(savedReceipt.etag) ||
      safe?.scope !== input.scope ||
      safe.ifMatch !==
        (input.scope === 'user'
          ? input.expectedReadSet.userEtag
          : input.expectedReadSet.workspaceEtag) ||
      safe.operationCount !== 1 ||
      (input.scope === 'workspace' && safe.workspaceId !== intent.workspaceId)
    )
      return { intent, phase: 'outcome_unknown', command, execution };
    const confirmed = await client.getHostMutation(mutation.id as string, { storeId, signal });
    if (
      confirmed.commandId !== mutation.id ||
      confirmed.originStoreId !== storeId ||
      confirmed.kind !== 'config.patch' ||
      confirmed.scope !== input.scope ||
      confirmed.workspaceId !== (input.scope === 'workspace' ? intent.workspaceId : undefined) ||
      confirmed.ifMatch !== safe.ifMatch ||
      confirmed.state !== 'applied' ||
      obj(confirmed.receipt)?.status !== 'applied' ||
      obj(confirmed.receipt)?.etag !== savedReceipt.etag
    )
      throw Error('mcp_original_mutation_mismatch');
    return { intent, phase: 'applied', command, execution };
  }
  const fullClient = client.listAllWorkspaces
    ? {
        get serverInfo() {
          return client.serverInfo;
        },
        queryExtension: client.queryExtension.bind(client),
        invokeExtension: client.invokeExtension.bind(client),
        getCommand: client.getCommand.bind(client),
        getView: client.getView.bind(client),
        listAllWorkspaces: client.listAllWorkspaces.bind(client),
      }
    : undefined;
  const source =
    sourceJournal && fullClient
      ? createTuiMcpSourceApprovalPort(fullClient, storeId, sourceJournal)
      : undefined;
  const connection =
    connectionJournal && fullClient
      ? createTuiMcpConnectionPort(fullClient, storeId, connectionJournal)
      : undefined;
  return {
    ...(source ? { source } : {}),
    ...(source && fullClient && sourceMutationJournal
      ? {
          sourceMutation: createTuiMcpSourceMutationPort(
            fullClient,
            storeId,
            sourceMutationJournal,
            (sessionId, signal) => source.read(sessionId, signal),
          ),
        }
      : {}),
    ...(connection ? { connection } : {}),
    ...(connectionJournal && reconnectionJournal && fullClient
      ? {
          reconnection: createTuiMcpReconnectionPort(
            fullClient,
            storeId,
            { connection: connectionJournal, reconnection: reconnectionJournal },
            source,
          ),
        }
      : {}),
    async readDirectory(sessionId, family, signal, options = {}) {
      toolsAdmission(sessionId, signal);
      const before = await client.getView(sessionId, { signal });
      const result = await client.queryExtension(
        sessionId,
        'builtin.mcp',
        `mcp.${family}`,
        {
          ...(options.serverId ? { serverId: options.serverId } : {}),
          ...(options.afterKey ? { afterKey: options.afterKey } : {}),
          limit: 32,
        },
        { signal },
      );
      const after = await client.getView(sessionId, { signal });
      toolsAdmission(sessionId, signal);
      if (
        before.storeId !== storeId ||
        after.storeId !== storeId ||
        before.session.id !== sessionId ||
        after.session.id !== sessionId ||
        before.session.deletedAt !== null ||
        after.session.deletedAt !== null ||
        before.session.workspaceId !== after.session.workspaceId
      )
        throw Error('mcp_read_directory_scope_mismatch');
      return decodeRetainedMcpDirectory(
        result,
        family,
        storeId,
        sessionId,
        after.session.workspaceId,
        options,
      );
    },
    async readToolsSnapshots(sessionId, signal, options = {}) {
      toolsAdmission(sessionId, signal);
      const snapshots = decodeMcpToolsSnapshots(
        await client.queryExtension(
          sessionId,
          'builtin.mcp',
          'mcp.tools.snapshots',
          {
            ...(options.serverId ? { serverId: options.serverId } : {}),
            ...(options.afterKey ? { afterKey: options.afterKey } : {}),
            limit: 32,
          },
          { signal },
        ),
      );
      toolsAdmission(sessionId, signal);
      if (
        snapshots.sessionId !== sessionId ||
        snapshots.items.some((row) => row.origin.sessionId !== sessionId)
      )
        throw Error('mcp_tools_scope_mismatch');
      const afterKey = options.afterKey;
      if (
        afterKey &&
        ((snapshots.nextAfterKey !== null && snapshots.nextAfterKey <= afterKey) ||
          snapshots.items.some((row) => row.recordKey <= afterKey))
      )
        throw Error('mcp_tools_cursor_stale');
      return snapshots;
    },
    async readToolsPage(sessionId, rawSnapshot, signal, options = {}) {
      toolsAdmission(sessionId, signal);
      const snapshot = structuredClone(rawSnapshot);
      if (
        snapshot.origin.sessionId !== sessionId ||
        (options.indexDigest !== undefined && options.indexDigest !== snapshot.index?.hash)
      )
        throw Error('mcp_tools_scope_mismatch');
      const page = decodeMcpToolsPage(
        await client.queryExtension(
          sessionId,
          'builtin.mcp',
          'mcp.tools',
          {
            recordKey: snapshot.recordKey,
            generation: snapshot.origin.generation,
            ...(snapshot.index ? { indexDigest: snapshot.index.hash } : {}),
            afterIndex: options.afterIndex ?? 0,
            limit: 32,
          },
          { signal },
        ),
      );
      toolsAdmission(sessionId, signal);
      if (
        page.recordKey !== snapshot.recordKey ||
        page.toolCount !== snapshot.toolCount ||
        page.startIndex !== (options.afterIndex ?? 0) ||
        page.binding.indexDigest !== (snapshot.index?.hash ?? null) ||
        Object.entries(snapshot.origin).some(
          ([key, value]) => page.binding[key as keyof typeof snapshot.origin] !== value,
        )
      )
        throw Error('mcp_tools_scope_mismatch');
      return page;
    },
    async readToolDescriptor(sessionId, binding, entry, signal) {
      toolsAdmission(sessionId, signal);
      if (!client.readArtifact || binding.sessionId !== sessionId)
        throw Error('mcp_tools_scope_mismatch');
      const metadata = await readMcpToolDescriptor({
        currentStoreId: storeId,
        sessionId,
        binding,
        entry,
        signal,
        readArtifact: (session, input, options) => client.readArtifact!(session, input, options),
      });
      toolsAdmission(sessionId, signal);
      return metadata;
    },
    read: async (sessionId, signal) => {
      const facts = decodeTuiMcpSnapshot(
        await client.queryExtension(
          sessionId,
          'builtin.mcp.management',
          'mcp.servers',
          {},
          { signal },
        ),
      );
      if (facts.storeId !== storeId || facts.sessionId !== sessionId)
        throw Error('mcp_directory_scope_mismatch');
      let liveServerIds: string[] | undefined;
      const details: Record<string, NonNullable<TuiMcpSnapshot['details']>[string]> = {};
      const payloadOf = (response: unknown, extension: string, type: string) => {
        if (!Array.isArray(response) || response.length !== 1) throw Error('mcp_metadata_invalid');
        const envelope = obj(response[0]);
        if (
          envelope?.extensionId !== extension ||
          envelope.contentType !== type ||
          envelope.contentVersion !== 1 ||
          !Array.isArray(envelope.actions) ||
          envelope.actions.length ||
          !Array.isArray(envelope.artifactRefs) ||
          envelope.artifactRefs.length
        )
          throw Error('mcp_metadata_invalid');
        const payload = obj(envelope.payload);
        if (!payload || !Array.isArray(payload.items)) throw Error('mcp_metadata_invalid');
        return payload;
      };
      try {
        const selected = new Set<string>(),
          keys = new Set<string>();
        let afterKey: string | undefined;
        for (let pages = 0; ; pages++) {
          toolsAdmission(sessionId, signal);
          if (pages >= 1024) throw Error('mcp_catalogue_incomplete');
          const payload = payloadOf(
            await client.queryExtension(
              sessionId,
              'builtin.mcp',
              'mcp.catalogue',
              { limit: 100, ...(afterKey ? { afterKey } : {}) },
              { signal },
            ),
            'builtin.mcp',
            'builtin.mcp.catalogue',
          );
          toolsAdmission(sessionId, signal);
          const items = payload.items as unknown[];
          if (
            items.length > 100 ||
            !(
              payload.nextAfterKey === null ||
              (typeof payload.nextAfterKey === 'string' &&
                payload.nextAfterKey.length > 0 &&
                payload.nextAfterKey.length <= 256)
            )
          )
            throw Error('mcp_catalogue_incomplete');
          let previous = afterKey ?? '';
          for (const item of items) {
            const row = obj(item),
              record = obj(row?.record),
              current = obj(row?.currentCatalogue),
              ref = obj(record?.operationRef);
            if (
              !row ||
              typeof row.key !== 'string' ||
              row.key.length > 256 ||
              row.key <= previous ||
              keys.has(row.key)
            )
              throw Error('mcp_catalogue_incomplete');
            previous = row.key;
            keys.add(row.key);
            if (row.live !== true) continue;
            if (
              row.originStoreId !== storeId ||
              record?.originalStoreId !== storeId ||
              typeof record.serverId !== 'string' ||
              current?.serverId !== record.serverId ||
              current.available !== true ||
              current.configDigest !== record.configDigest ||
              !Number.isSafeInteger(current.generation) ||
              ref?.originStoreId !== storeId ||
              ref.sessionId !== sessionId ||
              ref.extensionId !== 'builtin.mcp' ||
              typeof ref.executionId !== 'string'
            )
              throw Error('mcp_catalogue_scope_mismatch');
            if (
              !facts.items.some(
                (server) =>
                  server.id === record.serverId && server.configDigest === current.configDigest,
              )
            )
              continue;
            selected.add(record.serverId);
          }
          if (payload.nextAfterKey === null) break;
          if (!items.length || payload.nextAfterKey !== previous)
            throw Error('mcp_catalogue_incomplete');
          afterKey = payload.nextAfterKey as string;
        }
        liveServerIds = [...selected];
      } catch {
        signal.throwIfAborted();
      }
      try {
        const payload = payloadOf(
          await client.queryExtension(
            sessionId,
            'builtin.mcp.management',
            'mcp.server.locations',
            {},
            { signal },
          ),
          'builtin.mcp.management',
          'builtin.mcp.server.locations',
        );
        if (
          payload.storeId !== storeId ||
          payload.sessionId !== sessionId ||
          payload.workspaceId !== facts.workspaceId ||
          payload.workspaceIdentity !== facts.workspaceIdentity ||
          payload.workspacePath !== facts.workspacePath ||
          mcpCanonical(payload.readSet) !== mcpCanonical(facts.readSet)
        )
          throw Error('mcp_metadata_scope_mismatch');
        const seen = new Set<string>();
        for (const item of payload.items as unknown[]) {
          const row = obj(item),
            server = facts.items.find(
              (server) => server.id === row?.serverId && server.configDigest === row?.configDigest,
            );
          if (
            !server ||
            seen.has(server.id) ||
            !(row?.path === null || (typeof row?.path === 'string' && row.path.length <= 32760))
          )
            throw Error('mcp_metadata_invalid');
          seen.add(server.id);
        }
        for (const item of payload.items as { serverId: string; path: string | null }[])
          details[item.serverId] = { configurationPath: item.path };
      } catch {
        signal.throwIfAborted();
      }
      try {
        const payload = payloadOf(
          await client.queryExtension(
            sessionId,
            'builtin.mcp',
            'mcp.server.status',
            {},
            { signal },
          ),
          'builtin.mcp',
          'builtin.mcp.server.status',
        );
        if (payload.storeId !== storeId || payload.sessionId !== sessionId)
          throw Error('mcp_metadata_scope_mismatch');
        const seen = new Set<string>(),
          additions: typeof details = {};
        for (const item of payload.items as unknown[]) {
          const row = obj(item),
            server = facts.items.find(
              (server) => server.id === row?.serverId && server.configDigest === row?.configDigest,
            );
          if (!server) continue;
          if (
            !row ||
            seen.has(server.id) ||
            typeof row.executionId !== 'string' ||
            !['connecting', 'connected', 'failed', 'stopping', 'disconnected', 'unknown'].includes(
              String(row.status),
            ) ||
            !(
              row.reason === null ||
              (typeof row.reason === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(row.reason))
            ) ||
            ['toolCount', 'resourceCount', 'promptCount'].some(
              (key) =>
                row[key] !== null && (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0),
            )
          )
            throw Error('mcp_metadata_invalid');
          seen.add(server.id);
          additions[server.id] = {
            status: row.status as NonNullable<TuiMcpSnapshot['details']>[string]['status'],
            reason: row.reason as string | null,
            toolCount: row.toolCount as number | null,
            resourceCount: row.resourceCount as number | null,
            promptCount: row.promptCount as number | null,
          };
        }
        for (const [id, value] of Object.entries(additions))
          details[id] = { ...details[id], ...value };
      } catch {
        signal.throwIfAborted();
      }
      toolsAdmission(sessionId, signal);
      if (source) {
        try {
          const labels = decodeTuiMcpLabels(facts, await source.read(sessionId, signal));
          signal.throwIfAborted();
          return { ...facts, labels, details, ...(liveServerIds ? { liveServerIds } : {}) };
        } catch {
          // Optional labels cannot invalidate canonical controls or promote a mismatched source.
          signal.throwIfAborted();
        }
      }
      return { ...facts, details, ...(liveServerIds ? { liveServerIds } : {}) };
    },
    async list() {
      if (!journal) throw Error('mcp_selection_journal_unavailable');
      return journal
        .list()
        .map((row) => ({ intent: row.intent, phase: 'outcome_unknown' as const }));
    },
    async submit(raw) {
      const intent = parseMcpIntent(raw);
      try {
        const subjectId = currentSubject();
        if (!journal || !subjectId) throw Error('mcp_selection_journal_unavailable');
        const record = createMcpSelectionRecord(intent, subjectId);
        const existing = journal
          .list()
          .find((row) => row.intent.request.commandId === intent.request.commandId);
        if (existing) {
          if (mcpRecordIdentity(existing) !== mcpRecordIdentity(record))
            throw Error('mcp_selection_intent_conflict');
          return await this.lookup(intent, new AbortController().signal);
        }
        await scope(intent);
        const pending = journal
          .list()
          .filter(
            (row) =>
              ['submitting', 'pending', 'outcome_unknown'].includes(row.phase) &&
              row.intent.request.expectedStoreId === storeId,
          );
        if (
          pending.some(
            (row) =>
              row.intent.request.commandId !== intent.request.commandId &&
              (intent.request.input.scope === 'user' ||
                row.intent.request.input.scope === 'user' ||
                row.intent.workspaceId === intent.workspaceId),
          )
        )
          throw Error('mcp_original_outcome_required');
        if (!journal.prepare(record))
          return await this.lookup(intent, new AbortController().signal);
        if (currentSubject() !== record.subjectId) throw Error('mcp_selection_subject_changed');
        // Only the successful in-process preparation permits this first POST.
        const command = await client.invokeExtension(intent.sessionId, intent.request);
        original(intent, command);
        const result = await outcome(intent);
        journal.record(record, result.phase);
        return result;
      } catch {
        return { intent, phase: 'outcome_unknown' };
      }
    },
    async lookup(intent, signal) {
      try {
        const record = await stored(intent, signal);
        const result = await outcome(intent, signal);
        signal.throwIfAborted();
        journal!.record(record, result.phase);
        return result;
      } catch {
        return { intent, phase: 'outcome_unknown' };
      }
    },
  };
}

/** Cached directory only: exact original bindings and descriptor hashes, no remote request. */
export function decodeRetainedMcpDirectory(
  result: unknown,
  family: 'resources' | 'prompts',
  storeId: string,
  sessionId: string,
  workspaceId: string,
  options: { serverId?: string; afterKey?: string } = {},
): TuiMcpReadDirectory {
  const invalid = (): never => {
    throw Error('mcp_read_directory_invalid');
  };
  if (!Array.isArray(result) || result.length !== 1) return invalid();
  const display = obj(result[0]),
    payload = obj(display?.payload);
  if (
    display?.extensionId !== 'builtin.mcp' ||
    display.contentType !== `builtin.mcp.${family}` ||
    display.contentVersion !== 1 ||
    !Array.isArray(display.actions) ||
    display.actions.length ||
    !Array.isArray(display.artifactRefs) ||
    display.artifactRefs.length ||
    !payload ||
    !Array.isArray(payload.items) ||
    payload.items.length > 32
  )
    return invalid();
  const key = (value: unknown): value is string =>
    typeof value === 'string' && new RegExp(`^${family}/[A-Za-z0-9_-]{1,128}$`).test(value);
  if (payload.nextAfterKey !== null && !key(payload.nextAfterKey)) return invalid();
  const items: TuiMcpReadDirectory['items'][number][] = [];
  let previous = options.afterKey ?? '';
  for (const raw of payload.items) {
    const row = obj(raw),
      record = obj(row?.record),
      binding = obj(record?.binding);
    if (
      !row ||
      !key(row.key) ||
      row.key <= previous ||
      typeof row.live !== 'boolean' ||
      !record ||
      !['list', family === 'prompts' ? 'get' : 'read'].includes(String(record.kind)) ||
      !binding ||
      typeof binding.executionId !== 'string' ||
      row.key !== `${family}/${binding.executionId}` ||
      typeof binding.serverId !== 'string' ||
      !binding.serverId ||
      typeof binding.configDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(binding.configDigest) ||
      !Number.isSafeInteger(binding.generation) ||
      Number(binding.generation) < 1 ||
      typeof binding.connectionExecutionId !== 'string' ||
      !binding.connectionExecutionId ||
      typeof binding.connectionKey !== 'string' ||
      !binding.connectionKey ||
      typeof binding.definitionId !== 'string' ||
      !binding.definitionId.endsWith(
        `mcp.${family}.${record.kind === 'list' ? 'list' : family === 'prompts' ? 'get' : 'read'}`,
      ) ||
      binding.definitionVersion !== '1'
    )
      return invalid();
    previous = row.key;
    // Forks and historical foreign bindings remain unavailable, never become current prompts.
    if (binding.originalStoreId !== storeId || binding.sessionId !== sessionId) continue;
    if (options.serverId && binding.serverId !== options.serverId) return invalid();
    if (record.kind !== 'list') continue;
    if (
      !Array.isArray(record.descriptors) ||
      !Array.isArray(record.descriptorDigests) ||
      record.descriptors.length !== record.descriptorDigests.length ||
      record.descriptors.length > 10000
    )
      return invalid();
    const descriptorDigests = record.descriptorDigests;
    const descriptors = record.descriptors.map((raw, index) => {
      const descriptor = obj(raw);
      if (
        !descriptor ||
        typeof descriptor.name !== 'string' ||
        !descriptor.name ||
        descriptor.name.length > 4096 ||
        (family === 'resources' && (typeof descriptor.uri !== 'string' || !descriptor.uri)) ||
        descriptorDigests[index] !== digest(descriptor)
      )
        return invalid();
      return descriptor;
    });
    items.push({
      key: row.key,
      serverId: binding.serverId,
      configDigest: binding.configDigest,
      generation: Number(binding.generation),
      live: row.live,
      descriptors,
      descriptorDigests: descriptorDigests as string[],
    });
  }
  if (
    payload.nextAfterKey !== null &&
    (payload.nextAfterKey < previous || payload.nextAfterKey <= (options.afterKey ?? ''))
  )
    return invalid();
  return {
    family,
    sessionId,
    workspaceId,
    items,
    nextAfterKey: payload.nextAfterKey as string | null,
  };
}
