import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError, type AgentRuntime } from '@kite-ai/agent';
import type { Json, PublicExecution } from '@kite-ai/agent/extensions';
import {
  createShellConfiguration,
  type ShellConfigurationOptions,
} from '@kite-ai/agent/permissions/shell';
import { planningSnapshotDigest } from './planning-configuration';

const object = (value: unknown): Record<string, Json> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : null;

/** Dynamic Planning evidence for this exact mixed-action tool; never a static whitelist. */
export async function readOnlyWorktreeBoundary(
  runtime: AgentRuntime | undefined,
  options: ShellConfigurationOptions | undefined,
  boundary: Readonly<PublicExecution>,
  input: Json,
): Promise<boolean> {
  if (!runtime || !options) return false;
  try {
    const execution = await runtime.getExecution(boundary.id);
    if (
      !execution ||
      execution.sessionId !== boundary.sessionId ||
      execution.originStoreId !== boundary.originStoreId ||
      execution.definitionVersion !== '1'
    )
      return false;
    const tool =
      execution.kind === 'tool'
        ? execution
        : execution.parentExecutionId
          ? await runtime.getExecution(execution.parentExecutionId)
          : null;
    if (
      tool?.kind !== 'tool' ||
      tool.definitionId !== 'git.worktree' ||
      tool.definitionVersion !== '1' ||
      tool.sessionId !== execution.sessionId ||
      tool.originStoreId !== execution.originStoreId ||
      !tool.runId
    )
      return false;
    const [run, session, metadata] = await Promise.all([
      runtime.getRun(tool.runId),
      runtime.getSession(tool.sessionId),
      runtime.getMetadata(),
    ]);
    if (
      !run ||
      !session ||
      run.sessionId !== tool.sessionId ||
      run.originStoreId !== metadata.storeId ||
      tool.originStoreId !== metadata.storeId
    )
      return false;
    const registration = object(run.configuration);
    if (
      !Array.isArray(registration?.extensions) ||
      !registration.extensions.some((entry) => {
        const value = object(entry);
        return value?.id === 'builtin.shell' && value.version === '1';
      }) ||
      !Array.isArray(registration.tools) ||
      !registration.tools.some((entry) => {
        const value = object(entry);
        return (
          value?.extensionId === 'builtin.shell' &&
          value.id === 'git.worktree' &&
          value.version === '1'
        );
      })
    )
      return false;
    let snapshot = object(registration.snapshot);
    if (typeof snapshot?.roleId === 'string' && typeof snapshot.roleVersion === 'string')
      snapshot = object(snapshot.configuration);
    const savedShell = object(snapshot?.shell),
      savedAssets = object(savedShell?.assets);
    const workspace = await runtime.getWorkspace(session.workspaceId);
    if (!workspace || !savedAssets?.gitWorktree) return false;
    const shell = await createShellConfiguration({
      workspaceRoot: fileURLToPath(workspace.rootUri),
      toolIds: ['git.worktree'],
      options,
    });
    const current = object(shell.snapshot),
      assets = object(current?.assets);
    if (
      !assets?.gitWorktree ||
      planningSnapshotDigest(assets.gitWorktree) !== planningSnapshotDigest(savedAssets.gitWorktree)
    )
      return false;
    // A canonical list Job must still originate from the exact list Tool.
    const parentCall = shell.worktreeRequest({
      kind: 'tool',
      definitionId: tool.definitionId,
      definitionVersion: tool.definitionVersion,
      executionId: tool.id,
      sessionId: tool.sessionId,
      runId: tool.runId,
      input: tool.input,
      signal: new AbortController().signal,
    });
    if (parentCall?.action !== 'list') return false;
    const request = {
      kind: execution.kind,
      definitionId: execution.definitionId,
      definitionVersion: execution.definitionVersion,
      executionId: execution.id,
      sessionId: execution.sessionId,
      runId: execution.runId,
      input,
      signal: new AbortController().signal,
    };
    const call = shell.worktreeRequest(request);
    return call?.action === 'list' && (await shell.describeRequest(request))?.safeRead === true;
  } catch {
    return false;
  }
}

/** Reads existing authority only. No worktree inventory or occupation lease is created. */
export function createWorktreeHost(readRuntime: () => AgentRuntime | undefined) {
  return {
    async readRegisteredWorkspaceRoots() {
      const runtime = readRuntime();
      if (!runtime) throw new AgentError('worktree_occupancy_unavailable');
      const { storeId } = await runtime.getMetadata();
      let afterSeq = '0';
      let upperSeq: string | undefined;
      let highWaterSeq: string | undefined;
      let snapshotCursor: string | undefined;
      const roots: string[] = [];
      const ids = new Set<string>();
      const sequence = (value: string) => {
        if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9223372036854775807n)
          throw new AgentError('worktree_occupancy_unavailable');
        return BigInt(value);
      };
      for (;;) {
        const page = await runtime.listWorkspaceDirectory({
          expectedStoreId: storeId,
          afterSeq,
          ...(upperSeq === undefined ? {} : { upperSeq }),
          limit: 200,
        });
        if (
          page.storeId !== storeId ||
          sequence(page.upperSeq) > sequence(page.highWaterSeq) ||
          sequence(afterSeq) > sequence(page.upperSeq) ||
          (upperSeq !== undefined && page.upperSeq !== upperSeq) ||
          (highWaterSeq !== undefined && page.highWaterSeq !== highWaterSeq) ||
          (snapshotCursor !== undefined && page.snapshotCursor !== snapshotCursor)
        )
          throw new AgentError('worktree_occupancy_unavailable');
        upperSeq = page.upperSeq;
        highWaterSeq = page.highWaterSeq;
        snapshotCursor = page.snapshotCursor;
        let lastSeq = afterSeq;
        for (const item of page.items) {
          if (
            sequence(item.seq) <= sequence(lastSeq) ||
            sequence(item.seq) > sequence(upperSeq) ||
            ids.has(item.workspace.id) ||
            ids.size >= 100000
          )
            throw new AgentError('worktree_occupancy_unavailable');
          const workspace = await runtime.getWorkspace(item.workspace.id);
          if (!workspace || workspace.rootUri !== item.workspace.rootUri)
            throw new AgentError('worktree_occupancy_unavailable');
          let path: string;
          try {
            const url = new URL(workspace.rootUri);
            if (url.protocol !== 'file:' || url.search || url.hash)
              throw new Error('invalid_workspace_root');
            path = fileURLToPath(url);
            if (!isAbsolute(path) || path.includes('\0')) throw new Error('invalid_workspace_root');
            // Workspace registration alone does not prove its current physical spelling.
            // Missing roots and aliases that cannot be resolved must fail deletion closed.
            path = await realpath(path);
          } catch {
            throw new AgentError('worktree_occupancy_unavailable');
          }
          roots.push(path);
          ids.add(workspace.id);
          lastSeq = item.seq;
        }
        if (page.nextAfterSeq === null) {
          // A final read detects registrations/removals during the getWorkspace reads.
          const check = await runtime.listWorkspaceDirectory({
            expectedStoreId: storeId,
            afterSeq: upperSeq,
            upperSeq,
            limit: 1,
          });
          if (
            check.storeId !== storeId ||
            check.upperSeq !== upperSeq ||
            check.highWaterSeq !== highWaterSeq ||
            check.snapshotCursor !== snapshotCursor ||
            check.items.length !== 0 ||
            check.nextAfterSeq !== null
          )
            throw new AgentError('worktree_occupancy_unavailable');
          return { originStoreId: storeId, complete: true as const, roots, snapshotCursor };
        }
        if (!page.items.length || page.nextAfterSeq !== lastSeq)
          throw new AgentError('worktree_occupancy_unavailable');
        afterSeq = lastSeq;
      }
    },
  };
}
