import { AgentError, type StepCapabilitiesReader } from '@kite-ai/agent';
import type { NamedConfiguration } from '@kite-ai/agent/config';
import type { AuthorizationRequest, Json } from '@kite-ai/agent/extensions';
import {
  createMcpLifecycle,
  type McpLifecycleOptions,
  mcpSourceConnectionJobId,
} from '@kite-ai/agent/mcp';
import type { CapabilityDescription } from './permissions';

const key = (kind: string, id: string, version: string) => JSON.stringify([kind, id, version]);
/** Programmatic allowlist and lifecycle only; neither construction nor selection opens a transport. */
export function createMcpConfiguration(options?: McpLifecycleOptions) {
  const lifecycle = options ? createMcpLifecycle(options) : undefined;
  const tools = new Map((lifecycle?.extension.tools ?? []).map((tool) => [tool.id, tool]));
  const actionIds = new Set(
    (lifecycle?.extension.actions ?? []).map((action) => `${lifecycle!.extension.id}/${action.id}`),
  );
  const servers = new Map(
    (options?.servers ?? []).map((server) => {
      const job = lifecycle!.extension.jobs!.find(
        (job) => job.id === `mcp.connection.${server.id}`,
      )!;
      return [
        server.id,
        {
          configDigest: job.version,
          effect: server.transport.type === 'stdio' ? ('process' as const) : ('network' as const),
        },
      ];
    }),
  );
  function describe(request: AuthorizationRequest): CapabilityDescription | null {
    if (!lifecycle) return null;
    if (
      (request.kind === 'tool' &&
        tools.has(request.definitionId) &&
        request.definitionVersion === '1') ||
      (request.kind === 'job' &&
        actionIds.has(request.definitionId) &&
        request.definitionVersion === '1')
    ) {
      return {
        kind: request.kind,
        definitionId: request.definitionId,
        definitionVersion: request.definitionVersion,
        revision: 'builtin.mcp:1',
        effects: ['external'],
        hardAllowed: !!options?.transportPort || !!options?.scopedSources,
        safeRead: false,
      };
    }
    if (
      request.kind === 'job' &&
      request.definitionId === mcpSourceConnectionJobId &&
      request.definitionVersion === '1' &&
      options?.scopedSources
    )
      return {
        kind: 'job',
        definitionId: request.definitionId,
        definitionVersion: '1',
        revision: 'builtin.mcp.source:1',
        effects: ['unknown'],
        hardAllowed: true,
        safeRead: false,
      };
    if (request.kind === 'job')
      for (const [id, server] of servers) {
        if (
          request.definitionId === `mcp.connection.${id}` &&
          request.definitionVersion === server.configDigest
        )
          return {
            kind: request.kind,
            definitionId: request.definitionId,
            definitionVersion: request.definitionVersion,
            revision: server.configDigest,
            effects: [server.effect],
            hardAllowed: !!options?.transportPort,
            safeRead: false,
          };
      }
    return null;
  }
  function listCapabilities(): readonly CapabilityDescription[] {
    if (!lifecycle) return Object.freeze([]);
    return Object.freeze(
      [
        ...(lifecycle.extension.tools ?? []).map(
          (tool) =>
            describe({
              kind: 'tool',
              definitionId: tool.id,
              definitionVersion: tool.version,
            } as AuthorizationRequest)!,
        ),
        ...(lifecycle.extension.actions ?? []).map(
          (action) =>
            describe({
              kind: 'job',
              definitionId: `${lifecycle.extension.id}/${action.id}`,
              definitionVersion: action.version,
            } as AuthorizationRequest)!,
        ),
        ...(lifecycle.extension.jobs ?? []).map(
          (job) =>
            describe({
              kind: 'job',
              definitionId: job.id,
              definitionVersion: job.version,
            } as AuthorizationRequest)!,
        ),
      ]
        .filter(Boolean)
        .map((description) =>
          Object.freeze({ ...description, effects: Object.freeze([...description.effects]) }),
        ),
    );
  }
  function select(
    configurations: readonly NamedConfiguration[] = [],
    toolIds: readonly string[] = [],
    sourceServers: readonly { id: string; configDigest: string | null }[] = [],
  ) {
    const selected = new Map<string, { configDigest: string }>();
    for (const configuration of configurations) {
      if (
        Object.keys(configuration).some(
          (field) => !['id', 'enabled', 'configDigest', 'definitionVersion'].includes(field),
        )
      )
        throw new AgentError('mcp_configuration_not_host_selected');
      if (configuration.enabled === false) continue;
      const server = servers.get(configuration.id);
      if (!server) throw new AgentError('mcp_server_unavailable');
      if (
        (configuration.configDigest !== undefined &&
          configuration.configDigest !== server.configDigest) ||
        (configuration.definitionVersion !== undefined &&
          configuration.definitionVersion !== server.configDigest)
      )
        throw new AgentError('mcp_definition_version_unavailable');
      selected.set(configuration.id, server);
    }
    if (selected.size && !options?.transportPort) throw new AgentError('mcp_transport_unavailable');
    for (const source of sourceServers) {
      if (!options?.scopedSources || !source.configDigest || servers.has(source.id))
        throw new AgentError('mcp_source_selection_unavailable');
      selected.set(source.id, { configDigest: source.configDigest });
    }
    if (toolIds.some((id) => tools.has(id)) && !selected.size)
      throw new AgentError('mcp_selection_required');
    const snapshot = {
      servers: [...selected].map(([id, server]) => ({ id, configDigest: server.configDigest })),
    };
    const dynamic = new Map<string, CapabilityDescription>();
    const readStepCapabilities: StepCapabilitiesReader = async (input) => {
      const cached = lifecycle
        ? await lifecycle.readStepCapabilities(input)
        : { extensions: [], toolIds: [], snapshot: { mcp: [] } };
      const extensions = cached.extensions.filter((extension) =>
        selected.has(extension.id.slice('builtin.mcp.remote.'.length)),
      );
      dynamic.clear();
      for (const extension of extensions) {
        for (const [kind, definitions] of [
          ['tool', extension.tools ?? []],
          ['job', extension.jobs ?? []],
        ] as const)
          for (const definition of definitions)
            dynamic.set(
              key(kind, definition.id, definition.version),
              Object.freeze({
                kind,
                definitionId: definition.id,
                definitionVersion: definition.version,
                revision: `${extension.id}:${extension.version}:${definition.version}`,
                effects: Object.freeze(['unknown'] as const),
                hardAllowed: true,
                safeRead: false,
              }),
            );
      }
      const facts = cached.snapshot as { mcp: Json[] };
      return {
        extensions,
        toolIds: extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.id)),
        snapshot: {
          selected: snapshot.servers,
          cached: facts.mcp.filter((fact) => selected.has((fact as { serverId: string }).serverId)),
        },
      };
    };
    return {
      snapshot,
      listCapabilities(): readonly CapabilityDescription[] {
        return Object.freeze([
          ...listCapabilities().filter(
            (description) =>
              !description.definitionId.startsWith('mcp.connection.') ||
              selected.has(description.definitionId.slice('mcp.connection.'.length)),
          ),
          ...dynamic.values(),
        ]);
      },
      admissionError(request: AuthorizationRequest) {
        if (
          (request.kind === 'tool' && tools.has(request.definitionId)) ||
          (request.kind === 'job' &&
            (actionIds.has(request.definitionId) ||
              request.definitionId.startsWith('mcp.connection.') ||
              request.definitionId === mcpSourceConnectionJobId))
        ) {
          const input =
            request.input && typeof request.input === 'object' && !Array.isArray(request.input)
              ? request.input
              : {};
          if (typeof input.serverId !== 'string' || !selected.has(input.serverId))
            return 'mcp_server_not_selected';
          const reconnect =
            request.kind === 'job' &&
            ['mcp.reconnect', 'builtin.mcp/mcp.reconnect'].includes(request.definitionId) &&
            request.definitionVersion === '1';
          if (reconnect) {
            const replacement =
              input.replacement &&
              typeof input.replacement === 'object' &&
              !Array.isArray(input.replacement)
                ? input.replacement
                : {};
            const registered = servers.get(input.serverId);
            if (registered) {
              if (
                !options?.transportPort ||
                replacement.kind !== 'static' ||
                replacement.expectedConfigDigest !== registered.configDigest
              )
                return 'mcp_definition_version_unavailable';
            } else if (
              !options?.scopedSources?.resolveReplacement ||
              replacement.kind !== 'source' ||
              typeof replacement.expectedConfigDigest !== 'string' ||
              !/^[a-f0-9]{64}$/.test(replacement.expectedConfigDigest)
            )
              return 'mcp_source_selection_unavailable';
          }
          if (
            !reconnect &&
            request.definitionId !== 'mcp.connect' &&
            request.definitionId !== 'builtin.mcp/mcp.connect' &&
            request.definitionId !== mcpSourceConnectionJobId &&
            !request.definitionId.startsWith('mcp.connection.') &&
            input.configDigest !== selected.get(input.serverId)?.configDigest
          )
            return 'mcp_definition_version_unavailable';
        }
        if (
          (request.kind === 'tool' || request.kind === 'job') &&
          request.definitionId.startsWith('mcp.') &&
          !tools.has(request.definitionId) &&
          request.definitionId !== 'mcp.sources.list' &&
          request.definitionId !== mcpSourceConnectionJobId &&
          !request.definitionId.startsWith('mcp.connection.') &&
          !dynamic.has(key(request.kind, request.definitionId, request.definitionVersion))
        )
          return 'mcp_definition_not_selected';
        if (
          request.kind === 'job' &&
          dynamic.has(key(request.kind, request.definitionId, request.definitionVersion))
        ) {
          const input =
            request.input && typeof request.input === 'object' && !Array.isArray(request.input)
              ? request.input
              : {};
          const binding =
            input.binding && typeof input.binding === 'object' && !Array.isArray(input.binding)
              ? input.binding
              : {};
          const server =
            typeof binding.serverId === 'string' ? selected.get(binding.serverId) : undefined;
          if (!server || binding.configDigest !== server.configDigest)
            return 'mcp_server_not_selected';
        }
        return null;
      },
      readStepCapabilities,
      describe: (request: AuthorizationRequest) =>
        describe(request) ??
        dynamic.get(key(request.kind, request.definitionId, request.definitionVersion)) ??
        null,
    };
  }
  return { extension: lifecycle?.extension, tools, describe, select, listCapabilities };
}
