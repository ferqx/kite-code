import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { createWorkspaceFiles } from '@kite-ai/agent/files';
import { presentedFileRead } from '../../../packages/agent/test/fixtures/presented-file-read';

export interface OriginalToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export interface OriginalToolWorkspace {
  workspace: string;
  home: string;
}
/** Pure naming table. Execution and all results remain the real Service/Agent's responsibility. */
export const originalToolNames: Readonly<Record<string, string>> = {
  read_file: 'files.read',
  write_file: 'files.write',
  edit_file: 'files.edit',
  shell_execute: 'shell.execute',
  shell: 'shell.execute',
  tool_search: 'mcp.tools.search',
  list_mcp_resources: 'mcp.resources.list',
  read_mcp_resource: 'mcp.resources.read',
  read_plan: 'planning.read',
  write_plan: 'planning.write',
};
export function originalToolName(name: string): string {
  return originalToolNames[name] ?? name;
}
function workspacePath(path: string, scope: OriginalToolWorkspace): string {
  const absolute = ownedPath(path, scope);
  const inside = relative(resolve(scope.workspace), absolute);
  return !isAbsolute(inside) &&
    inside !== '..' &&
    !inside.startsWith('../') &&
    !inside.startsWith('..\\')
    ? inside.replaceAll('\\', '/') || '.'
    : path;
}
function keys(args: Record<string, unknown>, allowed: readonly string[], name: string) {
  const extra = Object.keys(args).filter((key) => !allowed.includes(key));
  if (extra.length) throw Error(`original_tool_contract_unmapped:${name}:${extra.join(',')}`);
}
function text(args: Record<string, unknown>, key: string) {
  if (typeof args[key] !== 'string') throw Error(`original_tool_contract_invalid:${key}`);
  return args[key] as string;
}
function ownedPath(path: string, scope: OriginalToolWorkspace) {
  const absolute = resolve(scope.workspace, path);
  if (
    ![scope.workspace, scope.home].some((root) => {
      const remainder = relative(resolve(root), absolute);
      return (
        !isAbsolute(remainder) &&
        remainder !== '..' &&
        !remainder.startsWith('../') &&
        !remainder.startsWith('..\\')
      );
    })
  )
    throw Error('original_tool_baseline_outside_fixture');
  return absolute;
}
function mcpConnectionFacts(request: Parameters<typeof migrateOriginalToolCall>[2]) {
  const rows: Array<Record<string, unknown>> = [];
  for (const message of request?.messages ?? []) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    let value: unknown;
    try {
      value = JSON.parse(message.content);
    } catch {
      continue;
    }
    if (
      !value ||
      typeof value !== 'object' ||
      !('source' in value) ||
      value.source !== 'mcp_selected_connection_refs' ||
      !('connections' in value) ||
      !Array.isArray(value.connections)
    )
      continue;
    for (const connection of value.connections)
      if (
        connection &&
        typeof connection === 'object' &&
        typeof connection.serverId === 'string' &&
        typeof connection.serverName === 'string' &&
        typeof connection.connectionKey === 'string' &&
        typeof connection.configDigest === 'string' &&
        typeof connection.generation === 'number'
      )
        rows.push(connection);
  }
  return rows;
}
/** Capture the current test-owned file; this prepares input, never performs a Tool mutation. */
async function currentBaseline(path: string, scope: OriginalToolWorkspace) {
  const absolute = ownedPath(path, scope);
  try {
    ownedPath(await realpath(absolute), scope);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      ownedPath(await realpath(dirname(absolute)), scope);
      return null;
    }
    throw error;
  }
  const remainder = relative(resolve(scope.workspace), absolute);
  const root =
    !isAbsolute(remainder) &&
    remainder !== '..' &&
    !remainder.startsWith('../') &&
    !remainder.startsWith('..\\')
      ? scope.workspace
      : scope.home;
  const files = createWorkspaceFiles({ root });
  try {
    // Use the same native identity and full EOF/hash validation as the real
    // consumer, including the complete Windows volume and file ID.
    return (
      await files.readBytes(relative(resolve(root), absolute).replaceAll('\\', '/'), {
        maxBytes: Number.MAX_SAFE_INTEGER,
      })
    ).baseline;
  } finally {
    await files.close();
  }
}
/** Use only the exact file reference returned in this model request's history. */
function observedBaseRef(path: string, messages: Array<{ role?: string; content?: unknown }>) {
  for (const message of messages.toReversed()) {
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    const formatted = presentedFileRead(message.content);
    if (formatted?.path === path) return formatted.baseRef;
    try {
      const value = JSON.parse(message.content);
      if (value?.path === path && typeof value.base_ref === 'string') return value.base_ref;
    } catch {
      // Other finite tool results need not use JSON.
    }
  }
  return undefined;
}

/** Explicit fixture-language migration. Unsupported semantics fail before emitting a response. */
export async function migrateOriginalToolCall(
  call: OriginalToolCall,
  scope: OriginalToolWorkspace,
  request?: {
    body: Record<string, unknown>;
    messages: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
  },
): Promise<OriginalToolCall> {
  const a = call.args;
  let name = originalToolName(call.name),
    args: Record<string, unknown> = { ...a };
  switch (call.name) {
    case 'read_file':
      keys(a, ['path', 'offset', 'limit'], call.name);
      args = { ...a, path: workspacePath(text(a, 'path'), scope) };
      break;
    case 'tool_search':
      keys(a, ['query', 'limit'], call.name);
      args = { query: text(a, 'query'), ...(a.limit === undefined ? {} : { limit: a.limit }) };
      break;
    case 'list_mcp_resources':
    case 'read_mcp_resource': {
      keys(a, call.name === 'list_mcp_resources' ? ['server'] : ['server', 'uri'], call.name);
      const connections = mcpConnectionFacts(request).filter(
        (row) => row.serverName === text(a, 'server'),
      );
      if (connections.length !== 1) throw Error('original_mcp_resource_connection_unavailable');
      const source = connections[0]!;
      args = {
        serverId: source.serverId,
        connectionKey: source.connectionKey,
        configDigest: source.configDigest,
        generation: source.generation,
      };
      if (call.name === 'read_mcp_resource') {
        const catalogues: Array<Record<string, unknown>> = [];
        for (const message of request?.messages ?? []) {
          if (message.role !== 'tool' || typeof message.content !== 'string') continue;
          let value: Record<string, unknown>;
          try {
            value = JSON.parse(message.content);
          } catch {
            continue;
          }
          const binding = value.binding as Record<string, unknown> | undefined;
          if (
            value.source === 'external_mcp_data' &&
            (binding?.definitionId === 'mcp.resources.list' ||
              binding?.definitionId === 'builtin.mcp/mcp.resources.list') &&
            binding?.serverId === source.serverId &&
            binding.configDigest === source.configDigest &&
            binding.generation === source.generation &&
            typeof binding.executionId === 'string' &&
            Array.isArray(value.descriptors)
          )
            catalogues.push(value);
        }
        const catalogue = catalogues.at(-1),
          binding = catalogue?.binding as Record<string, unknown> | undefined;
        const descriptors = catalogue?.descriptors as
          | Array<{ descriptor: { uri?: string }; descriptorDigest: string }>
          | undefined;
        const target = descriptors?.find((item) => item.descriptor.uri === text(a, 'uri'));
        // A deliberate missing-URI fixture carries a real catalogue digest; the
        // original Tool must reject the mismatched target before issuing an RPC.
        const digest = target?.descriptorDigest ?? descriptors?.[0]?.descriptorDigest;
        if (!binding || typeof digest !== 'string')
          throw Error('original_mcp_resource_catalogue_unavailable');
        args = {
          ...args,
          uri: text(a, 'uri'),
          catalogueExecutionId: binding.executionId,
          descriptorDigest: digest,
        };
      }
      break;
    }
    case 'glob':
    case 'search_files':
    case 'grep':
    case 'search_content':
      throw Error('retired_file_search_requires_shell_migration');
    case 'write_file':
      keys(a, ['path', 'content'], call.name);
      {
        const path = workspacePath(text(a, 'path'), scope);
        if (isAbsolute(path)) throw Error('external_write_requires_shell');
        const baseRef = request && observedBaseRef(path, request.messages);
        const base = baseRef ? undefined : await currentBaseline(path, scope);
        if (request && base && !baseRef)
          throw Error('original_tool_write_requires_observed_baseline');
        args = {
          path,
          content: text(a, 'content'),
          ...(baseRef ? { baseRef } : request ? {} : { base }),
        };
      }
      break;
    case 'edit_file': {
      keys(a, ['path', 'old_string', 'new_string', 'replace_all'], call.name);
      const path = workspacePath(text(a, 'path'), scope),
        find = text(a, 'old_string'),
        replace = text(a, 'new_string');
      if (!find) throw Error('original_tool_edit_empty_find');
      if (isAbsolute(path)) throw Error('external_write_requires_shell');
      const baseRef = request && observedBaseRef(path, request.messages);
      const base = request ? undefined : await currentBaseline(path, scope);
      if (!baseRef && !base) throw Error('original_tool_edit_baseline_missing');
      if (a.replace_all === true)
        throw Error('original_tool_edit_replace_all_requires_scenario_migration');
      args = { path, find, replace, occurrences: 1, ...(baseRef ? { baseRef } : { base }) };
      break;
    }
    case 'shell_execute':
    case 'shell':
      keys(a, ['command', 'timeout'], call.name);
      if (a.timeout !== undefined)
        throw Error('original_tool_shell_timeout_requires_scenario_migration');
      args = {
        command: text(a, 'command'),
      };
      break;
    case 'read_plan':
      keys(a, [], call.name);
      args = {};
      break;
    case 'write_plan':
      if (a.action === 'submit') {
        keys(a, ['action', 'plan_id', 'version', 'structural_digest'], call.name);
        name = 'planning.review';
        args = {
          planId: text(a, 'plan_id'),
          version: a.version,
          digest: text(a, 'structural_digest'),
        };
      } else {
        keys(a, ['title', 'body_markdown', 'steps', 'action', 'plan_id', 'version'], call.name);
        if (a.action !== undefined && a.action !== 'save')
          throw Error('original_tool_plan_action_requires_scenario_migration');
        args = {
          planId: a.plan_id ?? `fixture-${createHash('sha256').update(call.id).digest('hex')}`,
          expectedVersion: a.version ?? null,
          title: text(a, 'title'),
          body: text(a, 'body_markdown'),
          steps: a.steps,
        };
      }
      break;
    default: {
      if (!call.name.startsWith('mcp__')) break;
      const match = /^mcp__([^_]+)__(.+)$/.exec(call.name);
      if (!match || !request) throw Error('original_mcp_tool_source_unavailable');
      const rows: Array<Record<string, unknown>> = [];
      for (const message of request.messages) {
        if (message.role !== 'tool' || typeof message.content !== 'string') continue;
        let value: unknown;
        try {
          value = JSON.parse(message.content);
        } catch {
          continue;
        }
        if (
          !value ||
          typeof value !== 'object' ||
          !('source' in value) ||
          value.source !== 'frozen_selected_mcp_catalogue' ||
          !('items' in value) ||
          !Array.isArray(value.items)
        )
          continue;
        for (const row of value.items) {
          if (
            !row ||
            typeof row !== 'object' ||
            row.serverName !== match[1] ||
            typeof row.serverId !== 'string'
          )
            continue;
          const exact = `mcp.${row.serverId}.${createHash('sha256').update(JSON.stringify(match[2])).digest('hex').slice(0, 32)}`;
          if (
            row.definitionId !== exact ||
            typeof row.definitionVersion !== 'string' ||
            !row.inputSchema
          )
            continue;
          rows.push(row);
        }
      }
      const declared = Array.isArray(request.body.tools) ? request.body.tools : [];
      const isDeclared = (id: string) => {
        const names = declared.flatMap((tool) =>
          tool && typeof tool === 'object' && typeof tool.function?.name === 'string'
            ? [tool.function.name as string]
            : [],
        );
        const modelNames = rows
          .filter((row) => row.definitionId === id && typeof row.modelName === 'string')
          .map((row) => String(row.modelName));
        if (
          modelNames.length &&
          new Set(modelNames).size === 1 &&
          names.filter((name) => name === modelNames[0]).length === 1
        )
          return true;
        if (names.includes(id)) return true;
        const wire = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        // The SDK encodes long internal IDs. Only accept an unambiguous
        // declared wire candidate; Core and the remote fixture still check
        // the complete original definition and exact call arguments.
        const sameWireBase = (name: string) => {
          if (name === wire) return true;
          const suffix = /_[1-9][0-9]*$/.exec(name)?.[0];
          return !!suffix && name === `${wire.slice(0, 64 - suffix.length)}${suffix}`;
        };
        return names.includes(wire) && names.filter(sameWireBase).length === 1;
      };
      for (const source of mcpConnectionFacts(request).filter(
        (row) => row.serverName === match[1],
      )) {
        const exact = `mcp.${source.serverId}.${createHash('sha256').update(JSON.stringify(match[2])).digest('hex').slice(0, 32)}`;
        if (isDeclared(exact)) rows.push({ definitionId: exact });
      }
      const matches = rows.filter((row) => isDeclared(String(row.definitionId)));
      const ids = [...new Set(matches.map((row) => String(row.definitionId)))];
      if (ids.length !== 1) throw Error('original_mcp_tool_source_unavailable');
      name = ids[0]!;
      break;
    }
  }
  return { id: call.id, name, args };
}
