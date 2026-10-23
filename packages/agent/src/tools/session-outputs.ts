import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type {
  AuthorizationRequest,
  Extension,
  Json,
  ReadContext,
  ToolDefinition,
} from '../extensions';
import { canonicalJson } from '../json';
import { privateDirectory } from '../maintenance/files';
import type { CapabilityDescription } from '../permissions';
import { dispatchScopeLeaves } from '../permissions/dispatch-scope';
import { AgentError } from '../storage/types';
import { createWorkspaceFiles, type FileSnapshot, type WorkspaceFiles } from './files';
import { createFileTools } from './files-tools';

const contentType = 'builtin.files.output';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
export interface SessionOutput {
  path: string;
  name: string;
  state: 'pending' | 'saved' | 'inherited';
  executionId: string;
  snapshot: Json;
}
export function sessionOutputDirectory(profilePath: string, storeId: string, sessionId: string) {
  return join(profilePath, 'files', digest(storeId), digest(sessionId), 'outputs');
}
const keyOf = (path: string) => `output/${digest(path)}`;
function decode(value: Json): SessionOutput {
  const output = value as unknown as SessionOutput;
  if (
    !output ||
    typeof output.path !== 'string' ||
    !/^files\/[a-f0-9]{64}\/[a-f0-9]{64}\/outputs\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(
      output.path,
    ) ||
    !namePattern.test(output.name) ||
    !['pending', 'saved', 'inherited'].includes(output.state)
  )
    throw new AgentError('output_file_invalid');
  return output;
}
/** Profile-managed text deliverables reuse the native file engine and the Files record namespace. */
export function withSessionOutputs(options: {
  profilePath: string;
  extension: Extension;
  scope(
    request: Pick<AuthorizationRequest, 'sessionId' | 'executionId' | 'signal'>,
    path: string,
  ): Promise<{ storeId: string; files: { key: string; revision: string; value: SessionOutput }[] }>;
  storeId(): Promise<string>;
  readInherited(
    request: Pick<AuthorizationRequest, 'sessionId' | 'executionId' | 'signal'>,
    key: string,
  ): Promise<Uint8Array>;
}): {
  extension: Extension;
  describeRequest(request: AuthorizationRequest): Promise<CapabilityDescription | null>;
} {
  const profile = resolve(options.profilePath);
  async function records(context: ReadContext, path?: string) {
    const result = [];
    let afterKey: string | undefined;
    for (;;) {
      const page = await context.records.list({
        contentType,
        limit: 200,
        ...(afterKey ? { afterKey } : {}),
      });
      for (const record of page) {
        if (!record.key.startsWith('output/') && !record.key.startsWith('output-inherited/'))
          continue;
        const value = decode(record.value);
        if (value.path.split('/')[2] !== digest(context.sessionId))
          throw new AgentError('output_file_scope_denied');
        if (path && join(profile, ...value.path.split('/')) !== path) continue;
        result.push({ key: record.key, revision: record.revision, value });
      }
      if (page.length < 200) {
        const selected = new Map<string, (typeof result)[number]>();
        for (const row of result)
          if (!selected.has(row.value.path) || row.key.startsWith('output/'))
            selected.set(row.value.path, row);
        return [...selected.values()];
      }
      afterKey = page.at(-1)!.key;
    }
  }
  async function target(
    request: Pick<AuthorizationRequest, 'sessionId' | 'executionId' | 'signal'>,
    input: Json,
    write: boolean,
  ) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      typeof input.path !== 'string' ||
      !isAbsolute(input.path)
    )
      return null;
    const path = input.path;
    const normalized = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
    if (
      !normalized(path).startsWith(`${normalized(profile)}${sep}files${sep}`) ||
      !path.includes(`${sep}outputs${sep}`)
    )
      return null;
    const scope = await options.scope(request, path);
    const ownRoot = sessionOutputDirectory(profile, scope.storeId, request.sessionId);
    const prior = scope.files.find((file) => join(profile, ...file.value.path.split('/')) === path);
    if (
      resolve(path) !== path ||
      !namePattern.test(basename(path)) ||
      (!prior && (!write || dirname(path) !== ownRoot))
    )
      throw new AgentError('output_file_scope_denied');
    const relative =
      prior?.value.path ??
      `files/${digest(scope.storeId)}/${digest(request.sessionId)}/outputs/${basename(path)}`;
    let probe = path;
    while (!existsSync(dirname(probe))) probe = dirname(probe);
    const anchor = createWorkspaceFiles({ root: dirname(probe), strictReads: true });
    let identity: Awaited<ReturnType<WorkspaceFiles['inspectIdentity']>>;
    try {
      identity = await anchor.inspectIdentity(basename(probe));
    } finally {
      await anchor.close();
    }
    const revision = `session-output:1:${digest(canonicalJson({ storeId: scope.storeId, sessionId: request.sessionId, path, input, recordRevision: prior?.revision ?? null, probe, identity } as unknown as Json))}`;
    return { path, relative, prior, revision, probe, identity };
  }
  const tools = (options.extension.tools ?? []).map(
    (tool): ToolDefinition =>
      !['files.read', 'files.write', 'files.edit'].includes(tool.id)
        ? tool
        : {
            ...tool,
            description: `${tool.description} Session output paths provided by the host are persistent editable deliverables; use a new filename with base=null to create one.`,
            async execute(input, context) {
              let files: WorkspaceFiles | undefined;
              try {
                const selected = await target(context, input, tool.id === 'files.write');
                if (!selected) return tool.execute(input, context);
                if (!context.dispatchAuthorization?.revision)
                  throw new AgentError('file_dispatch_scope_unavailable');
                for (const leaf of dispatchScopeLeaves(
                  context.dispatchAuthorization.snapshot,
                  'file_dispatch_scope_unavailable',
                )) {
                  const capability = leaf.data.capability as Record<string, Json> | undefined;
                  if (
                    leaf.namespace !== 'builtin.permissions' ||
                    !capability ||
                    capability.kind !== 'tool' ||
                    capability.definitionId !== tool.id ||
                    capability.definitionVersion !== tool.version ||
                    capability.hardAllowed !== true ||
                    capability.revision !== selected.revision
                  )
                    throw new AgentError('file_dispatch_scope_changed');
                }
                const key = keyOf(selected.relative);
                const prior = await context.records.get(key);
                if (
                  (prior?.revision ?? null) !==
                  (selected.prior?.key === key ? selected.prior.revision : null)
                )
                  throw new AgentError('file_dispatch_scope_changed');
                const inherited = selected.prior?.value.state === 'inherited';
                if (tool.id !== 'files.read' || inherited) {
                  if (!context.artifacts) throw new AgentError('artifact_publication_unavailable');
                  privateDirectory(dirname(selected.path), true);
                }
                files = createWorkspaceFiles({ root: dirname(selected.path), strictReads: true });
                const native = files,
                  name = basename(selected.path);
                if (
                  selected.probe === selected.path &&
                  canonicalJson((await native.inspectIdentity(name)) as unknown as Json) !==
                    canonicalJson(selected.identity as unknown as Json)
                )
                  throw new AgentError('file_dispatch_scope_changed');
                if (inherited && !(await native.inspectIdentity(name)).file) {
                  const bytes = await options.readInherited(context, selected.prior!.key);
                  context.signal.throwIfAborted();
                  await native.restore({
                    path: name,
                    bytes,
                    base: null,
                    maxBytes: 256 * 1024 * 1024,
                  });
                }
                let snapshot: import('../extensions').ArtifactRef | undefined;
                const capture =
                  tool.id === 'files.read'
                    ? undefined
                    : {
                        async before() {
                          const value: SessionOutput = {
                            path: selected.relative,
                            name,
                            state: 'pending',
                            executionId: context.executionId,
                            snapshot: selected.prior?.value.snapshot ?? null,
                          };
                          const record = await context.records.write({
                            key,
                            expectedRevision: prior?.revision ?? null,
                            contentType,
                            contentVersion: 1,
                            value: value as unknown as Json,
                            executable: true,
                          });
                          await context.records.write({
                            key: `output-operation/${context.executionId}`,
                            expectedRevision: null,
                            contentType,
                            contentVersion: 1,
                            value: value as unknown as Json,
                            executable: true,
                          });
                          return record;
                        },
                        async after(token: unknown, result: FileSnapshot) {
                          snapshot = await context.artifacts!.publish({
                            key: 'output-file-version',
                            content: Buffer.from(result.content),
                            mediaType: 'text/plain',
                          });
                          const value: SessionOutput = {
                            path: selected.relative,
                            name,
                            state: 'saved',
                            executionId: context.executionId,
                            snapshot: snapshot as unknown as Json,
                          };
                          await context.records.write({
                            key,
                            expectedRevision: (token as { revision: string }).revision,
                            contentType,
                            contentVersion: 1,
                            value: value as unknown as Json,
                            executable: true,
                          });
                          const operation = await context.records.get(
                            `output-operation/${context.executionId}`,
                          );
                          await context.records.write({
                            key: operation!.key,
                            expectedRevision: operation!.revision,
                            contentType,
                            contentVersion: 1,
                            value: value as unknown as Json,
                            executable: true,
                          });
                        },
                        async failed() {
                          /* Preserve the actual pending operation; a new edit requires a fresh native baseline. */
                        },
                      };
                const absolute = (value: FileSnapshot) => ({
                  ...value,
                  path: selected.path,
                  ...(value.change ? { change: { ...value.change, path: selected.path } } : {}),
                });
                const adapter = new Proxy(native, {
                  get(_source, property) {
                    if (property === 'relativePath')
                      return (path: string) => {
                        if (path !== selected.path) throw new AgentError('file_path_invalid');
                        return name;
                      };
                    if (property === 'read')
                      return async (_path: string, args: Parameters<WorkspaceFiles['read']>[1]) =>
                        absolute(await native.read(name, { ...args, signal: context.signal }));
                    if (property === 'write')
                      return async (value: Parameters<WorkspaceFiles['write']>[0]) =>
                        absolute(await native.write({ ...value, path: name }));
                    if (property === 'edit')
                      return async (value: Parameters<WorkspaceFiles['edit']>[0]) =>
                        absolute(await native.edit({ ...value, path: name }));
                    throw new AgentError('output_file_operation_unavailable');
                  },
                });
                const result = await createFileTools(adapter, { capture, snapshot: false })
                  .find((definition) => definition.id === tool.id)!
                  .execute(input, context);
                if (!snapshot || result.outcome !== 'succeeded') return result;
                return {
                  ...result,
                  artifactRefs: [...(result.artifactRefs ?? []), snapshot],
                  details: {
                    ...((result.details as Record<string, Json>) ?? {}),
                    fileOutput: {
                      path: selected.path,
                      name,
                      snapshot: snapshot as unknown as Json,
                    },
                    workspaceCheckpoint: false,
                  },
                };
              } catch (error) {
                return {
                  outcome: context.signal.aborted ? 'cancelled' : 'failed',
                  content: error instanceof Error ? error.message : 'output_file_unavailable',
                };
              } finally {
                await files?.close();
              }
            },
          },
  );
  return {
    async describeRequest(request: AuthorizationRequest): Promise<CapabilityDescription | null> {
      if (
        request.kind !== 'tool' ||
        !['files.read', 'files.write', 'files.edit'].includes(request.definitionId)
      )
        return null;
      const selected = await target(request, request.input, request.definitionId === 'files.write');
      if (!selected) return null;
      const read = request.definitionId === 'files.read';
      return {
        kind: request.kind,
        definitionId: request.definitionId,
        definitionVersion: request.definitionVersion,
        revision: selected.revision,
        hardAllowed: true,
        safeRead: read,
        effects: [read ? 'read' : 'external'],
      };
    },
    extension: {
      ...options.extension,
      tools,
      records: [
        ...(options.extension.records ?? []),
        {
          contentType,
          contentVersion: 1,
          fork: {
            mode: 'rebuild',
            version: '1',
            sourceReads: 'declared',
            onUnsupported: 'reject',
            async prepare(input) {
              const selected = new Map<
                string,
                { record: (typeof input.records)[number]; inherited: boolean }
              >();
              // Inherited anchors predate new branch messages; only selected original
              // execution results may replace them. A mutable head is never copied.
              for (const record of input.records)
                if (
                  record.key.startsWith('output-inherited/') &&
                  decode(record.value).state === 'inherited'
                )
                  selected.set(decode(record.value).name, { record, inherited: true });
              for (const message of input.selectedMessages)
                for (const executionId of message.sourceIds) {
                  const record = input.records.find(
                    (row) => row.key === `output-operation/${executionId}`,
                  );
                  if (record && decode(record.value).state === 'saved')
                    selected.set(decode(record.value).name, { record, inherited: false });
                }
              return [...selected.values()].flatMap(({ record, inherited }) => {
                const value = decode(record.value);
                const path = value.path.replace(
                  `/${digest(input.sourceSessionId)}/outputs/`,
                  `/${digest(input.targetSessionId)}/outputs/`,
                );
                if (path === value.path) throw new AgentError('output_file_scope_denied');
                const reference = value.snapshot as unknown as import('../extensions').ArtifactRef;
                if (
                  reference.scope?.kind !== 'execution' ||
                  reference.scope.id !== value.executionId
                )
                  throw new AgentError('output_file_source_unavailable');
                const output = {
                  key: keyOf(path),
                  contentType,
                  contentVersion: 1,
                  value: { ...value, path, state: 'inherited' } as unknown as Json,
                  readonlySources: [
                    inherited
                      ? {
                          kind: 'inherited' as const,
                          anchorKey: record.key,
                          executionId: value.executionId,
                          artifactRefIds: [reference.id],
                        }
                      : {
                          kind: 'execution' as const,
                          executionKind: 'tool' as const,
                          executionId: value.executionId,
                          artifactRefIds: [reference.id],
                        },
                  ],
                };
                return [{ ...output, key: `output-inherited/${digest(path)}` }];
              });
            },
          },
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'name', 'state', 'executionId', 'snapshot'],
            properties: {
              path: { type: 'string' },
              name: { type: 'string' },
              state: { enum: ['pending', 'saved', 'inherited'] },
              executionId: { type: 'string' },
              snapshot: { type: ['object', 'null'] },
            },
          },
        },
      ],
      queries: [
        ...(options.extension.queries ?? []),
        {
          id: 'files.output-source',
          version: '1',
          description: 'Resolve the sealed read-only Fork output source',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['key'],
            properties: { key: { type: 'string' } },
          },
          outputSchema: { type: 'array', items: { type: 'object' } },
          async execute(input: Json, context: ReadContext) {
            const key = (input as { key: string }).key;
            if (!key.startsWith('output-inherited/'))
              throw new AgentError('output_file_scope_denied');
            const record = await context.records.get(key);
            if (!record || decode(record.value).state !== 'inherited')
              throw new AgentError('output_file_source_unavailable');
            const value = decode(record.value);
            const projection = await context.openForkSourceProjection?.(key);
            const execution = await projection?.getExecution(value.executionId);
            const reference = value.snapshot as unknown as import('../extensions').ArtifactRef;
            if (
              !execution ||
              !projection?.sources.some(
                (source) =>
                  source.executionId === execution.id &&
                  source.artifactRefs.some(
                    (ref) =>
                      ref.id === reference.id &&
                      ref.mediaType === reference.mediaType &&
                      ref.size === reference.size &&
                      canonicalJson(ref.scope as unknown as Json) ===
                        canonicalJson(reference.scope as unknown as Json),
                  ),
              )
            )
              throw new AgentError('output_file_source_unavailable');
            return [
              {
                extensionId: options.extension.id,
                contentType,
                contentVersion: 1,
                summary: value.name,
                payload: {
                  revision: record.revision,
                  executionId: execution.id,
                  sessionId: execution.sessionId,
                  reference: reference as unknown as Json,
                },
                artifactRefs: [reference],
                actions: [],
              },
            ];
          },
        },
        {
          id: 'files.outputs',
          version: '1',
          description:
            'Read registered editable output files; pass an exact path to resolve any current file',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: { path: { type: 'string' } },
          },
          outputSchema: { type: 'array', items: { type: 'object' } },
          async execute(input: Json, context: ReadContext) {
            const rows = await records(context, (input as { path?: string }).path);
            return [
              {
                extensionId: options.extension.id,
                contentType,
                contentVersion: 1,
                summary:
                  rows.length > 200
                    ? 'First 200 output files; resolve further files by exact path'
                    : 'Session output files',
                payload: rows.slice(0, 200).map((record) => ({
                  ...record,
                  path: join(profile, ...record.value.path.split('/')),
                })) as unknown as Json,
                artifactRefs: [],
                actions: [],
              },
            ];
          },
        },
      ],
      context: {
        async capture(request, context) {
          const rows = await records(context);
          const content = canonicalJson({
            kind: 'session_files',
            outputDirectory: sessionOutputDirectory(
              profile,
              await options.storeId(),
              context.sessionId,
            ),
            complete: rows.length <= 200,
            files: rows.slice(0, 200).map((record) => ({
              path: join(profile, ...record.value.path.split('/')),
              state: record.value.state,
            })),
          });
          return [
            ...((await options.extension.context?.capture(request, context)) ?? []),
            {
              id: `${options.extension.id}:session-files:${context.sessionId}`,
              kind: 'session_files',
              scope: context.sessionId,
              role: 'user' as const,
              placement: 'after_history' as const,
              digest: digest(content),
              content,
            },
          ];
        },
      },
    } satisfies Extension,
  };
}
