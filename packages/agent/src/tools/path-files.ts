import { isAbsolute, resolve } from 'node:path';
import type { AuthorizationRequest, ToolDefinition, ToolResult } from '../extensions';
import {
  describePathFileRequest,
  inspectPathFileTarget,
  type PathFileBoundary,
  verifyPathFileDispatch,
} from '../permissions/files-request';
import { AgentError, type Json } from '../storage/types';
import { createWorkspaceFiles, type FileSnapshot, type WorkspaceFiles } from './files';
import { createFileTools } from './files-tools';

/** Absolute user-file tools reuse the one native anchored text/CAS engine.
 * They intentionally do not participate in workspace checkpoint capture/restore. */
export function createPathFileTools(boundaryInput: PathFileBoundary) {
  const validated = structuredClone(boundaryInput);
  if (
    !Array.isArray(validated.qualifiedPlatforms) ||
    validated.qualifiedPlatforms.some(
      (platform) => !['darwin', 'linux', 'win32'].includes(platform),
    ) ||
    !Array.isArray(validated.protectedRoots) ||
    validated.protectedRoots.some(
      (root) =>
        typeof root !== 'string' ||
        !isAbsolute(root) ||
        resolve(root) !== root ||
        root.includes('\0'),
    )
  )
    throw new AgentError('file_boundary_invalid');
  // Protection is a set: preserve every validated root while sealing one stable identity.
  const boundary = Object.freeze({
    ...validated,
    qualifiedPlatforms: Object.freeze(validated.qualifiedPlatforms),
    protectedRoots: Object.freeze([...new Set(validated.protectedRoots)].sort()),
  });
  // Use the existing closed schemas, Artifact handling and publication outcome contract.
  const unavailable = new Proxy({} as WorkspaceFiles, {
    get() {
      throw new AgentError('file_target_unavailable');
    },
  });
  const templates = createFileTools(unavailable).filter((tool) =>
    ['files.read', 'files.write', 'files.edit'].includes(tool.id),
  );
  const tools: ToolDefinition[] = templates.map((template) => ({
    ...template,
    id: `${template.id}_path`,
    version: template.id === 'files.read' ? '2' : '1',
    description: `Absolute user-file ${template.id.slice(6)}; exact target permission, UTF-8 and complete bodies/Artifacts; modifications require exact baseline. External files are outside workspace checkpoints.${template.id === 'files.read' ? ' Read up to 200 lines by default; continue at selection.nextOffset or specify offset/limit. The baseline describes the complete file.' : ''}`,
    inputSchema: {
      ...template.inputSchema,
      properties: {
        ...(template.inputSchema.properties as Record<string, Json>),
        path: {
          type: 'string',
          maxLength: 4096,
          description: 'Canonical absolute user-file path; exact target permission is required.',
        },
      },
    },
    ...(template.id !== 'files.read'
      ? { resources: { serial: { scope: 'runtime' as const, key: 'files.path.mutation' } } }
      : {}),
    async execute(input, context): Promise<ToolResult> {
      let files: WorkspaceFiles | undefined;
      try {
        context.signal.throwIfAborted();
        const target = await inspectPathFileTarget(`${template.id}_path`, input, boundary);
        verifyPathFileDispatch(context, `${template.id}_path`, target.revision);
        context.signal.throwIfAborted();
        files = createWorkspaceFiles({ root: target.root, strictReads: true });
        const anchored = await inspectPathFileTarget(`${template.id}_path`, input, boundary, files);
        if (anchored.revision !== target.revision)
          throw new AgentError('file_dispatch_scope_changed');
        const absolute = (snapshot: FileSnapshot): FileSnapshot => ({
          ...snapshot,
          path: target.path,
          ...(snapshot.change ? { change: { ...snapshot.change, path: target.path } } : {}),
        });
        const selected = files;
        const adapter = new Proxy(selected, {
          get(source, key) {
            if (key === 'read')
              return async (_path: string, options: Parameters<WorkspaceFiles['read']>[1]) => {
                const read = await selected.read(target.name, options);
                if (
                  !target.identity ||
                  read.baseline.device !== target.identity.device ||
                  read.baseline.inode !== target.identity.inode
                )
                  throw new AgentError('file_dispatch_scope_changed');
                return absolute(read);
              };
            if (key === 'write')
              return async (value: Parameters<WorkspaceFiles['write']>[0]) =>
                absolute(await selected.write({ ...value, path: target.name }));
            if (key === 'edit')
              return async (value: Parameters<WorkspaceFiles['edit']>[0]) =>
                absolute(await selected.edit({ ...value, path: target.name }));
            return Reflect.get(source, key);
          },
        });
        const actual = createFileTools(adapter).find((tool) => tool.id === template.id)!;
        const result = await actual.execute(input, context);
        if (result.details && typeof result.details === 'object' && !Array.isArray(result.details))
          return {
            ...result,
            details: { ...result.details, fileScope: 'external_path', workspaceCheckpoint: false },
          };
        return result;
      } catch (error) {
        return {
          outcome: context.signal.aborted ? 'cancelled' : 'failed',
          content: error instanceof AgentError ? error.code : 'file_target_unavailable',
          details: { code: error instanceof AgentError ? error.code : 'file_target_unavailable' },
        };
      } finally {
        await files?.close();
      }
    },
  }));
  return {
    tools,
    snapshot: {
      namespace: 'builtin.files.path',
      version: '1',
      boundary,
      checkpointScope: 'excluded',
      tools: tools.map(({ id, version }) => ({ id, definitionVersion: version })),
    } as unknown as Json,
    describeRequest: (request: AuthorizationRequest) => describePathFileRequest(request, boundary),
  };
}
