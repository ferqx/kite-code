import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AuthorizationRequest, ToolContext, ToolDefinition } from '../extensions';
import { canonicalJson } from '../json';
import type { CapabilityDescription } from '../permissions';
import { dispatchScopeLeaves } from '../permissions/dispatch-scope';
import type { InputFileImport } from '../storage/input-file-imports';
import { AgentError, type Json } from '../storage/types';
import { pdfRecipe, readCachedPdf } from './documents/pdf';
import { createWorkspaceFiles, type WorkspaceFiles } from './files';
import { createFileTools } from './files-tools';

/** Trusted exact-target adapter. It grants no directory capability to ordinary file tools. */
export function withInputFileReads(options: {
  profilePath: string;
  tools: readonly ToolDefinition[];
  resolve(
    request: Pick<AuthorizationRequest, 'sessionId' | 'executionId' | 'signal'>,
    uri: string,
  ): Promise<InputFileImport | null>;
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
  async function target(
    request: Pick<AuthorizationRequest, 'sessionId' | 'executionId' | 'signal'>,
    input: Json,
  ) {
    const path = pathOf(input);
    if (!path) return null;
    const imported = await options.resolve(request, pathToFileURL(path).href);
    request.signal.throwIfAborted();
    if (imported?.state !== 'bound' || imported.uri !== pathToFileURL(path).href)
      throw new AgentError('input_file_scope_denied');
    const revision = `input-file:1:${createHash('sha256')
      .update(
        canonicalJson({
          sessionId: request.sessionId,
          input,
          importId: imported.id,
          reference: imported.reference,
          uri: imported.uri,
        } as unknown as Json),
      )
      .digest('hex')}`;
    return { path, imported, revision };
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
        if (!pathOf(request.input)) return null;
        if (request.definitionId !== 'files.read' || request.definitionVersion !== '5')
          throw new AgentError('input_file_read_only');
        const resolved = await target(request, request.input);
        if (!resolved) throw new AgentError('input_file_scope_denied');
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
              description: `${tool.description} Saved attachments are immutable. For PDF attachments, use pages="1-3" and mode="text" or "image"; default is physical page 1 as text. Up to 20 text pages or 4 images per call. Empty extracted text does not mean the page is blank.`,
              inputSchema: {
                ...tool.inputSchema,
                properties: {
                  ...(tool.inputSchema.properties as Record<string, Json>),
                  pages: { type: 'string', pattern: '^[1-9][0-9]*(-[1-9][0-9]*)?$', maxLength: 32 },
                  mode: { enum: ['text', 'image'] },
                  path: {
                    type: 'string',
                    maxLength: 4096,
                    description:
                      'Workspace path, or exact saved attachment path provided in this conversation. Other private paths are denied.',
                  },
                },
              },
              async execute(input, context) {
                let files: WorkspaceFiles | undefined;
                try {
                  const selected = await target(context, input);
                  if (!selected) {
                    const request = input as { pages?: string; mode?: string };
                    if (request.pages !== undefined || request.mode !== undefined)
                      throw new AgentError('pdf_options_require_saved_attachment');
                    return tool.execute(input, context);
                  }
                  verify(context, selected.revision);
                  files = createWorkspaceFiles({ root: dirname(selected.path), strictReads: true });
                  const anchored = files;
                  if (
                    selected.imported.reference.mediaType === 'application/pdf' ||
                    selected.imported.name.toLowerCase().endsWith('.pdf')
                  ) {
                    const params = input as Record<string, Json>;
                    if (params.offset !== undefined || params.limit !== undefined)
                      throw new AgentError('pdf_requires_page_range');
                    const original = await anchored.readBytes(basename(selected.path), {
                      maxBytes: 256 * 1024 * 1024,
                    });
                    if (
                      original.baseline.hash !== selected.imported.reference.hash ||
                      String(original.baseline.size) !== selected.imported.reference.size
                    )
                      throw new AgentError('artifact_content_mismatch');
                    const parsed = await readCachedPdf(
                      original.bytes,
                      {
                        pages: params.pages as string | undefined,
                        mode: params.mode as string | undefined,
                      },
                      {
                        profilePath: options.profilePath,
                        storeId: selected.imported.originStoreId,
                        sourceHash: original.baseline.hash,
                      },
                      context.signal,
                    );
                    if ((await target(context, input))?.revision !== selected.revision)
                      throw new AgentError('file_dispatch_scope_changed');
                    if (!context.artifacts)
                      throw new AgentError('artifact_publication_unavailable');
                    const modelImages = [];
                    for (const page of parsed.pages)
                      if (page.image)
                        modelImages.push(
                          await context.artifacts.publish({
                            key: `pdf-page-${page.number}`,
                            content: page.image,
                            mediaType: 'image/png',
                          }),
                        );
                    const content = JSON.stringify({
                      path: selected.path,
                      sourceHash: original.baseline.hash,
                      recipe: pdfRecipe,
                      totalPages: parsed.totalPages,
                      nextPage: parsed.nextPage,
                      mode: params.mode ?? 'text',
                      pages: parsed.pages.map((page) => ({
                        number: page.number,
                        label: page.label,
                        text: page.text,
                        extraction: page.image
                          ? 'page_image'
                          : page.text.length
                            ? 'text_extracted_reading_order_not_guaranteed'
                            : 'no_extractable_text',
                      })),
                    });
                    const reference = await context.artifacts.publish({
                      key: 'pdf-read-result',
                      content: Buffer.from(content),
                      mediaType: 'application/json',
                    });
                    return {
                      outcome: 'succeeded',
                      content:
                        content.length < 65536
                          ? content
                          : JSON.stringify({
                              path: selected.path,
                              totalPages: parsed.totalPages,
                              nextPage: parsed.nextPage,
                              pages: parsed.pages.map((page) => page.number),
                            }),
                      artifactRefs: [reference, ...modelImages],
                      modelContent: { kind: 'artifact', reference, encoding: 'utf-8' },
                      ...(modelImages.length ? { modelImages } : {}),
                    };
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
                          return basename(selected.path);
                        };
                      if (key === 'read')
                        return async (
                          _path: string,
                          readOptions: Parameters<WorkspaceFiles['read']>[1],
                        ) => {
                          const value = await anchored.read(basename(selected.path), {
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
                  return await createFileTools(adapter)
                    .find((definition) => definition.id === 'files.read')!
                    .execute(input, context);
                } catch (error) {
                  return {
                    outcome: context.signal.aborted ? 'cancelled' : 'failed',
                    content: error instanceof AgentError ? error.code : 'file_target_unavailable',
                  };
                } finally {
                  await files?.close();
                }
              },
            },
    ),
  };
}
