import { pathToFileURL } from 'node:url';
import { type AgentClient, requiresInteractionAttachment } from '@kite-ai/client';
import {
  canonicalFileRecoveryIntent,
  type FileRecoveryIntent,
  type FileRecoveryLeg,
  isFileRecoveryIdentity,
  lookupFileRecoveryLeg,
  parseFileRecoveryIntent,
  planFileRecoveryIntent,
  prepareFileRecoveryLeg,
  submitFileRecoveryLeg,
} from '@kite-ai/client/file-recovery-intent';
import { createStdioInteractionHandler, type StdioInput } from '../src/stdio-interactions';
import type { openFileRecoveryJournal } from './file-recovery-intents';

export function createFileRecoveryPort(input: {
  client: AgentClient;
  journal: ReturnType<typeof openFileRecoveryJournal>;
}) {
  const { client, journal } = input;
  const identity = async (sessionId: string, signal?: AbortSignal) => {
    const view = await client.getView(sessionId, { signal });
    const info = client.serverInfo;
    if (
      !info?.storeId ||
      !info.subjectId ||
      view.storeId !== info.storeId ||
      view.session.id !== sessionId ||
      view.session.rootSessionId !== sessionId ||
      view.session.parentSessionId !== null ||
      view.session.deletedAt !== null
    )
      throw Error('file_recovery_scope_unavailable');
    return {
      storeId: info.storeId,
      sessionId,
      workspaceId: view.session.workspaceId,
      subjectId: info.subjectId,
      contextSelectionId: view.session.contextSelectionId,
    };
  };
  const persisted = async (raw: FileRecoveryIntent) => {
    const intent = await parseFileRecoveryIntent(raw),
      saved = (await journal.list()).find(
        (row) => canonicalFileRecoveryIntent(row) === canonicalFileRecoveryIntent(intent),
      );
    if (!saved) throw Error('file_recovery_original_intent_missing');
    return parseFileRecoveryIntent(saved);
  };
  const save = async (intent: FileRecoveryIntent) => {
    for (const leg of ['code', 'fork'] as const)
      if (intent[leg]) await journal.record(intent, leg, intent[leg]!.phase);
    return intent;
  };
  const proof = async (intent: FileRecoveryIntent, signal?: AbortSignal) => {
    if (!intent.code) throw Error('file_recovery_code_unavailable');
    return {
      command: await client.getCommand(intent.code.request.commandId, { signal }),
      restoreStatus: await client.getFileRestoreStatus(
        intent.sessionId,
        intent.checkpoint.id,
        (intent.code.request.input as { restoreId: string }).restoreId,
        { signal },
      ),
    };
  };
  const lookup = async (raw: FileRecoveryIntent, signal?: AbortSignal) => {
    let intent = await persisted(raw);
    const actual = await identity(intent.sessionId, signal);
    if (!isFileRecoveryIdentity(intent, actual)) return intent;
    const reads = {
      getCommand: (id: string) => client.getCommand(id, { signal }),
      getRestoreStatus: (s: string, p: string, r: string) =>
        client.getFileRestoreStatus(s, p, r, { signal }),
    };
    if (intent.code) intent = await lookupFileRecoveryLeg(intent, 'code', actual, reads);
    if (intent.fork && (intent.scope === 'session' || intent.fork.phase !== 'not_started'))
      intent = await lookupFileRecoveryLeg(intent, 'fork', actual, reads);
    return save(intent);
  };
  return {
    listPoints: async (sessionId: string, signal?: AbortSignal) => {
      const before = await identity(sessionId, signal);
      let page = await client.listFileCheckpoints(sessionId, { limit: 200, signal });
      const items = [...page.payload.items];
      while (page.payload.nextAfterKey !== null) {
        page = await client.listFileCheckpoints(sessionId, {
          limit: 200,
          afterKey: page.payload.nextAfterKey,
          signal,
        });
        items.push(...page.payload.items);
      }
      if (JSON.stringify(before) !== JSON.stringify(await identity(sessionId, signal)))
        throw Error('file_recovery_observation_changed');
      return { ...page, payload: { ...page.payload, items, nextAfterKey: null } };
    },
    readPoint: async (sessionId: string, pointId: string, signal?: AbortSignal) => {
      const actual = await identity(sessionId, signal),
        boundary = await client.getFileCheckpointRecoveryBoundary(sessionId, pointId, { signal }),
        preview = await client.getFileCheckpoint(sessionId, pointId, { signal });
      const after = await identity(sessionId, signal);
      if (
        JSON.stringify(actual) !== JSON.stringify(after) ||
        boundary.contextSelectionId !== actual.contextSelectionId ||
        boundary.workspaceId !== actual.workspaceId
      )
        throw Error('file_recovery_observation_changed');
      return { boundary, preview };
    },
    begin: async (
      sessionId: string,
      pointId: string,
      scope: FileRecoveryIntent['scope'],
      signal?: AbortSignal,
    ) => {
      const actual = await identity(sessionId, signal),
        boundary = await client.getFileCheckpointRecoveryBoundary(sessionId, pointId, { signal });
      if (scope !== 'session') {
        const preview = await client.getFileCheckpoint(sessionId, pointId, { signal });
        if (
          preview.payload.files.some(
            (file) => !['restore', 'remove', 'unchanged'].includes(file.status),
          )
        )
          throw Error('file_recovery_conflict');
      }
      if (
        JSON.stringify(actual) !== JSON.stringify(await identity(sessionId, signal)) ||
        boundary.contextSelectionId !== actual.contextSelectionId ||
        boundary.workspaceId !== actual.workspaceId
      )
        throw Error('file_recovery_observation_changed');
      signal?.throwIfAborted();
      const intent = await planFileRecoveryIntent({
        scope,
        observation: boundary,
        subjectId: actual.subjectId,
        ...(scope !== 'session'
          ? { code: { commandId: crypto.randomUUID(), restoreId: crypto.randomUUID() } }
          : {}),
        ...(scope !== 'code'
          ? {
              fork: {
                commandId: crypto.randomUUID(),
                newSessionId: crypto.randomUUID(),
                title: 'Restored conversation',
              },
            }
          : {}),
      });
      await journal.prepare(intent);
      signal?.throwIfAborted();
      return intent;
    },
    continue: async (raw: FileRecoveryIntent, signal?: AbortSignal) => {
      let intent = await persisted(raw);
      if (
        intent.code &&
        intent.code.phase !== 'not_started' &&
        intent.fork?.phase !== 'not_started'
      )
        return lookup(intent, signal);
      if (!intent.code && intent.fork?.phase !== 'not_started') return lookup(intent, signal);
      const actual = await identity(intent.sessionId, signal);
      if (!isFileRecoveryIdentity(intent, actual)) throw Error('file_recovery_readonly');
      const leg: FileRecoveryLeg =
        intent.code && intent.code.phase === 'not_started' ? 'code' : 'fork';
      const codeProof =
        leg === 'fork' && intent.scope === 'both' ? await proof(intent, signal) : undefined;
      const currentDetail =
        leg === 'fork' && intent.scope === 'both'
          ? await client.getFileCheckpoint(intent.sessionId, intent.checkpoint.id, { signal })
          : undefined;
      if (JSON.stringify(actual) !== JSON.stringify(await identity(intent.sessionId, signal)))
        throw Error('file_recovery_observation_changed');
      signal?.throwIfAborted();
      const prepared = prepareFileRecoveryLeg(intent, leg, actual, {
        explicitContinue: true,
        ...(codeProof ? { codeProof, currentDetail } : {}),
      });
      await save(prepared.intent);
      signal?.throwIfAborted();
      let submitScope = actual;
      const submitted = await submitFileRecoveryLeg(prepared.intent, leg, prepared.permit, {
        currentScope: () => submitScope,
        persist: async (next) => {
          await save(next);
          signal?.throwIfAborted();
          submitScope = await identity(intent.sessionId, signal);
          signal?.throwIfAborted();
        },
        post: (request) =>
          leg === 'code'
            ? client.invokeExtension(
                intent.sessionId,
                request as NonNullable<FileRecoveryIntent['code']>['request'],
                { signal },
              )
            : client.forkSession(
                intent.sessionId,
                request as NonNullable<FileRecoveryIntent['fork']>['request'],
                { signal },
              ),
      });
      intent = await save(submitted.intent);
      return lookup(intent, signal);
    },
    lookup,
    listSaved: () => journal.list(),
  };
}

export async function runSelectedFileRecovery(input: {
  arguments: import('../src/file-recovery').FileRecoveryCLIArguments;
  artifact?: import('./index').CLIServiceArtifact;
  resolveArtifact?: () => import('./index').CLIServiceArtifact;
  dataRoot: string;
  profile?: string;
  write(line: string): void;
  prompt?(line: string): void;
  stdin?: StdioInput;
  signal?: AbortSignal;
  exitSignal?: AbortSignal;
}): Promise<number> {
  const args = structuredClone(input.arguments);
  const original = args.input ? await parseFileRecoveryIntent(args.input) : undefined;
  if (original && original.sessionId !== args.sessionId)
    throw Error('file_recovery_scope_unavailable');
  const [
    { selectProfile },
    { acquireProfileAccess, acquireProfileDataLock },
    { launchPairedService },
    { parseCLIServiceArtifact, verifyArtifact },
    { openFileRecoveryJournal },
    { fileRecoveryExitCode },
  ] = await Promise.all([
    import('@kite-ai/agent/profile'),
    import('@kite-ai/agent/profile-access'),
    import('@kite-ai/service/paired'),
    import('./index'),
    import('./file-recovery-intents'),
    import('../src/file-recovery'),
  ]);
  const profile = selectProfile({
    dataRoot: args.dataRoot ?? input.dataRoot,
    profile: input.profile ?? 'default',
  });
  const signal = AbortSignal.any([
    ...(input.signal ? [input.signal] : []),
    ...(input.exitSignal ? [input.exitSignal] : []),
  ]);
  const connection = args.server
    ? await (await import('./shared-service')).connectSharedService({
        profile,
        server: args.server,
        requiredCapabilities: ['file_recovery', 'commands', 'extensions_actions', 'context'],
        signal,
      })
    : await (async () => {
        const artifact = parseCLIServiceArtifact(input.artifact ?? input.resolveArtifact?.());
        verifyArtifact(artifact.entrypoint, artifact.entrypointSha256, false);
        verifyArtifact(artifact.executable, artifact.executableSha256, true);
        return launchPairedService({
          profile,
          entrypoint: artifact.entrypoint,
          executable: artifact.executable,
          buildId: artifact.buildId,
          instanceId: crypto.randomUUID(),
          apiMajor: artifact.apiMajor,
          requiredCapabilities: ['file_recovery', 'commands', 'extensions_actions', 'context'],
        });
      })();
  let access: ReturnType<typeof acquireProfileAccess> | undefined;
  let journal: ReturnType<typeof openFileRecoveryJournal> | undefined;
  try {
    const view = await connection.client.getView(args.sessionId, { signal });
    if ('fixedWorkspace' in connection) {
      const workspace = (await connection.client.listAllWorkspaces({ signal })).find(
        (item) => item.id === view.session.workspaceId,
      );
      if (!workspace || workspace.rootUri !== pathToFileURL(connection.fixedWorkspace).href)
        throw Error('workspace_identity_mismatch');
    }
    access = acquireProfileAccess(profile);
    const owner = access;
    journal = openFileRecoveryJournal({
      access: owner,
      acquireWriteLock: () => acquireProfileDataLock(owner, 'tui_private'),
    });
    const port = createFileRecoveryPort({ client: connection.client, journal });
    if (args.action === 'checkpoints') {
      input.write(JSON.stringify(await port.listPoints(args.sessionId, signal)));
      return 0;
    }
    if (args.action === 'detail') {
      input.write(JSON.stringify(await port.readPoint(args.sessionId, args.pointId!, signal)));
      return 0;
    }
    if (args.action === 'intents') {
      input.write(
        JSON.stringify((await port.listSaved()).filter((row) => row.sessionId === args.sessionId)),
      );
      return 0;
    }
    let intent =
      args.action === 'restore'
        ? await port.begin(args.sessionId, args.pointId!, args.scope!, signal)
        : original!;
    input.write(JSON.stringify({ kind: 'files.intent', intent }));
    intent =
      args.action === 'lookup'
        ? await port.lookup(intent, signal)
        : await port.continue(intent, signal);
    if (
      args.action !== 'lookup' &&
      intent.code &&
      ['pending', 'unknown'].includes(intent.code.phase)
    ) {
      const interaction = createStdioInteractionHandler({
        input: input.stdin,
        write: input.prompt,
      });
      const answered = new Set<string>();
      const pause = () =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(done, 50);
          function done() {
            signal.removeEventListener('abort', stop);
            resolve();
          }
          function stop() {
            clearTimeout(timer);
            signal.removeEventListener('abort', stop);
            reject(signal.reason);
          }
          signal.addEventListener('abort', stop, { once: true });
        });
      try {
        for (;;) {
          signal.throwIfAborted();
          const command = await connection.client.getCommand(intent.code!.request.commandId, {
            signal,
          });
          if (command.status === 'rejected') break;
          const actionId =
            command.receipt &&
            typeof command.receipt === 'object' &&
            !Array.isArray(command.receipt)
              ? command.receipt.executionId
              : undefined;
          if (typeof actionId !== 'string') {
            if (command.status === 'accepted') {
              await pause();
              continue;
            }
            break;
          }
          const action = await connection.client.getExecution(actionId, { signal });
          if (action.sessionId !== intent.sessionId || action.originStoreId !== intent.storeId)
            break;
          if (['failed', 'cancelled', 'outcome_unknown'].includes(action.status)) break;
          let afterId: string | undefined;
          let unanswered = false;
          do {
            const page = await connection.client.listInteractions(
              intent.sessionId,
              {
                storeId: intent.storeId,
                state: 'pending',
                limit: 100,
                ...(afterId ? { afterId } : {}),
              },
              { signal },
            );
            for (const card of page.interactions) {
              if (card.sessionId !== intent.sessionId || card.originStoreId !== intent.storeId)
                continue;
              let executionId: string | null = card.executionId;
              const visited = new Set<string>();
              while (
                executionId &&
                executionId !== actionId &&
                visited.size < 64 &&
                !visited.has(executionId)
              ) {
                visited.add(executionId);
                const execution = await connection.client.getExecution(executionId, { signal });
                if (
                  execution.sessionId !== intent.sessionId ||
                  execution.originStoreId !== intent.storeId
                ) {
                  executionId = null;
                  break;
                }
                executionId = execution.parentExecutionId ?? null;
              }
              const key = `${card.id}:${card.revision}`;
              if (executionId !== actionId || answered.has(key)) continue;
              const attachment = requiresInteractionAttachment(card)
                ? await connection.client.readInteractionAttachment(card, { signal })
                : undefined;
              const answer = await interaction.answerInteraction(card, {
                signal,
                ...(attachment ? { completeAttachment: attachment } : {}),
              });
              if (!answer) {
                unanswered = true;
                break;
              }
              answered.add(key);
              const request = {
                expectedStoreId: card.originStoreId,
                commandId: crypto.randomUUID(),
                expectedRevision: card.revision,
                answer,
              };
              try {
                await connection.client.answerInteraction(
                  card.presentationSessionId,
                  card.id,
                  request,
                  { signal },
                );
              } catch {
                await connection.client.getCommand(request.commandId, { signal });
              }
            }
            afterId = page.nextAfterId ?? undefined;
          } while (afterId && !unanswered);
          intent = await port.lookup(intent, signal);
          const status = await connection.client.getFileRestoreStatus(
            intent.sessionId,
            intent.checkpoint.id,
            (intent.code!.request.input as { restoreId: string }).restoreId,
            { signal },
          );
          if (status.payload.execution?.status === 'outcome_unknown') break;
          if (unanswered || intent.code?.phase === 'succeeded' || intent.code?.phase === 'failed')
            break;
          await pause();
        }
      } finally {
        interaction.dispose();
      }
    }
    input.write(JSON.stringify({ kind: 'files.outcome', intent }));
    return fileRecoveryExitCode(intent);
  } finally {
    journal?.close();
    access?.lock.release();
    await connection.close();
  }
}
