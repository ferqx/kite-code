import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AuthorizationRequest, ToolContext } from '../../extensions';
import { canonicalJson } from '../../json';
import type { CapabilityDescription } from '../../permissions';
import { dispatchScopeLeaves } from '../../permissions/dispatch-scope';
import type { InputFileImport } from '../../storage/input-file-imports';
import { AgentError, type Json } from '../../storage/types';
import { externalReadTarget } from '../external-file-reads';
import { createWorkspaceFiles } from '../files';
import { imageInputBytes } from './format';
import { imagePaths } from './input';
import { createViewImagesTool, type ImageSource } from './tool';

type Request = Pick<AuthorizationRequest, 'sessionId' | 'executionId' | 'signal'>;
export function createImageFileReads(options: {
  profilePath: string;
  workspaceRoot(request: Request): Promise<string>;
  protectedRoots(): readonly string[];
  readWorkspace(path: string, context: ToolContext, signal: AbortSignal): Promise<ImageSource>;
  resolveInput(request: Request, uri: string): Promise<InputFileImport | null>;
}) {
  const normalize = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
  const profile = normalize(resolve(options.profilePath));
  async function target(request: Request, input: Json) {
    const path = (input as { path?: string } | null)?.path;
    if (
      typeof path !== 'string' ||
      !path ||
      path.length > 4096 ||
      path.includes('\0') ||
      Buffer.from(path).toString('utf8') !== path
    )
      throw new AgentError('file_path_invalid');
    const absolute = normalize(resolve(path));
    if (isAbsolute(path) && (absolute === profile || absolute.startsWith(`${profile}${sep}`))) {
      if (resolve(path) !== path) throw new AgentError('file_path_invalid');
      const imported = await options.resolveInput(request, pathToFileURL(path).href);
      request.signal.throwIfAborted();
      if (imported?.state !== 'bound' || imported.uri !== pathToFileURL(path).href)
        throw new AgentError('input_file_scope_denied');
      return {
        kind: 'input' as const,
        path,
        imported,
        revision: `image-input:${createHash('sha256')
          .update(
            canonicalJson({
              path,
              sessionId: request.sessionId,
              importId: imported.id,
              reference: imported.reference,
            } as unknown as Json),
          )
          .digest('hex')}`,
      };
    }
    const workspace = await options.workspaceRoot(request);
    const external = await externalReadTarget(
      path,
      workspace,
      options.protectedRoots(),
      request.signal,
    );
    return external
      ? { kind: 'external' as const, ...external }
      : { kind: 'workspace' as const, path };
  }
  type Target = Awaited<ReturnType<typeof target>>;
  async function targets(request: Request, paths: readonly string[]) {
    const selected: Target[] = [];
    for (const path of paths) selected.push(await target(request, { path }));
    return selected;
  }
  function revision(selected: readonly Target[]) {
    return `image-read:${createHash('sha256')
      .update(
        canonicalJson(
          selected.map((item): Json => {
            if (item.kind === 'input')
              return { kind: item.kind, path: item.path, revision: item.revision };
            if (item.kind === 'external')
              return { kind: item.kind, path: item.path, actual: item.actual };
            return { kind: item.kind, path: item.path };
          }),
        ),
      )
      .digest('hex')}`;
  }
  const tool = createViewImagesTool({
    async prepare(paths, context) {
      // Preflight the complete batch once without retaining source bytes; a forbidden sibling denies it all.
      const all = await targets(context, paths);
      if (all.some((item) => item.kind === 'input')) {
        if (!context.dispatchAuthorization?.revision)
          throw new AgentError('file_dispatch_scope_unavailable');
        for (const leaf of dispatchScopeLeaves(
          context.dispatchAuthorization.snapshot,
          'file_dispatch_scope_unavailable',
        )) {
          const capability = (leaf.data as { capability?: Record<string, Json> }).capability;
          if (
            leaf.namespace !== 'builtin.permissions' ||
            capability?.kind !== 'tool' ||
            capability.definitionId !== 'files.view_images' ||
            capability.definitionVersion !== '1' ||
            capability.hardAllowed !== true ||
            capability.revision !== revision(all)
          )
            throw new AgentError('file_dispatch_scope_changed');
        }
      }
      return async (path, _context, signal) => {
        const request = { ...context, signal };
        const selected = all[paths.indexOf(path)]!;
        const before = await target(request, { path });
        if (revision([before]) !== revision([selected]))
          throw new AgentError('file_dispatch_scope_changed');
        if (selected.kind === 'workspace') return options.readWorkspace(path, context, signal);
        if (selected.kind === 'input') {
          const files = createWorkspaceFiles({ root: dirname(path), strictReads: true });
          try {
            const value = await files.readBytes(basename(path), {
              maxBytes: imageInputBytes,
              signal,
            });
            signal.throwIfAborted();
            if (
              value.baseline.hash !== selected.imported.reference.hash ||
              String(value.baseline.size) !== selected.imported.reference.size
            )
              throw new AgentError('artifact_content_mismatch');
            const current = await target(request, { path });
            if (current.kind !== 'input' || current.revision !== selected.revision)
              throw new AgentError('file_dispatch_scope_changed');
            return { path, bytes: value.bytes, hash: value.baseline.hash };
          } finally {
            await files.close();
          }
        }
        // Anchor the resolved parent and leaf through the existing native no-follow engine.
        // Ordinary external reads retain hard-link/shared-file support, unlike private recovery bytes.
        const files = createWorkspaceFiles({ root: dirname(selected.actual) });
        try {
          const value = await files.readBytes(basename(selected.actual), {
            maxBytes: imageInputBytes,
            signal,
            sharedRead: true,
          });
          const current = await target(request, { path });
          if (current.kind !== 'external' || current.actual !== selected.actual)
            throw new AgentError('file_changed');
          signal.throwIfAborted();
          return { path, bytes: value.bytes, hash: value.baseline.hash };
        } finally {
          await files.close();
        }
      };
    },
  });
  return {
    tool,
    async describeRequest(request: AuthorizationRequest): Promise<CapabilityDescription | null> {
      if (
        request.kind !== 'tool' ||
        request.definitionId !== tool.id ||
        request.definitionVersion !== tool.version
      )
        return null;
      const identity = {
        kind: request.kind,
        definitionId: request.definitionId,
        definitionVersion: request.definitionVersion,
      };
      try {
        const selected = await targets(request, imagePaths(request.input));
        return {
          ...identity,
          effects: ['read'],
          safeRead: true,
          hardAllowed: true,
          revision: revision(selected),
        };
      } catch (error) {
        request.signal.throwIfAborted();
        return {
          ...identity,
          effects: ['read'],
          safeRead: false,
          hardAllowed: false,
          revision: 'builtin.files:image-unavailable',
          denialReason: error instanceof AgentError ? error.code : 'image_read_failed',
        };
      }
    },
  };
}
