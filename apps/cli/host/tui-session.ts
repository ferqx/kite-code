import type { AgentClient, Interaction, SessionView } from '@kite-ai/client';
import {
  mergeTuiDomain,
  type TuiDomainState,
  type TuiPort,
  type TuiSnapshot,
  tuiReadDomains,
} from '@kite-ai/ui/tui';
import type { createTuiDisplayReader } from './tui-display';
import { readTuiPendingInputs } from './tui-display';
import type { createTuiHistoryReader } from './tui-history';
import type { createTuiJobTailReader } from './tui-job-tails';
import { readTuiLiveOutput } from './tui-live-output';
import { readTuiProgress } from './tui-progress';
import type { createTuiToolLabelsReader } from './tui-tool-labels';

/** Public read domains share identity checks, never business admission or writes. */
export function createTuiSessionReader(input: {
  client: AgentClient;
  storeId: string;
  workspaceId: string;
  environment: NonNullable<TuiSnapshot['environment']>;
  history: ReturnType<typeof createTuiHistoryReader>;
  display: ReturnType<typeof createTuiDisplayReader>;
  jobTails: ReturnType<typeof createTuiJobTailReader>;
  labels: () => ReturnType<typeof createTuiToolLabelsReader> | undefined;
}): Pick<TuiPort, 'readSession' | 'readSessionDomain' | 'messageChanges'> {
  const { client, storeId, workspaceId } = input;
  const readView = async (sessionId: string, signal: AbortSignal) => {
    const view = await client.getView(sessionId, { signal });
    if (
      view.storeId !== storeId ||
      view.session.id !== sessionId ||
      view.session.workspaceId !== workspaceId
    )
      throw Error('workspace_identity_mismatch');
    return view;
  };
  const execution = (view: SessionView) => ({
    view,
    connectionInstanceId: client.serverInfo!.instanceId,
    activityOwner:
      view.session.ownerInstanceId !== undefined && view.session.ownerGeneration !== undefined
        ? { instanceId: view.session.ownerInstanceId, generation: view.session.ownerGeneration }
        : undefined,
  });
  const readSessionDomain: NonNullable<TuiPort['readSessionDomain']> = async (
    domain,
    base,
    cursor,
    signal,
  ) => {
    const sessionId = base.view.session.id;
    signal.throwIfAborted();
    switch (domain) {
      case 'metadata': {
        const view = await readView(sessionId, signal);
        return { domain, sessionId, title: view.session.title };
      }
      case 'execution':
        return { domain, facts: execution(await readView(sessionId, signal)) };
      case 'history': {
        const result = await input.history.readAtCursor(
          sessionId,
          cursor ?? base.view.snapshotCursor,
          () => readView(sessionId, signal),
          signal,
        );
        return { domain, ...result };
      }
      case 'admission': {
        // The selected execution source fixes the target; the controller rejects a
        // changed target or relevant invalidation while this independent read runs.
        const source = base.view;
        const active = source.runs.find((run) => run.isActive);
        const [interactions, activeCommand, pendingInputs, mode] = await Promise.all([
          (async () => {
            const cards: Interaction[] = [];
            const cursors = new Set<string>();
            let afterId: string | undefined;
            for (;;) {
              const page = await client.listInteractions(
                sessionId,
                { storeId, limit: 100, ...(afterId ? { afterId } : {}) },
                { signal },
              );
              cards.push(...page.interactions);
              if (!page.nextAfterId) return cards;
              if (cursors.has(page.nextAfterId)) throw Error('interaction_cursor_invalid');
              cursors.add(page.nextAfterId);
              afterId = page.nextAfterId;
            }
          })(),
          active ? client.getCommand(active.originCommandId, { signal }) : undefined,
          readTuiPendingInputs(client, storeId, sessionId, signal),
          client.getPermissionMode(sessionId, { storeId, signal }),
        ]);
        if (
          (activeCommand &&
            (activeCommand.originStoreId !== storeId ||
              activeCommand.sessionId !== sessionId ||
              activeCommand.id !== active!.originCommandId)) ||
          mode.storeId !== storeId ||
          mode.sessionId !== sessionId
        )
          throw Error('active_command_identity_mismatch');
        return {
          domain,
          source,
          facts: { interactions, activeCommand, pendingInputs, pendingInputsUnavailable: false },
          permissionMode: mode.mode,
        };
      }
      case 'models': {
        const models = await client.getModelSettings('user', { storeId, signal });
        if (
          models.storeId !== storeId ||
          models.workspaceId !== undefined ||
          models.scope !== 'user'
        )
          throw Error('model_settings_identity_mismatch');
        const model = models.models.find((candidate) => candidate.id === models.defaultModelId);
        return {
          domain,
          environment: {
            modelId: model?.id,
            modelName: model?.model,
            effort: model?.reasoningEffort ?? undefined,
          },
        };
      }
      case 'display': {
        const display = await input.display(base.view, base.messages, signal);
        return {
          domain,
          facts: { executionTimings: display.executionTimings },
          environment: {
            runtimeModel: display.runtimeModel,
            context: display.context,
            nextContext: display.nextContext,
            usage: display.usage,
          },
        };
      }
      case 'progress': {
        const progress = await readTuiProgress(client, base.view, storeId, signal);
        return {
          domain,
          facts: { planProgress: progress.plan, compactionPhase: progress.compactionPhase },
        };
      }
      case 'live':
        return {
          domain,
          facts: { liveModelOutput: await readTuiLiveOutput(client, base.view, storeId, signal) },
        };
      case 'labels':
        return { domain, facts: { toolLabels: await input.labels()?.read(base.view, signal) } };
      case 'jobs': {
        const children = base.view.executions.filter(
          (item) =>
            item.kind === 'job' &&
            item.originStoreId === storeId &&
            item.sessionId === sessionId &&
            item.childSessionId !== null,
        );
        const [jobTails, childViews] = await Promise.all([
          input.jobTails.read(base.view, signal),
          Promise.all(
            children.map(async (carrier) => {
              const view = await readView(carrier.childSessionId!, signal);
              if (
                view.session.parentSessionId !== sessionId ||
                view.session.rootSessionId !== base.view.session.rootSessionId
              )
                throw Error('child_view_identity_mismatch');
              return { executionId: carrier.id, view };
            }),
          ),
        ]);
        return { domain, facts: { jobTails, childViews } };
      }
    }
  };
  return {
    messageChanges: client.serverInfo?.capabilities.includes('message_changes') === true,
    readSessionDomain,
    async readSession(sessionId, signal) {
      const view = await readView(sessionId, signal);
      let snapshot: TuiSnapshot = {
        storeId,
        ...execution(view),
        messages: await input.history.read(view, signal),
        interactions: [],
        environment: input.environment,
      };
      const domains = tuiReadDomains.filter(
        (domain) => domain !== 'execution' && domain !== 'history' && domain !== 'metadata',
      );
      const updates = await Promise.allSettled(
        domains.map((domain) => readSessionDomain(domain, snapshot, view.snapshotCursor, signal)),
      );
      const states: Record<string, TuiDomainState> = Object.fromEntries(
        tuiReadDomains.map((domain) => [domain, { phase: 'fresh', cursor: view.snapshotCursor }]),
      );
      for (const [index, result] of updates.entries()) {
        // Keep the verified history readable when a separate read fails.
        // Unavailable admission keeps the controller's write fence closed.
        if (result.status === 'rejected') {
          states[domains[index]!] = {
            phase: 'unavailable',
            error: result.reason instanceof Error ? result.reason.message : 'read_failed',
          };
        } else snapshot = mergeTuiDomain(snapshot, result.value);
      }
      return { ...snapshot, domains: states };
    },
  };
}
