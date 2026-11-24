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
import { pdfPages, readPdfToolResult } from './documents/read-tool';
import { createWorkspaceFiles, type WorkspaceFiles } from './files';
import { createFileTools } from './files-tools';

type InputReadRequest = Pick<AuthorizationRequest, 'sessionId' | 'executionId' | 'signal'>;
const isPdf = (input: InputFileImport) =>
  input.reference.mediaType === 'application/pdf' || input.name.toLowerCase().endsWith('.pdf');

const pdfReadRecovery: Readonly<Record<string, string>> = {
  pdf_options_require_pdf: 'This file is not a PDF. Use optional offset and limit to read text.',
  pdf_requires_page_range: 'Use pages for this PDF. Omit offset and limit.',
};

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
      const params = input as Record<string, Json>;
      const requestsPdf =
        candidate.toLowerCase().endsWith('.pdf') ||
        params.pages !== undefined ||
        params.mode !== undefined;
      path = isAbsolute(candidate)
        ? candidate
        : options.workspaceRoot
          ? resolve(await options.workspaceRoot(request), candidate)
          : '';
      if (!path) {
        if (requestsPdf) throw new AgentError('input_file_scope_denied');
        return null;
      }
      const binding = await options.resolveWorking(request, pathToFileURL(path).href);
      request.signal.throwIfAborted();
      if (!binding) {
        if (requestsPdf) throw new AgentError('input_file_scope_denied');
        return null;
      }
      imported = binding.imported;
      // A normal editable text read must still observe the current working copy.
      if (!isPdf(imported) && params.pages === undefined && params.mode === undefined) return null;
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
      // The working path locates the binding; parsing a saved attachment still
      // reads and verifies its private immutable original, not the mutable copy.
      anchor = pathOf({ path: fileURLToPath(imported.uri) }) ?? '';
      if (!anchor) throw new AgentError('input_file_scope_denied');
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
    return { path, anchor, imported, revision };
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
              model: { name: 'read_file', ...tool.model, omitParameters: ['mode'] },
              description: `${tool.description} Use pages for an authorized PDF, including workspace files and saved attachments. Default is the first page; up to four pages per request. PDF results include page images and available text. Use offset and limit for ordinary text files.`,
              inputSchema: {
                ...tool.inputSchema,
                properties: {
                  ...(tool.inputSchema.properties as Record<string, Json>),
                  pages: pdfPages,
                  mode: { enum: ['text', 'image'] },
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
                  files = createWorkspaceFiles({
                    root: dirname(selected.anchor),
                    strictReads: true,
                  });
                  const anchored = files;
                  if (isPdf(selected.imported)) {
                    const params = input as Record<string, Json>;
                    if (params.offset !== undefined || params.limit !== undefined)
                      throw new AgentError('pdf_requires_page_range');
                    const original = await anchored.readBytes(basename(selected.anchor), {
                      maxBytes: 256 * 1024 * 1024,
                      signal: context.signal,
                    });
                    if (
                      original.baseline.hash !== selected.imported.reference.hash ||
                      String(original.baseline.size) !== selected.imported.reference.size
                    )
                      throw new AgentError('artifact_content_mismatch');
                    return await readPdfToolResult({
                      path: selected.path,
                      request: {
                        ...params,
                        ...(params.mode === undefined && !context.readDecisionToolResults
                          ? { mode: 'text' }
                          : {}),
                      },
                      context,
                      source: original,
                      cache: {
                        profilePath: options.profilePath,
                        storeId: selected.imported.originStoreId,
                      },
                      async verify() {
                        if ((await target(context, input))?.revision !== selected.revision)
                          throw new AgentError('file_dispatch_scope_changed');
                      },
                    });
                  }
                  if (
                    (input as Record<string, Json>).pages !== undefined ||
                    (input as Record<string, Json>).mode !== undefined
                  )
                    throw new AgentError('pdf_options_require_pdf');
                  const adapter = new Proxy(anchored, {
                    get(_source, key) {
                      if (key === 'relativePath')
                        return (path: string) => {
                          if (path !== selected.path)
                            throw new AgentError('file_dispatch_scope_changed');
                          return basename(selected.anchor);
                        };
                      if (key === 'read')
                        return async (
                          _path: string,
                          readOptions: Parameters<WorkspaceFiles['read']>[1],
                        ) => {
                          const value = await anchored.read(basename(selected.anchor), {
                            ...readOptions,
                            signal: context.signal,
                          });
                          if (
                            value.baseline.hash !== selected.imported.reference.hash ||
                            String(value.baseline.size) !== selected.imported.reference.size
                          )
                            throw new AgentError('artifact_content_mismatch');
                          const current = await target(context, input);
                          if (current?.revision !== selected.revision)
                            throw new AgentError('file_dispatch_scope_changed');
                          return { ...value, path: selected.path };
                        };
                      throw new AgentError('input_file_read_only');
                    },
                  });
                  return await createFileTools(adapter, { missingRead: 'error' })
                    .find((definition) => definition.id === 'files.read')!
                    .execute(input, context);
                } catch (error) {
                  const code = error instanceof AgentError ? error.code : 'file_target_unavailable';
                  const recovery = context.signal.aborted ? undefined : pdfReadRecovery[code];
                  return {
                    outcome: context.signal.aborted ? 'cancelled' : 'failed',
                    content: recovery ? `${code}: ${recovery}` : code,
                    ...(recovery ? { details: { code } } : {}),
                  };
                } finally {
                  await files?.close();
                }
              },
            },
    ),
  };
}
