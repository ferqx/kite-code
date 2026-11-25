import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AuthorizationRequest, ToolContext, ToolDefinition } from '../extensions';
import type { WorkingInputAttachment } from '../input-working-files';
import { canonicalJson } from '../json';
import type { CapabilityDescription } from '../permissions';
import { dispatchScopeLeaves } from '../permissions/dispatch-scope';
import type { InputFileImport } from '../storage/input-file-imports';
import { AgentError, type Json } from '../storage/types';
import { createWorkspaceFiles, type WorkspaceFiles } from './files';
import { isEngineeringTextPath, unsupportedFileRead } from './files/read-scope';
import { createFileReadResult } from './files-tools';

type InputReadRequest = Pick<AuthorizationRequest, 'sessionId' | 'executionId' | 'signal'>;
const documentExtensions: Readonly<Record<string, string>> = {
  'application/pdf': '.pdf',
  'text/csv': '.csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
function inputName(input: InputFileImport) {
  const extension = documentExtensions[input.reference.mediaType];
  return extension ? `attachment${extension}` : input.name;
}

/** Trusted exact-target adapter. It grants no directory capability to ordinary file tools. */
export function withInputFileReads(options: {
  profilePath: string;
  tools: readonly ToolDefinition[];
  resolve(request: InputReadRequest, uri: string): Promise<InputFileImport | null>;
  resolveWorking?(request: InputReadRequest, uri: string): Promise<WorkingInputAttachment | null>;
  workspaceRoot?(request: InputReadRequest): Promise<string>;
}) {
  const root = resolve(options.profilePath);
  const normalized = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
  function pathOf(input: Json): string | null {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      typeof input.path !== 'string'
    )
      return null;
    const path = input.path;
    if (!isAbsolute(path)) return null;
    const candidate = normalized(resolve(path)),
      profile = normalized(root);
    if (candidate !== profile && !candidate.startsWith(`${profile}${sep}`)) return null;
    if (resolve(path) !== path || path.includes('\0')) throw new AgentError('file_path_invalid');
    return path;
  }
  function workingPath(input: Json): string | null {
    const path = (input as { path?: unknown } | null)?.path;
    if (typeof path !== 'string' || path.includes('\0')) return null;
    const normalizedPath = normalize(path);
    const parts = normalizedPath.split(sep);
    if (
      parts.at(-3)?.toLowerCase() !== '.kite-inputs' ||
      !/^[0-9a-f]{64}$/i.test(parts.at(-2) ?? '')
    )
      return null;
    if (normalizedPath !== path) throw new AgentError('file_path_invalid');
    return path;
  }
  async function target(request: InputReadRequest, input: Json) {
    const direct = pathOf(input);
    let path: string, anchor: string, imported: InputFileImport, alias: Json | undefined;
    if (direct) {
      path = anchor = direct;
      const uri = pathToFileURL(path).href;
      const value = await options.resolve(request, uri);
      request.signal.throwIfAborted();
      if (value?.state !== 'bound' || value.uri !== uri)
        throw new AgentError('input_file_scope_denied');
      imported = value;
    } else {
      const candidate = workingPath(input);
      if (!candidate || !options.resolveWorking) return null;
      const engineeringPath = isEngineeringTextPath(candidate);
      path = isAbsolute(candidate)
        ? candidate
        : options.workspaceRoot
          ? resolve(await options.workspaceRoot(request), candidate)
          : '';
      if (!path) {
        if (!engineeringPath) throw new AgentError('input_file_scope_denied');
        return null;
      }
      const binding = await options.resolveWorking(request, pathToFileURL(path).href);
      request.signal.throwIfAborted();
      if (!binding) {
        if (!engineeringPath) throw new AgentError('input_file_scope_denied');
        return null;
      }
      imported = binding.imported;
      // A normal editable text read must still observe the current working copy.
      if (engineeringPath && isEngineeringTextPath(inputName(imported))) return null;
      const working = binding.working;
      const files = createWorkspaceFiles({
        root: fileURLToPath(working.workspaceRootUri),
        strictReads: true,
      });
      try {
        const rootIdentity = await files.inspectRootIdentity?.();
        const { file } = await files.inspectIdentity(working.workingRelativePath);
        request.signal.throwIfAborted();
        if (
          !file ||
          rootIdentity?.device !== working.rootIdentity.device ||
          rootIdentity.inode !== working.rootIdentity.inode
        )
          throw new AgentError('input_file_scope_denied');
        alias = {
          contextSelectionId: binding.contextSelectionId,
          working,
          file,
        } as unknown as Json;
      } finally {
        await files.close();
      }
      anchor = path;
    }
    const revision = `input-file:1:${createHash('sha256')
      .update(
        canonicalJson({
          sessionId: request.sessionId,
          input,
          importId: imported.id,
          reference: imported.reference,
          uri: imported.uri,
          ...(alias === undefined ? {} : { alias }),
        } as unknown as Json),
      )
      .digest('hex')}`;
    return { path, anchor, imported, revision, savedAttachment: direct !== null };
  }
  function verify(context: ToolContext, revision: string) {
    if (!context.dispatchAuthorization?.revision)
      throw new AgentError('file_dispatch_scope_unavailable');
    for (const leaf of dispatchScopeLeaves(
      context.dispatchAuthorization.snapshot,
      'file_dispatch_scope_unavailable',
    )) {
      const capability = leaf.data.capability;
      if (
        leaf.namespace !== 'builtin.permissions' ||
        !capability ||
        typeof capability !== 'object' ||
        Array.isArray(capability) ||
        capability.kind !== 'tool' ||
        capability.definitionId !== 'files.read' ||
        capability.definitionVersion !== '5' ||
        capability.hardAllowed !== true ||
        capability.revision !== revision
      )
        throw new AgentError('file_dispatch_scope_changed');
    }
  }
  return {
    async describeRequest(request: AuthorizationRequest): Promise<CapabilityDescription | null> {
      if (
        request.kind !== 'tool' ||
        !['files.read', 'files.write', 'files.edit'].includes(request.definitionId)
      )
        return null;
      const identity = {
        kind: request.kind,
        definitionId: request.definitionId,
        definitionVersion: request.definitionVersion,
      };
      try {
        if (request.definitionId !== 'files.read' || request.definitionVersion !== '5') {
          if (!pathOf(request.input)) return null;
          throw new AgentError('input_file_read_only');
        }
        const resolved = await target(request, request.input);
        if (!resolved) return null;
        return {
          ...identity,
          hardAllowed: true,
          safeRead: true,
          effects: ['read'],
          revision: resolved.revision,
        };
      } catch (error) {
        request.signal.throwIfAborted();
        return {
          ...identity,
          hardAllowed: false,
          safeRead: false,
          effects: ['read'],
          revision: 'input-file:unavailable',
          denialReason: error instanceof AgentError ? error.code : 'file_target_unavailable',
        };
      }
    },
    tools: options.tools.map(
      (tool): ToolDefinition =>
        tool.id !== 'files.read'
          ? tool
          : {
              ...tool,
              version: '5',
              model: { name: 'read_file', ...tool.model },
              description: `${tool.description} For an attached document, pass its prepared workspace copy to the relevant Shell helper.`,
              inputSchema: {
                ...tool.inputSchema,
                properties: {
                  ...(tool.inputSchema.properties as Record<string, Json>),
                  path: {
                    type: 'string',
                    maxLength: 4096,
                    description:
                      'Workspace-relative or ordinary external absolute file path, or an exact saved attachment path provided in this conversation. Other private paths are denied.',
                  },
                },
              },
              async execute(input, context) {
                let files: WorkspaceFiles | undefined;
                try {
                  const selected = await target(context, input);
                  if (!selected) return await tool.execute(input, context);
                  verify(context, selected.revision);
                  const name = inputName(selected.imported);
                  if (!selected.savedAttachment || !isEngineeringTextPath(name))
                    throw unsupportedFileRead(selected.path, {
                      name,
                      savedAttachment: selected.savedAttachment,
                    });
                  files = createWorkspaceFiles({
                    root: dirname(selected.anchor),
                    strictReads: true,
                  });
                  const params = input as Record<string, Json>;
                  const value = await files.read(basename(selected.anchor), {
                    offset: params.offset === undefined ? 1 : Number(params.offset),
                    limit: params.limit === undefined ? 200 : Number(params.limit),
                    signal: context.signal,
                  });
                  if (
                    value.baseline.hash !== selected.imported.reference.hash ||
                    String(value.baseline.size) !== selected.imported.reference.size
                  )
                    throw new AgentError('artifact_content_mismatch');
                  if ((await target(context, input))?.revision !== selected.revision)
                    throw new AgentError('file_dispatch_scope_changed');
                  context.signal.throwIfAborted();
                  return await createFileReadResult({ ...value, path: selected.path }, context);
                } catch (error) {
                  const code = error instanceof AgentError ? error.code : 'file_target_unavailable';
                  return {
                    outcome: context.signal.aborted ? 'cancelled' : 'failed',
                    content:
                      code === 'unsupported_file_type' && error instanceof Error
                        ? error.message
                        : code,
                    details: { code },
                  };
                } finally {
                  await files?.close();
                }
              },
            },
    ),
  };
}
